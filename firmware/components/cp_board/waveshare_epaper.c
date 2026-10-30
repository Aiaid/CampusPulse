// CampusPulse board adapter — Waveshare ESP32-S3-ePaper-1.54 V2.
//
// Confirmed board facts (Waveshare documentation and the working Arduino test
// firmware in firmware/epaper-test): ESP32-S3-PICO-1-N8R8, 8 MB DIO Flash, 8 MB
// OPI PSRAM, native USB Serial/JTAG, 1.54" 200x200 SSD1681 panel on SPI
// (RST 9, DC 10, CS 11, SCK 12, MOSI 13, BUSY 8) with panel power on GPIO 6
// (high = off). Buttons and battery measurement are not verified under ESP-IDF.

#include "cp_board.h"
#include "cp_collect.h"
#include "epaper_card.h"
#include "sdkconfig.h"
#if !CONFIG_IDF_TARGET_ESP32S3
#error "The Waveshare adapter supports ESP32-S3 only; add a verified profile per board."
#endif
#include "esp_chip_info.h"
#include "esp_mac.h"
#include "esp_timer.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include <stddef.h>
#include <string.h>

/* Full refreshes take about three seconds and wear the panel, so transient
 * counters must not drive them. Key state changes refresh at once; data-only
 * changes wait for the periodic refresh. */
#define CARD_MIN_INTERVAL_MS 15000
#define CARD_DATA_INTERVAL_MS 600000

static const cp_board_profile_t s_profile = {
    .board_id = "waveshare_epaper_s3",
    .revision = "esp32-s3-pico-1-n8r8",
    .target_chip = "esp32s3",
    /* Display only: buttons and battery measurement are not verified yet. */
    .capabilities = CP_CAP_BLE_SCAN | CP_CAP_DISPLAY,
    .max_addresses = CP_COLLECT_ADDRESSES,
    .ingress_queue_bytes = 8192,
    /* A compiled ceiling, not an authorization grant or measured capacity. */
    .max_collection_lease_ms = 300000,
};

static bool s_display_ready;
static QueueHandle_t s_views;
static void display_task(void *context);

const cp_board_profile_t *cp_board_profile(void) { return &s_profile; }

esp_err_t cp_board_factory_mac(uint8_t mac[6]) {
    if (!mac)
        return ESP_ERR_INVALID_ARG;
    esp_chip_info_t chip;
    esp_chip_info(&chip);
    if (chip.model != CHIP_ESP32S3)
        return ESP_ERR_NOT_SUPPORTED;
    return esp_efuse_mac_get_default(mac);
}

esp_err_t cp_board_initialize(cp_board_health_t *health, cp_input_handler_t handler,
                              void *context) {
    (void)handler;
    (void)context;
    if (!health)
        return ESP_ERR_INVALID_ARG;
    memset(health, 0, sizeof(*health));
    health->input_error = ESP_ERR_NOT_SUPPORTED;
    health->battery_error = ESP_ERR_NOT_SUPPORTED;
    if (s_display_ready) {
        health->display_ready = true;
        health->display_error = ESP_OK;
        return ESP_OK;
    }
    s_views = xQueueCreate(1, sizeof(cp_board_view_t));
    if (!s_views) {
        health->display_error = ESP_ERR_NO_MEM;
        return ESP_OK;
    }
    health->display_error = epaper_card_init();
    if (health->display_error == ESP_OK &&
        xTaskCreate(display_task, "cp_epaper", 4096, NULL, 3, NULL) != pdPASS)
        health->display_error = ESP_ERR_NO_MEM;
    if (health->display_error != ESP_OK) {
        vQueueDelete(s_views);
        s_views = NULL;
    }
    s_display_ready = health->display_ready = health->display_error == ESP_OK;
    /* Optional peripherals never gate the collector. */
    return ESP_OK;
}

int cp_board_battery_percent(void) { return -1; }

static bool key_state_changed(const cp_board_view_t *a, const cp_board_view_t *b) {
    return strcmp(a->network, b->network) != 0 ||
           strcmp(a->authentication, b->authentication) != 0 ||
           strcmp(a->policy, b->policy) != 0 || strcmp(a->collection, b->collection) != 0 ||
           a->setup_active != b->setup_active ||
           strcmp(a->setup_state, b->setup_state) != 0 ||
           a->debug.upload.failures > b->debug.upload.failures ||
           a->debug.raw_drops > b->debug.raw_drops;
}

static const char *upload_state(const cp_debug_upload_t *upload) {
    if (upload->in_flight) return "SENDING";
    switch (upload->result) {
    case CP_DEBUG_UPLOAD_ACKED: return "ACKED";
    case CP_DEBUG_UPLOAD_RETRY: return "RETRY";
    case CP_DEBUG_UPLOAD_REJECTED: return "REJECTED";
    case CP_DEBUG_UPLOAD_AUTH: return "AUTH ERROR";
    case CP_DEBUG_UPLOAD_POLICY: return "POLICY ERROR";
    case CP_DEBUG_UPLOAD_BAD_ACK: return "BAD ACK";
    default: return "NONE";
    }
}

static esp_err_t show_view(const cp_board_view_t *view) {
    const epaper_card_t card = {
        .title = "CAMPUSPULSE",
        .node = view->node_id,
        .board = view->board,
        .network = view->network,
        .authentication = view->authentication,
        .policy = view->policy,
        .collection = view->collection,
        .setup_active = view->setup_active,
        .setup_state = view->setup_state,
        .wifi_rssi_known = view->debug.wifi_rssi_known,
        .wifi_rssi_dbm = view->debug.wifi_rssi_dbm,
        .heap_known = view->debug.heap_known,
        .heap_free = view->debug.heap_internal_free,
        .heap_total = view->debug.heap_internal_total,
        .queue_known = view->debug.queue_known,
        .queue_pending = view->debug.queue_pending,
        .queue_capacity = view->debug.queue_capacity,
        .upload_known = view->debug.upload.known,
        .upload_in_flight = view->debug.upload.in_flight,
        .upload_state = upload_state(&view->debug.upload),
        .upload_age_seconds = view->debug.upload.last_age_ms / 1000,
        .reports_total = view->debug.reports_total,
        .aggregation_drops = view->debug.aggregation_drops,
        .summary_drops = view->debug.summary_drops,
        .raw_drops = view->debug.raw_drops,
        .upload_failures = view->debug.upload.failures,
    };
    return epaper_card_show(&card);
}

static void display_task(void *context) {
    (void)context;
    cp_board_view_t latest, last;
    bool have_latest = false, have_last = false, attempted = false;
    int64_t last_attempt_ms = 0;
    for (;;) {
        if (!have_latest) {
            if (xQueueReceive(s_views, &latest, portMAX_DELAY) == pdTRUE)
                have_latest = true;
            continue;
        }
        int64_t now = esp_timer_get_time() / 1000;
        const bool key = !have_last || key_state_changed(&latest, &last);
        const int64_t interval = key ? CARD_MIN_INTERVAL_MS : CARD_DATA_INTERVAL_MS;
        const int64_t elapsed = now - last_attempt_ms;
        if (!attempted || elapsed < 0 || elapsed >= interval) {
            esp_err_t err = show_view(&latest);
            /* Throttle failures as well as successes; retry the latest view. */
            last_attempt_ms = esp_timer_get_time() / 1000;
            attempted = true;
            if (err == ESP_OK) {
                last = latest;
                have_last = true;
            } else {
                ESP_LOGW("cp_epaper", "refresh failed: %s", esp_err_to_name(err));
                have_last = false;
            }
            continue;
        }
        TickType_t wait = pdMS_TO_TICKS(interval - elapsed);
        if (!wait) wait = 1;
        /* A one-element queue replaces stale snapshots while refresh blocks. */
        xQueueReceive(s_views, &latest, wait);
    }
}

void cp_board_present(const cp_board_view_t *view) {
    if (view && s_display_ready)
        (void)xQueueOverwrite(s_views, view);
}

esp_err_t cp_board_start_diagnostic_ui(void) { return ESP_ERR_NOT_SUPPORTED; }

void cp_board_diagnostic_input(const cp_input_event_t *event) { (void)event; }
