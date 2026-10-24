#include "bootloader_random.h"
#include "cp_runtime.h"
#include "cp_settings.h"
#include "esp_random.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include <stdio.h>
#include <string.h>

typedef enum { CMD_MODE, CMD_CANDIDATE, CMD_RESUME } command_kind_t;
typedef struct {
    command_kind_t kind;
    cp_provision_mode_t mode;
    cp_settings_t candidate;
    char attempt[37];
} command_t;
static cp_core_t s_core;
static cp_runtime_snapshot_t s_view;
static cp_settings_t s_settings;
static char s_node[16], s_boot[37], s_proof[33];
static SemaphoreHandle_t s_lock;
static QueueHandle_t s_commands;
static TaskHandle_t s_task;
static bool s_prepared, s_enrolled, s_testing;
static bool s_candidate_pending;
static uint64_t s_policy_response_seen;
static uint64_t s_policy_attempted_sequence;
static char s_reason[80];
static uint64_t now_ms(void) { return (uint64_t)esp_timer_get_time() / 1000; }
static void boot_uuid(void) {
    uint8_t b[16];
    bootloader_random_enable();
    esp_fill_random(b, sizeof b);
    bootloader_random_disable();
    b[6] = (b[6] & 15) | 64;
    b[8] = (b[8] & 63) | 128;
    snprintf(s_boot, sizeof s_boot,
             "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x", b[0], b[1],
             b[2], b[3], b[4], b[5], b[6], b[7], b[8], b[9], b[10], b[11], b[12], b[13], b[14],
             b[15]);
}
static void reason(const char *text) { snprintf(s_reason, sizeof s_reason, "%s", text); }
static esp_err_t submit(const cp_settings_t *candidate, const char *attempt, void *context) {
    (void)context;
    if (!candidate || !attempt || strlen(attempt) >= 37 || strcmp(candidate->node_id, s_node) ||
        !cp_settings_validate(candidate))
        return ESP_ERR_INVALID_ARG;
    bool available = false;
    if (!__atomic_compare_exchange_n(&s_candidate_pending, &available, true, false,
                                      __ATOMIC_ACQ_REL, __ATOMIC_ACQUIRE))
        return ESP_ERR_INVALID_STATE;
    command_t cmd = {.kind = CMD_CANDIDATE, .candidate = *candidate};
    strcpy(cmd.attempt, attempt);
    esp_err_t result = xQueueSend(s_commands, &cmd, 0) == pdTRUE ? ESP_OK : ESP_ERR_NO_MEM;
    cp_settings_clear_sensitive(&cmd.candidate);
    if (result != ESP_OK)
        __atomic_store_n(&s_candidate_pending, false, __ATOMIC_RELEASE);
    return result;
}
static void publish(void) {
    cp_runtime_snapshot_t view = {0};
    cp_network_snapshot(&view.network);
    cp_pipeline_snapshot(&view.pipeline);
    cp_provision_snapshot(&view.provision);
    view.enrolled = s_enrolled;
    view.testing_candidate = s_testing;
    view.prepared = s_prepared;
    view.collection = cp_core_decide(&s_core, now_ms());
    snprintf(view.reason, sizeof view.reason, "%s", s_reason);
    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) == pdTRUE) {
        s_view = view;
        xSemaphoreGive(s_lock);
    }
}
static void enter_setup(cp_provision_mode_t mode) {
    cp_core_set_setup_active(&s_core, true);
    if (cp_pipeline_stop() != ESP_OK || cp_network_stop() != ESP_OK) {
        reason("previous_owner_stop_failed");
        publish();
        return;
    }
    if (cp_provision_stop() != ESP_OK) {
        reason("provision_stop_failed");
        publish();
        return;
    }
    esp_err_t err = cp_provision_start(mode, s_node, s_proof, submit, NULL);
    reason(err == ESP_OK ? "setup_ready" : "setup_start_failed");
    cp_network_set_capture_state("paused");
    publish();
}
static void test_candidate(command_t *cmd) {
    cp_provision_snapshot_t previous;
    cp_provision_snapshot(&previous);
    s_testing = true;
    reason("testing_wifi_and_cloud");
    publish();
    cp_provision_set_status("testing", "wifi_and_cloud");
    /* The GATT/HTTP task must have time to finish its received response. It did
     * not promise persistence. Subsequent confirmation is cloud/device status. */
    vTaskDelay(pdMS_TO_TICKS(1200));
    esp_err_t err = cp_provision_stop();
    if (err == ESP_OK)
        err = cp_network_validate_candidate(&cmd->candidate, 45000);
    if (err == ESP_OK)
        err = cp_settings_save(&cmd->candidate);
    if (err == ESP_OK) {
        s_settings = cmd->candidate;
        s_enrolled = true;
        s_testing = false;
        reason("stored_restarting");
        cp_provision_set_status("saved", "stored_restarting");
        publish();
        cp_settings_clear_sensitive(&cmd->candidate);
        vTaskDelay(pdMS_TO_TICKS(1500));
        esp_restart();
    } else {
        cp_settings_clear_sensitive(&cmd->candidate);
        s_testing = false;
        reason("candidate_failed_previous_preserved");
        /* Retained previous enrollment stays intact; reopening setup is explicit
         * and carries a visible failed status rather than fake success. */
        enter_setup(previous.mode);
        cp_provision_set_status("failed", "network_or_auth_failed");
        publish();
    }
}
static void apply_control(void) {
    cp_network_snapshot_t net;
    cp_network_snapshot(&net);
    cp_core_set_network(&s_core, net.network);
    cp_core_set_auth(&s_core, net.auth);
    cp_core_set_clock_trusted(&s_core, net.clock_trusted);
    if (net.policy_response_sequence > s_policy_response_seen) {
        s_policy_response_seen = net.policy_response_sequence;
        if (!net.policy_valid) {
            (void)cp_pipeline_stop();
            if (net.policy_rejected || net.policy_expired) {
                cp_core_mark_apply_failed(&s_core);
                if (net.policy_rejected && net.desired_config_id[0])
                    (void)cp_network_report_activation(net.desired_config_id, false,
                                                       "unsupported_policy");
            } else
                cp_core_clear_policy(&s_core);
        }
    }
    cp_network_policy_t p;
    if (cp_network_get_policy(&p) && p.request_sequence > s_policy_attempted_sequence) {
        s_policy_attempted_sequence = p.request_sequence;
        uint64_t current = now_ms();
        uint64_t age = current >= p.fetched_mono_ms ? current - p.fetched_mono_ms : UINT64_MAX;
        cp_policy_result_t result =
            age < p.lease_ms ? cp_core_receive_desired(&s_core, &p.core, p.request_sequence,
                                                       current, p.lease_ms - age)
                             : CP_POLICY_STALE;
        if (result != CP_POLICY_OK) {
            (void)cp_pipeline_stop();
            cp_core_mark_apply_failed(&s_core);
            (void)cp_network_report_activation(p.core.config_id, false, "unsupported_policy");
        } else if (s_core.policy_state != CP_POLICY_APPLIED) {
            cp_core_set_setup_active(&s_core, false);
            esp_err_t err = cp_pipeline_apply(&p);
            if (err == ESP_OK && cp_core_mark_applied(&s_core, p.core.config_id)) {
                (void)cp_network_report_activation(p.core.config_id, true, "applied");
                reason("policy_applied");
            } else {
                cp_core_mark_apply_failed(&s_core);
                (void)cp_network_report_activation(p.core.config_id, false, "capture_start_failed");
                reason("capture_start_failed");
            }
        } else
            cp_pipeline_renew_lease(p.fetched_mono_ms + p.lease_ms);
    }
    cp_collection_state_t state = cp_core_decide(&s_core, now_ms());
    cp_pipeline_snapshot_t pipe;
    cp_pipeline_snapshot(&pipe);
    if (!cp_collection_allowed(state) && pipe.collecting)
        (void)cp_pipeline_stop();
    if (cp_collection_allowed(state) && !pipe.collecting && pipe.storage_ready &&
        cp_network_get_policy(&p) &&
        (!pipe.pressure_paused ||
         pipe.free_slots * 100u >= pipe.capacity_slots * (100u - p.resume_pct))) {
        if (cp_pipeline_apply(&p) != ESP_OK)
            reason("capture_recovery_failed");
    }
    cp_pipeline_snapshot(&pipe);
    cp_network_set_capture_state(cp_collection_allowed(state) && pipe.collecting ? "running"
                                 : state == CP_COLLECTION_LEASE_EXPIRED          ? "expired"
                                 : state == CP_COLLECTION_WAIT_POLICY            ? "unassigned"
                                 : state == CP_COLLECTION_POLICY_FAILED          ? "failed"
                                                                                 : "paused");
}
static void runtime_task(void *arg) {
    (void)arg;
    if (s_enrolled) {
        cp_core_set_setup_active(&s_core, false);
        cp_core_set_identity(&s_core, CP_IDENTITY_ENROLLED);
        if (cp_network_start(&s_settings) != ESP_OK)
            reason("network_start_failed");
    } else if (s_core.profile->capabilities & CP_CAP_DISPLAY) {
        enter_setup(CP_PROVISION_BLE);
    } else {
        /* A headless boot cannot present the wireless setup PIN. USB remains
         * available, but only an explicit begin command opens its session. */
        cp_core_set_setup_active(&s_core, true);
        reason("awaiting_usb_setup");
        publish();
    }
    for (;;) {
        command_t cmd;
        if (xQueueReceive(s_commands, &cmd, pdMS_TO_TICKS(500)) == pdTRUE) {
            if (cmd.kind == CMD_CANDIDATE) {
                test_candidate(&cmd);
                __atomic_store_n(&s_candidate_pending, false, __ATOMIC_RELEASE);
            } else if (cmd.kind == CMD_RESUME && s_enrolled) {
                if (cp_provision_stop() == ESP_OK) {
                    cp_core_set_setup_active(&s_core, false);
                    cp_core_set_identity(&s_core, CP_IDENTITY_ENROLLED);
                    (void)cp_network_start(&s_settings);
                    reason("resuming_saved_network");
                } else
                    reason("provision_stop_failed");
            } else if (cmd.kind == CMD_MODE)
                enter_setup(cmd.mode);
            cp_settings_clear_sensitive(&cmd.candidate);
        }
        cp_provision_snapshot_t provision;
        cp_provision_snapshot(&provision);
        if (s_enrolled && !provision.active && !s_testing && !s_core.setup_active)
            apply_control();
        publish();
    }
}
esp_err_t cp_runtime_prepare(const char *node, const cp_board_profile_t *profile) {
    if (s_prepared)
        return ESP_OK;
    if (!node || strlen(node) >= sizeof s_node || !cp_board_profile_valid(profile))
        return ESP_ERR_INVALID_ARG;
    strcpy(s_node, node);
    cp_core_init(&s_core, profile);
    cp_core_set_identity(&s_core, CP_IDENTITY_FACTORY);
    s_lock = xSemaphoreCreateMutex();
    s_commands = xQueueCreate(2, sizeof(command_t));
    if (!s_lock || !s_commands)
        return ESP_ERR_NO_MEM;
    esp_err_t err = cp_settings_init();
    if (err != ESP_OK) {
        reason("settings_store_failed");
        return err;
    }
    boot_uuid();
    err = cp_settings_setup_proof(s_proof);
    if (err != ESP_OK) {
        reason("setup_proof_failed");
        return err;
    }
    err = cp_settings_load(&s_settings);
    s_enrolled = err == ESP_OK && !strcmp(s_settings.node_id, s_node);
    if (err != ESP_OK && err != ESP_ERR_NOT_FOUND) {
        reason("settings_recovery_failed");
        return err;
    }
    err = cp_network_init(s_node, s_boot);
    if (err != ESP_OK)
        return err;
    esp_err_t storage = cp_pipeline_init(s_node, s_boot);
    reason(storage == ESP_OK ? "boot_ready" : "journal_unavailable");
    s_prepared = true;
    publish();
    return ESP_OK;
}
esp_err_t cp_runtime_start(void) {
    if (!s_prepared)
        return ESP_ERR_INVALID_STATE;
    if (s_task)
        return ESP_OK;
    return xTaskCreate(runtime_task, "cp_control", 12288, NULL, 4, &s_task) == pdPASS
               ? ESP_OK
               : ESP_ERR_NO_MEM;
}
bool cp_runtime_request_setup(cp_provision_mode_t mode) {
    if (!s_prepared || __atomic_load_n(&s_candidate_pending, __ATOMIC_ACQUIRE) ||
        (mode != CP_PROVISION_BLE && mode != CP_PROVISION_SOFTAP && mode != CP_PROVISION_USB))
        return false;
    command_t cmd = {.kind = CMD_MODE, .mode = mode};
    return xQueueSend(s_commands, &cmd, 0) == pdTRUE;
}
bool cp_runtime_request_resume(void) {
    if (!s_prepared || !s_enrolled || __atomic_load_n(&s_candidate_pending, __ATOMIC_ACQUIRE))
        return false;
    command_t cmd = {.kind = CMD_RESUME};
    return xQueueSend(s_commands, &cmd, 0) == pdTRUE;
}
void cp_runtime_snapshot(cp_runtime_snapshot_t *out) {
    if (!out)
        return;
    memset(out, 0, sizeof *out);
    if (s_lock && xSemaphoreTake(s_lock, pdMS_TO_TICKS(10)) == pdTRUE) {
        *out = s_view;
        xSemaphoreGive(s_lock);
    }
}
