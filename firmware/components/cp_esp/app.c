#include "cp_app.h"
#include "cp_board.h"
#include "cp_core.h"
#include "cp_runtime.h"
#include "cp_provision.h"
#include "cp_usb.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "sdkconfig.h"
#if CONFIG_CP_LEGACY_RADAR_DIAGNOSTICS
#include "scan_ble.h"
#endif
#include <stdio.h>

static const char *TAG = "cp_app";
static TaskHandle_t s_task;
static QueueHandle_t s_input;
static uint32_t s_input_drops;
static bool s_boot_ready, s_diagnostics, s_diagnostic_ui;
static cp_core_t s_core;
static char s_node_id[CP_NODE_ID_SIZE];
#if !CONFIG_CP_LEGACY_RADAR_DIAGNOSTICS
static esp_err_t s_runtime_error;
static bool begin_usb_setup(void *unused) {
    (void)unused;
    return cp_runtime_request_setup(CP_PROVISION_USB);
}
#endif

static void input_received(const cp_input_event_t *event, void *context) {
    (void)context;
    if (xQueueSend(s_input, event, 0) != pdTRUE)
        __atomic_add_fetch(&s_input_drops, 1u, __ATOMIC_RELAXED);
}
/* UTC+8 HH:MM for the retained ePaper card. Unknown time stays "--:--". */
static void format_hhmm(uint64_t utc_ms, char out[6]) {
    if (utc_ms < 1600000000000ULL) {
        snprintf(out, 6, "--:--");
        return;
    }
    const uint32_t day = (uint32_t)((utc_ms / 1000 + 8ULL * 3600) % 86400);
    snprintf(out, 6, "%02u:%02u", (unsigned)(day / 3600), (unsigned)((day % 3600) / 60));
}
static void show_status(const cp_runtime_snapshot_t *runtime) {
    (void)runtime;
    cp_board_view_t view = {.battery_percent = cp_board_battery_percent()};
    snprintf(view.node_id, sizeof(view.node_id), "%s", s_node_id);
    snprintf(view.board, sizeof(view.board), "%s", cp_board_profile()->board_id);
    snprintf(view.network, sizeof(view.network), "NEEDS WIFI SETUP");
    snprintf(view.authentication, sizeof(view.authentication), "NOT ENROLLED");
    snprintf(view.policy, sizeof(view.policy), "WAITING FOR CONFIG");
    const cp_collection_state_t state =
        cp_core_decide(&s_core, (uint64_t)esp_timer_get_time() / 1000);
    snprintf(view.collection, sizeof(view.collection), "%s",
             s_diagnostics ? "LOCAL DIAGNOSTICS" : cp_collection_state_name(state));
#if !CONFIG_CP_LEGACY_RADAR_DIAGNOSTICS
    snprintf(view.network, sizeof view.network, "%s",
             runtime->testing_candidate                          ? "TESTING CONNECTION"
             : runtime->network.network == CP_NETWORK_READY      ? "CONNECTED"
             : runtime->network.network == CP_NETWORK_CONNECTING ? "CONNECTING"
                                                                 : "OFFLINE");
    snprintf(view.authentication, sizeof view.authentication, "%s",
             runtime->network.auth == CP_AUTH_VALID      ? "AUTHENTICATED"
             : runtime->network.auth == CP_AUTH_REJECTED ? "AUTH REJECTED"
             : runtime->enrolled                         ? "AWAITING CLOUD"
                                                         : "NOT ENROLLED");
    snprintf(view.policy, sizeof view.policy, "%s",
             runtime->network.activation_confirmed ? "CLOUD CONFIRMED"
             : runtime->network.policy_present     ? "POLICY ASSIGNED"
                                                   : "WAITING FOR CONFIG");
    snprintf(view.collection, sizeof view.collection, "%s",
             s_runtime_error != ESP_OK           ? "RUNTIME ERROR"
             : !runtime->pipeline.storage_ready  ? "JOURNAL UNAVAILABLE"
             : runtime->pipeline.stop_failed     ? "CAPTURE STOP FAILED"
             : runtime->pipeline.radio_restart_required ? "BLE NEEDS RESTART"
             : runtime->pipeline.memory_paused && runtime->network.policy_valid &&
                 runtime->collection != CP_COLLECTION_LEASE_EXPIRED &&
                 runtime->collection != CP_COLLECTION_POLICY_FAILED ? "MEMORY PAUSED"
             : runtime->pipeline.memory_raw_paused && runtime->network.policy.raw_enabled &&
                 runtime->pipeline.collecting ? "RAW MEMORY PAUSED"
             : runtime->pipeline.pressure_paused ? "STORAGE PAUSED"
             : cp_collection_allowed(runtime->collection) && !runtime->pipeline.collecting
                 ? "CAPTURE STOPPED"
                 : cp_collection_allowed(runtime->collection)
                     ? "COLLECTING"
                     : cp_collection_state_name(runtime->collection));
    view.setup_active = runtime->provision.active;
    view.setup_softap = runtime->provision.mode == CP_PROVISION_SOFTAP;
    view.setup_usb = runtime->provision.mode == CP_PROVISION_USB;
    snprintf(view.setup_name, sizeof view.setup_name, "%s", runtime->provision.service_name);
    snprintf(view.setup_proof, sizeof view.setup_proof, "%s", runtime->provision.proof);
    snprintf(view.setup_password, sizeof view.setup_password, "%s", runtime->provision.ap_password);
    snprintf(view.setup_state, sizeof view.setup_state, "%s", runtime->provision.state);
#endif
    snprintf(view.last_ack, sizeof view.last_ack, "--:--");
#if !CONFIG_CP_LEGACY_RADAR_DIAGNOSTICS
    if (runtime) {
        view.has_window = runtime->pipeline.has_window;
        view.window_reports = runtime->pipeline.last_window_reports;
        view.window_identifiers = runtime->pipeline.last_window_identifiers;
        view.rssi_min = runtime->pipeline.last_rssi_min;
        view.rssi_max = runtime->pipeline.last_rssi_max;
        if (runtime->pipeline.last_ack_uptime_ms) {
            const uint32_t now_up = (uint32_t)(esp_timer_get_time() / 1000);
            const uint32_t age_ms = now_up - runtime->pipeline.last_ack_uptime_ms;
            view.has_last_ack = true;
            if (runtime->network.clock_trusted && runtime->network.clock_utc_ms) {
                const uint64_t now_utc = runtime->network.clock_utc_ms +
                    ((uint64_t)now_up >= runtime->network.clock_mono_ms
                         ? (uint64_t)now_up - runtime->network.clock_mono_ms
                         : 0);
                format_hhmm(now_utc > age_ms ? now_utc - age_ms : 0, view.last_ack);
            }
            view.stale = age_ms > 120000u;
        } else {
            view.stale = true;
        }
    }
#endif
    cp_board_present(&view);
#if !CONFIG_CP_LEGACY_RADAR_DIAGNOSTICS
    static bool stack_reported;
    if (!stack_reported && runtime->pipeline.collecting) {
        ESP_LOGI("cp_app","supervisor_stack_free=%u",(unsigned)uxTaskGetStackHighWaterMark(NULL));
        stack_reported=true;
    }
#endif
}
static void supervisor(void *context) {
    (void)context;
    while (!__atomic_load_n(&s_boot_ready, __ATOMIC_ACQUIRE))
        vTaskDelay(pdMS_TO_TICKS(10));
    uint32_t reported_drops = 0, stack_sample_rounds = 0;
#if !CONFIG_CP_LEGACY_RADAR_DIAGNOSTICS
    /* One caller-owned snapshot, shared with presentation: never nest two
     * large runtime snapshots on this task stack. */
    cp_runtime_snapshot_t runtime;
#endif
    for (;;) {
        cp_input_event_t event;
        if (xQueueReceive(s_input, &event, pdMS_TO_TICKS(500)) == pdTRUE) {
            if (s_diagnostic_ui)
                cp_board_diagnostic_input(&event);
#if !CONFIG_CP_LEGACY_RADAR_DIAGNOSTICS
            else {
                cp_runtime_snapshot(&runtime);
                if (event.kind == CP_INPUT_LONG && event.button == CP_BUTTON_OK) {
                    if (runtime.provision.active)
                        (void)cp_runtime_request_resume();
                    else
                        (void)cp_runtime_request_setup(CP_PROVISION_BLE);
                } else if (runtime.provision.active && event.kind == CP_INPUT_CLICK) {
                    if (event.button == CP_BUTTON_UP)
                        (void)cp_runtime_request_setup(CP_PROVISION_BLE);
                    if (event.button == CP_BUTTON_DOWN)
                        (void)cp_runtime_request_setup(CP_PROVISION_SOFTAP);
                }
            }
#endif
        }
        const uint32_t dropped = __atomic_load_n(&s_input_drops, __ATOMIC_RELAXED);
        if (dropped != reported_drops) {
            ESP_LOGW(TAG, "Input queue losses: %lu", (unsigned long)dropped);
            reported_drops = dropped;
        }
        if (!s_diagnostic_ui) {
#if CONFIG_CP_LEGACY_RADAR_DIAGNOSTICS
            show_status(NULL);
#else
            cp_runtime_snapshot(&runtime);
            show_status(&runtime);
#endif
        }
        if (stack_sample_rounds < 10 && ++stack_sample_rounds == 10)
            ESP_LOGI(TAG, "Supervisor minimum free stack: %u bytes",
                     (unsigned)uxTaskGetStackHighWaterMark(NULL));
    }
}
esp_err_t cp_app_start(void) {
    if (s_task)
        return ESP_OK;
    const cp_board_profile_t *profile = cp_board_profile();
    /* Report the real board family to the administrator wizard. */
    cp_provision_set_board(profile->board_id);
    cp_core_init(&s_core, profile);
    uint8_t factory_mac[6];
    esp_err_t err = cp_board_factory_mac(factory_mac);
    if (err != ESP_OK)
        return err;
    if (!cp_node_id_from_base_mac(factory_mac, s_node_id, sizeof(s_node_id)))
        return ESP_ERR_INVALID_STATE;
    cp_core_set_identity(&s_core, CP_IDENTITY_FACTORY);
#if !CONFIG_CP_LEGACY_RADAR_DIAGNOSTICS
    /* Proof and boot entropy must be prepared before the board enables ADC. */
    s_runtime_error = cp_runtime_prepare(s_node_id, profile);
#endif
    s_input = xQueueCreate(16, sizeof(cp_input_event_t));
    if (!s_input)
        return ESP_ERR_NO_MEM;
    /* Start the consumer before enabling callbacks; task failure is still safe
     * to clean up because no input driver holds a reference to the queue. */
    if (xTaskCreate(supervisor, "cp_supervisor", 8192, NULL, 5, &s_task) != pdPASS) {
        vQueueDelete(s_input);
        s_input = NULL;
        return ESP_ERR_NO_MEM;
    }
    cp_board_health_t health;
    err = cp_board_initialize(&health, input_received, NULL);
    if (err != ESP_OK) {
        vTaskDelete(s_task);
        s_task = NULL;
        vQueueDelete(s_input);
        s_input = NULL;
        return err;
    }
    cp_core_set_ui(&s_core, health.display_ready                       ? CP_UI_READY
                            : (profile->capabilities & CP_CAP_DISPLAY) ? CP_UI_DEGRADED
                                                                       : CP_UI_ABSENT);
    ESP_LOGI(TAG, "Node=%s board=%s revision=%s", s_node_id, profile->board_id, profile->revision);
    ESP_LOGI(TAG, "Optional peripherals display=%d input=%d battery=%d", health.display_ready,
             health.input_ready, health.battery_ready);
#if CONFIG_CP_LEGACY_RADAR_DIAGNOSTICS
    /* Local-only diagnostic compatibility mode; no enrollment or field upload. */
    err = scan_ble_start();
    s_diagnostics = err == ESP_OK;
    if (!s_diagnostics)
        ESP_LOGE(TAG, "Diagnostic scanner: %s", esp_err_to_name(err));
    else {
        s_diagnostic_ui = cp_board_start_diagnostic_ui() == ESP_OK;
        if (!s_diagnostic_ui)
            ESP_LOGW(TAG, "Diagnostic scanner has no UI task");
    }
#endif
#if !CONFIG_CP_LEGACY_RADAR_DIAGNOSTICS
    if (s_runtime_error == ESP_OK) {
        s_runtime_error = cp_runtime_start();
        if (s_runtime_error == ESP_OK) {
            esp_err_t usb = cp_usb_start(begin_usb_setup, NULL);
            if (usb != ESP_OK)
                ESP_LOGW(TAG, "USB provisioning unavailable: %s", esp_err_to_name(usb));
        }
    }
#endif
    if (!s_diagnostics)
        ESP_LOGI(TAG, "Runtime initialized; provisioning and assigned policy control collection");
    __atomic_store_n(&s_boot_ready, true, __ATOMIC_RELEASE);
    return ESP_OK;
}
