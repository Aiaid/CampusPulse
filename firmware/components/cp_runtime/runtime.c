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
static portMUX_TYPE s_settings_lock=portMUX_INITIALIZER_UNLOCKED;
static uint32_t s_saved_generation;
static cp_network_attempt_t s_previous_attempt;
static bool s_have_previous_attempt;
static esp_err_t s_history_error;
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
static bool resolve_saved_credential(const char *node,char *out,size_t capacity,uint32_t *generation,void *context) {
    (void)context;
    if(!node || strcmp(node,s_node) || (out&&capacity<CP_SETTINGS_TOKEN_SIZE))return false;
    portENTER_CRITICAL(&s_settings_lock);
    bool available=s_enrolled&&s_saved_generation>0;
    if(available){if(out)memcpy(out,s_settings.device_token,CP_SETTINGS_TOKEN_SIZE);if(generation)*generation=s_saved_generation;}
    portEXIT_CRITICAL(&s_settings_lock);return available;
}
static void save_attempt_record(const char *attempt,cp_attempt_state_t state,const cp_network_diagnostic_t *diagnostic) {
    cp_network_attempt_t record={.version=1,.state=state,.diagnostic=*diagnostic};
    memcpy(record.attempt_id,attempt,37);memcpy(record.boot_id,s_boot,37);
    s_history_error=cp_network_attempt_save(&record);
    cp_provision_set_previous_attempt(s_have_previous_attempt?&s_previous_attempt:NULL,s_history_error);
}
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
    cp_pipeline_snapshot_t pipe;
    cp_pipeline_snapshot(&pipe);
    if (mode == CP_PROVISION_BLE && pipe.radio_restart_required) {
        reason("ble_restart_required");
        publish();
        return;
    }
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
static void candidate_progress(const cp_network_diagnostic_t *diagnostic,void *context) {
    const command_t *cmd=context;
    cp_provision_set_diagnostic(diagnostic,cmd->attempt);
    reason(cp_network_diag_code_name(diagnostic->code));publish();
}
static void test_candidate(command_t *cmd) {
    cp_provision_snapshot_t previous;cp_provision_snapshot(&previous);
    cp_network_diagnostic_t diagnostic={0};
    cp_network_diag_update(&diagnostic,CP_DIAG_HANDOFF,CP_DIAG_QUEUED,ESP_OK,0,true,false);
    s_testing=true;reason("queued");cp_provision_set_status("testing","queued");
    cp_provision_set_diagnostic(&diagnostic,cmd->attempt);publish();
    cp_network_diagnostic_t interrupted=diagnostic;
    cp_network_diag_update(&interrupted,CP_DIAG_HANDOFF,CP_DIAG_VALIDATION_INTERRUPTED,ESP_ERR_INVALID_STATE,0,true,true);
    save_attempt_record(cmd->attempt,CP_ATTEMPT_INTERRUPTED,&interrupted);
    /* Let the local transport finish its received ACK; it promised no save. */
    vTaskDelay(pdMS_TO_TICKS(1200));
    esp_err_t err=cp_provision_stop();
    if(err==ESP_OK) {
        err=cp_network_validate_candidate_with_progress(&cmd->candidate,CP_NETWORK_VALIDATE_TIMEOUT_MS,candidate_progress,cmd);
        cp_network_diagnostic_snapshot(&diagnostic);
    } else cp_network_diag_update(&diagnostic,CP_DIAG_HANDOFF,CP_DIAG_HANDOFF_FAILED,err,1200,true,true);
    if(err==ESP_OK) {
        cp_network_diag_update(&diagnostic,CP_DIAG_SAVE,CP_DIAG_SAVING,ESP_OK,diagnostic.elapsed_ms,true,false);
        cp_provision_set_status("saving","saving");candidate_progress(&diagnostic,cmd);
        err=cp_settings_save(&cmd->candidate);
        if(err!=ESP_OK)cp_network_diag_update(&diagnostic,CP_DIAG_SAVE,CP_DIAG_SAVE_FAILED,err,diagnostic.elapsed_ms,true,true);
    }
    if(err==ESP_OK) {
        portENTER_CRITICAL(&s_settings_lock);s_settings=cmd->candidate;s_enrolled=true;++s_saved_generation;portEXIT_CRITICAL(&s_settings_lock);
        s_testing=false;reason("stored_restarting");
        cp_network_diag_update(&diagnostic,CP_DIAG_READY,CP_DIAG_SAVED,ESP_OK,diagnostic.elapsed_ms,false,true);
        cp_provision_set_diagnostic(&diagnostic,cmd->attempt);cp_provision_set_status("saved","stored_restarting");
        save_attempt_record(cmd->attempt,CP_ATTEMPT_SAVED,&diagnostic);publish();
        cp_settings_clear_sensitive(&cmd->candidate);vTaskDelay(pdMS_TO_TICKS(1500));esp_restart();
    } else {
        if(!diagnostic.terminal)cp_network_diag_update(&diagnostic,diagnostic.stage,
            cp_network_diag_timeout_code(&diagnostic),err,diagnostic.elapsed_ms,true,true);
        cp_settings_clear_sensitive(&cmd->candidate);s_testing=false;
        save_attempt_record(cmd->attempt,CP_ATTEMPT_FAILED,&diagnostic);
        enter_setup(previous.mode);
        const char *code=cp_network_diag_code_name(diagnostic.code);reason(code);
        cp_provision_set_diagnostic(&diagnostic,cmd->attempt);cp_provision_set_status("failed",code);publish();
    }
}
/* Recheck the grant after taking the HTTP resource: a completed request may
 * have invalidated or replaced the policy since the advisory snapshot. */
static bool claim_radio_policy(const cp_network_policy_t *policy) {
    if (!cp_network_begin_radio_transition())
        return false;
    cp_network_policy_t current;
    if (!cp_network_get_policy(&current) || current.request_sequence != policy->request_sequence) {
        cp_network_end_radio_transition();
        return false;
    }
    return true;
}
static cp_policy_result_t receive_policy(const cp_network_policy_t *policy) {
    uint64_t current = now_ms();
    uint64_t age = current >= policy->fetched_mono_ms
        ? current - policy->fetched_mono_ms : UINT64_MAX;
    s_policy_attempted_sequence = policy->request_sequence;
    return age < policy->lease_ms
        ? cp_core_receive_desired(&s_core, &policy->core, policy->request_sequence,
                                  current, policy->lease_ms - age)
        : CP_POLICY_STALE;
}
static void reject_policy(const cp_network_policy_t *policy) {
    /* A collector may flush while stopping; never own the HTTP/memory resource
     * while waiting for that worker. Activation reporting also takes it. */
    esp_err_t err = cp_pipeline_stop();
    cp_core_mark_apply_failed(&s_core);
    const char *failure = err == ESP_OK ? "unsupported_policy" : "capture_stop_failed";
    (void)cp_network_report_activation(policy->core.config_id, false, failure);
    reason(failure);
}
static void apply_control(void) {
    cp_network_snapshot_t net;
    cp_network_snapshot(&net);
    cp_provision_set_diagnostic(&net.diagnostic,NULL);
    cp_core_set_network(&s_core, net.network);
    cp_core_set_auth(&s_core, net.auth);
    cp_core_set_clock_trusted(&s_core, net.clock_trusted);
    esp_err_t maintenance = cp_pipeline_maintain();
    cp_pipeline_snapshot_t pipe;
    cp_pipeline_snapshot(&pipe);
    if (maintenance != ESP_OK || pipe.stop_failed)
        reason("capture_stop_failed");
    if (net.policy_response_sequence > s_policy_response_seen) {
        s_policy_response_seen = net.policy_response_sequence;
        if (!net.policy_valid) {
            (void)cp_pipeline_stop();
            if (net.policy_rejected || net.policy_expired) {
                cp_core_mark_apply_failed(&s_core);
                reason(net.policy_expired ? "collection_lease_expired" : "unsupported_policy");
                if (net.policy_rejected && net.desired_config_id[0])
                    (void)cp_network_report_activation(net.desired_config_id, false,
                                                       "unsupported_policy");
            } else {
                cp_core_clear_policy(&s_core);
                reason("unassigned");
            }
        }
    }
    cp_network_policy_t p = net.policy;
    if (cp_network_get_policy(&p) && p.request_sequence > s_policy_attempted_sequence &&
        maintenance == ESP_OK && !pipe.stop_failed) {
        bool same_applied = s_core.policy_state == CP_POLICY_APPLIED &&
            !strcmp(s_core.desired.config_id, p.core.config_id);
        if (same_applied) {
            /* Fresh same-policy grants do not allocate a radio or HTTP working
             * set. Validate their complete core semantics even during uploads,
             * rather than starving renewal behind a continuously busy client. */
            if (receive_policy(&p) == CP_POLICY_OK)
                cp_pipeline_renew_lease(p.fetched_mono_ms + p.lease_ms);
            else
                reject_policy(&p);
        } else if (net.http_in_flight) {
            reason("capture_waiting_for_network");
        } else {
            /* Stop/flush the old worker before claiming its memory resource.
             * apply() also stops defensively, but that stop must be a no-op. */
            esp_err_t stop = cp_pipeline_stop();
            cp_pipeline_snapshot(&pipe);
            if (stop != ESP_OK || pipe.stop_failed) {
                cp_core_mark_apply_failed(&s_core);
                (void)cp_network_report_activation(p.core.config_id, false, "capture_stop_failed");
                reason("capture_stop_failed");
            } else if (!claim_radio_policy(&p)) {
                /* Contention or replacement leaves this sequence retryable. */
                reason("capture_waiting_for_network");
            } else if (receive_policy(&p) != CP_POLICY_OK) {
                cp_network_end_radio_transition();
                reject_policy(&p);
            } else {
                cp_core_set_setup_active(&s_core, false);
                /* A deferred memory recovery stays staged until a fresh policy and
                 * healthy heap permit actual capture. Do not claim activation. */
                esp_err_t err = pipe.radio_restart_required ? ESP_ERR_INVALID_STATE
                    : pipe.memory_paused && !pipe.memory_restart_ready ? ESP_ERR_NO_MEM
                    : cp_pipeline_apply(&p);
                cp_network_end_radio_transition();
                cp_pipeline_snapshot(&pipe);
                if (err == ESP_OK && pipe.collecting && cp_core_mark_applied(&s_core, p.core.config_id)) {
                    (void)cp_network_report_activation(p.core.config_id, true, "applied");
                    reason("policy_applied");
                } else if (pipe.memory_paused && !pipe.radio_restart_required && !pipe.stop_failed) {
                    (void)cp_network_report_activation(p.core.config_id, false, "memory_pressure");
                    reason("memory_pressure");
                } else {
                    cp_core_mark_apply_failed(&s_core);
                    const char *failure = pipe.stop_failed ? "capture_stop_failed"
                        : pipe.radio_restart_required ? "ble_restart_required" : "capture_start_failed";
                    (void)cp_network_report_activation(p.core.config_id, false, failure);
                    reason(failure);
                }
            }
        }
    }
    cp_collection_state_t state = cp_core_decide(&s_core, now_ms());
    cp_pipeline_snapshot(&pipe);
    if (!cp_collection_allowed(state) && pipe.collecting) {
        if (cp_pipeline_stop() != ESP_OK)
            reason("capture_stop_failed");
        cp_pipeline_snapshot(&pipe);
    }
    if (cp_collection_allowed(state) && !pipe.collecting && pipe.storage_ready &&
        maintenance == ESP_OK && !pipe.stop_failed && !pipe.radio_restart_required &&
        !net.http_in_flight && (!pipe.memory_paused || pipe.memory_restart_ready) &&
        cp_network_get_policy(&p) && p.request_sequence == s_core.latest_request_sequence &&
        !strcmp(p.core.config_id, s_core.applied_config_id) &&
        (!pipe.pressure_paused ||
         pipe.free_slots * 100u >= pipe.capacity_slots * (100u - p.resume_pct))) {
        esp_err_t stop = cp_pipeline_stop();
        cp_pipeline_snapshot(&pipe);
        if (stop != ESP_OK || pipe.stop_failed) {
            cp_core_mark_apply_failed(&s_core);
            reason("capture_stop_failed");
        } else if (!claim_radio_policy(&p)) {
            reason("capture_waiting_for_network");
        } else {
            uint64_t current = now_ms();
            bool fresh = current >= p.fetched_mono_ms && current - p.fetched_mono_ms < p.lease_ms &&
                cp_collection_allowed(cp_core_decide(&s_core, current));
            esp_err_t err = fresh ? cp_pipeline_apply(&p) : ESP_ERR_INVALID_STATE;
            cp_network_end_radio_transition();
            reason(!fresh ? "collection_lease_expired" : err != ESP_OK
                ? "capture_recovery_failed" : "policy_applied");
        }
    }
    state = cp_core_decide(&s_core, now_ms());
    cp_pipeline_snapshot(&pipe);
    bool policy_current = net.policy_valid && s_core.policy_state != CP_POLICY_FAILED &&
        s_core.lease_valid && now_ms() >= p.fetched_mono_ms &&
        now_ms() - p.fetched_mono_ms < p.lease_ms;
    if (pipe.stop_failed || maintenance != ESP_OK)
        reason("capture_stop_failed");
    else if (state == CP_COLLECTION_LEASE_EXPIRED)
        reason("collection_lease_expired");
    else if (net.policy_valid && pipe.radio_restart_required && strcmp(s_reason, "unsupported_policy"))
        reason("ble_restart_required");
    else if (policy_current && pipe.memory_paused)
        reason("memory_pressure");
    else if (cp_collection_allowed(state) && pipe.memory_raw_paused && p.raw_enabled)
        reason("memory_raw_pressure");
    else if (cp_collection_allowed(state) && pipe.collecting &&
             (!strcmp(s_reason, "memory_pressure") || !strcmp(s_reason, "memory_raw_pressure")))
        reason("policy_applied");
    cp_network_set_capture_state(cp_collection_allowed(state) && pipe.collecting ? "running"
                                 : pipe.stop_failed                            ? "failed"
                                 : state == CP_COLLECTION_LEASE_EXPIRED          ? "expired"
                                 : state == CP_COLLECTION_WAIT_POLICY            ? "unassigned"
                                 : state == CP_COLLECTION_POLICY_FAILED          ? "failed"
                                 : pipe.radio_restart_required                   ? "failed"
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
    s_saved_generation=s_enrolled?1:0;
    err=cp_provision_bind_context(s_node,s_boot,(uint32_t)esp_reset_reason(),resolve_saved_credential,NULL);
    if(err!=ESP_OK)return err;
    s_history_error=cp_network_attempt_load(&s_previous_attempt);
    s_have_previous_attempt=s_history_error==ESP_OK;
    if(s_history_error==ESP_ERR_NOT_FOUND)s_history_error=ESP_OK;
    cp_provision_set_previous_attempt(s_have_previous_attempt?&s_previous_attempt:NULL,s_history_error);
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
