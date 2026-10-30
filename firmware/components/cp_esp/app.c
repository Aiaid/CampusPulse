#include "cp_app.h"
#include "cp_board.h"
#include "cp_core.h"
#include "cp_runtime.h"
#include "cp_usb.h"
#include "cp_perf.h"
#include "esp_log.h"
#include "esp_heap_caps.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "scan_ble.h"
#include "sdkconfig.h"
#include <stdio.h>

/* ESP-IDF task stack sizes are bytes. Repeated ten-minute C3 HTTP/profile runs
 * used 4,460 bytes of the former 8 KiB supervisor stack (minimum free 3,732).
 * The MQTT budget leaves 1,684 measured bytes; MQTT/BLE and other paths still
 * need on-device high-water verification, not just a passing host test. */
#if CONFIG_CP_NETWORK_MQTT_WSS
enum { CP_SUPERVISOR_STACK_BYTES = 6144 };
#else
enum { CP_SUPERVISOR_STACK_BYTES = 8192 };
#endif

static const char *TAG = "cp_app";
static TaskHandle_t s_task;
static QueueHandle_t s_input;
static uint32_t s_input_drops;
static bool s_boot_ready, s_diagnostics, s_diagnostic_ui;
static cp_core_t s_core;
static char s_node_id[CP_NODE_ID_SIZE];
/* Fixed storage in the supervisor; no new task or heap allocation. Minima are
 * one-second samples, deliberately distinct from the SDK boot low-water mark. */
static cp_debug_snapshot_t s_debug;
static cp_device_page_t s_page;
static bool s_debug_sampled;
static uint64_t s_debug_sample_ms;
static void sample_debug(const cp_runtime_snapshot_t *runtime, uint64_t now) {
    if (s_debug_sampled && now >= s_debug_sample_ms && now-s_debug_sample_ms < 1000) return;
    const uint32_t caps=MALLOC_CAP_INTERNAL|MALLOC_CAP_8BIT;
    s_debug.heap_internal_free=(uint32_t)heap_caps_get_free_size(caps);
    s_debug.heap_internal_total=(uint32_t)heap_caps_get_total_size(caps);
    s_debug.heap_internal_largest=(uint32_t)heap_caps_get_largest_free_block(caps);
    s_debug.heap_boot_min_8bit=(uint32_t)heap_caps_get_minimum_free_size(MALLOC_CAP_8BIT);
    if (!s_debug_sampled || s_debug.heap_internal_free < s_debug.heap_sample_min_free)
        s_debug.heap_sample_min_free=s_debug.heap_internal_free;
    if (!s_debug_sampled || s_debug.heap_internal_largest < s_debug.heap_sample_min_largest)
        s_debug.heap_sample_min_largest=s_debug.heap_internal_largest;
    s_debug.heap_known=true;
#if !CONFIG_CP_LEGACY_RADAR_DIAGNOSTICS
    cp_network_debug_snapshot(&s_debug);
    s_debug.queue_known=runtime->pipeline.storage_ready && runtime->pipeline.capacity_slots>0;
    s_debug.queue_pending=runtime->pipeline.pending;
    s_debug.queue_capacity=runtime->pipeline.capacity_slots;
    s_debug.queue_quarantined=runtime->pipeline.quarantined_slots;
    s_debug.ble_collecting=runtime->pipeline.collecting;
    s_debug.ble_memory_paused=runtime->pipeline.memory_paused;
    s_debug.ble_raw_paused=runtime->pipeline.raw_paused || runtime->pipeline.memory_raw_paused;
    s_debug.ble_pressure_paused=runtime->pipeline.pressure_paused;
    s_debug.aggregation_drops=runtime->pipeline.aggregation_drops;
    s_debug.summary_drops=runtime->pipeline.summary_drops;
    s_debug.raw_drops=runtime->pipeline.raw_drops;
    s_debug.storage_drops=runtime->pipeline.storage_drops;
    s_debug.windows_dropped=runtime->pipeline.windows_dropped;
    cp_pipeline_domain_snapshot(&s_debug.domain);
    s_debug.reports_total=runtime->pipeline.reports_seen;
    s_debug.windows_total=runtime->pipeline.windows_committed;
    s_debug.summaries_total=runtime->pipeline.summaries_committed;
    s_debug.clock_trusted=runtime->network.clock_trusted;
    s_debug.clock_estimated=runtime->network.clock_estimated;
    s_debug.clock_epoch=runtime->network.clock_epoch;
    s_debug.clock_uncertainty_ms=runtime->network.clock_uncertainty_ms;
#else
    (void)runtime;
#endif
    s_debug_sampled=true;
    s_debug_sample_ms=now;
}
#if !CONFIG_CP_LEGACY_RADAR_DIAGNOSTICS
static esp_err_t s_runtime_error;
static void log_pipeline_state(const cp_runtime_snapshot_t *runtime) {
    static uint64_t last_ms;
    static bool logged;
    uint64_t now=(uint64_t)esp_timer_get_time()/1000;
    if (logged && now>=last_ms && now-last_ms<30000) return;
    logged=true;
    last_ms=now;
    const cp_pipeline_snapshot_t *p=&runtime->pipeline;
    const uint32_t caps=MALLOC_CAP_INTERNAL|MALLOC_CAP_8BIT;
    (void)p;
    (void)caps; /* Keep log-disabled builds valid without querying the heap. */
    /* Numeric state remains observable even while no window can be persisted.
     * A stopped radio must never look like a successful zero-loss experiment. */
    ESP_LOGI(TAG,"pipeline_state collecting=%u memory_paused=%u pressure_paused=%u stop_failed=%u pending=%lu free_slots=%lu reports_seen=%lu callbacks_dropped=%lu observer_rejected=%lu windows_dropped=%lu storage_drops=%lu summary_drops=%lu raw_drops=%lu upload_failures=%lu ack_failures=%lu sealed_pending=%lu final_window_pending=%lu seal_overflows=%lu seal_wait_max_ms=%lu persist_max_ms=%lu free=%u largest=%u",
        (unsigned)p->collecting,(unsigned)p->memory_paused,
        (unsigned)p->pressure_paused,(unsigned)p->stop_failed,
        (unsigned long)p->pending,(unsigned long)p->free_slots,
        (unsigned long)p->reports_seen,(unsigned long)p->callback_queue_drops,
        (unsigned long)p->collector_rejections,(unsigned long)p->windows_dropped,
        (unsigned long)p->storage_drops,(unsigned long)p->summary_drops,
        (unsigned long)p->raw_drops,(unsigned long)p->upload_failures,
        (unsigned long)p->ack_failures,(unsigned long)p->sealed_pending,
        (unsigned long)p->final_window_pending,(unsigned long)p->seal_overflows,
        (unsigned long)p->seal_wait_max_ms,(unsigned long)p->persist_max_ms,
        (unsigned)heap_caps_get_free_size(caps),
        (unsigned)heap_caps_get_largest_free_block(caps));
#if CONFIG_CP_PIPELINE_PSRAM_BANKS
    const uint32_t external_caps = MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT;
    ESP_LOGI(TAG,"memory_caps internal_free=%u internal_min=%u internal_largest=%u internal_total=%u psram_free=%u psram_min=%u psram_largest=%u psram_total=%u",
        (unsigned)heap_caps_get_free_size(caps),
        (unsigned)heap_caps_get_minimum_free_size(caps),
        (unsigned)heap_caps_get_largest_free_block(caps),
        (unsigned)heap_caps_get_total_size(caps),
        (unsigned)heap_caps_get_free_size(external_caps),
        (unsigned)heap_caps_get_minimum_free_size(external_caps),
        (unsigned)heap_caps_get_largest_free_block(external_caps),
        (unsigned)heap_caps_get_total_size(external_caps));
#endif
}
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
static void show_status(const cp_runtime_snapshot_t *runtime) {
    sample_debug(runtime,(uint64_t)esp_timer_get_time()/1000);
    cp_board_view_t view = {.battery_percent = cp_board_battery_percent()};
    view.debug=s_debug;
    view.page=s_page;
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
                 : cp_collection_state_name(runtime->collection));
    view.setup_active = runtime->provision.active;
    snprintf(view.setup_state, sizeof view.setup_state, "%s", runtime->provision.state);
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
                        (void)cp_runtime_request_setup(CP_PROVISION_USB);
                } else if (!runtime.provision.active && event.kind == CP_INPUT_CLICK) {
                    if (event.button == CP_BUTTON_DOWN)
                        s_page=(cp_device_page_t)((s_page+1)%CP_DEVICE_PAGE_COUNT);
                    else if (event.button == CP_BUTTON_UP)
                        s_page=(cp_device_page_t)((s_page+CP_DEVICE_PAGE_COUNT-1)%CP_DEVICE_PAGE_COUNT);
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
            log_pipeline_state(&runtime);
            show_status(&runtime);
#endif
        }
        if (stack_sample_rounds < 10 && ++stack_sample_rounds == 10)
            ESP_LOGI(TAG, "Supervisor minimum free stack: %u bytes",
                     (unsigned)uxTaskGetStackHighWaterMark(NULL));
        cp_perf_poll();
    }
}
esp_err_t cp_app_start(void) {
    if (s_task)
        return ESP_OK;
    const cp_board_profile_t *profile = cp_board_profile();
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
    if (xTaskCreate(supervisor, "cp_supervisor", CP_SUPERVISOR_STACK_BYTES, NULL, 5, &s_task) != pdPASS) {
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
