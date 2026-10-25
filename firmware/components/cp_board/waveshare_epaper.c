// CampusPulse board adapter — Waveshare ESP32-S3-ePaper-1.54 V2.
//
// Confirmed board facts (Waveshare documentation and the working Arduino test
// firmware in firmware/epaper-test): ESP32-S3-PICO-1-N8R8, 8 MB DIO Flash, 8 MB
// OPI PSRAM, native USB Serial/JTAG, 1.54" 200x200 SSD1681 panel on SPI
// (RST 9, DC 10, CS 11, SCK 12, MOSI 13, BUSY 8) with panel power on GPIO 6
// (high = off). Buttons and battery measurement are not verified under ESP-IDF.

#include "cp_board.h"
#include "epaper_card.h"
#include "sdkconfig.h"
#if !CONFIG_IDF_TARGET_ESP32S3
#error "The Waveshare adapter supports ESP32-S3 only; add a verified profile per board."
#endif
#include "esp_chip_info.h"
#include "esp_mac.h"
#include "esp_timer.h"
#include <stddef.h>
#include <string.h>

/* Full refreshes take about three seconds and wear the panel, so transient
 * counters must not drive them. Key state changes refresh at once; data-only
 * changes wait for the periodic window that keeps LAST/STALE honest. */
#define CARD_MIN_INTERVAL_MS 15000
#define CARD_DATA_INTERVAL_MS 600000

static const cp_board_profile_t s_profile = {
    .board_id = "waveshare_epaper_s3",
    .revision = "esp32-s3-pico-1-n8r8",
    .target_chip = "esp32s3",
    /* Display only: buttons and battery measurement are not verified yet. */
    .capabilities = CP_CAP_BLE_SCAN | CP_CAP_DISPLAY,
    .max_addresses = 384,
    .ingress_queue_bytes = 8192,
    /* A compiled ceiling, not an authorization grant or measured capacity. */
    .max_collection_lease_ms = 300000,
};

static bool s_display_ready;
static bool s_have_view;
static bool s_last_had_window;
static cp_board_view_t s_last_view;
static int64_t s_last_refresh_ms;

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
    health->display_error = epaper_card_init();
    s_display_ready = health->display_ready = health->display_error == ESP_OK;
    /* Optional peripherals never gate the collector. */
    return ESP_OK;
}

int cp_board_battery_percent(void) { return -1; }

static bool key_state_changed(const cp_board_view_t *a, const cp_board_view_t *b) {
    return strcmp(a->network, b->network) != 0 ||
           strcmp(a->authentication, b->authentication) != 0 ||
           strcmp(a->policy, b->policy) != 0 || strcmp(a->collection, b->collection) != 0 ||
           a->setup_active != b->setup_active || a->setup_usb != b->setup_usb ||
           a->setup_softap != b->setup_softap ||
           strcmp(a->setup_state, b->setup_state) != 0 ||
           strcmp(a->setup_proof, b->setup_proof) != 0 ||
           strcmp(a->setup_password, b->setup_password) != 0;
}

void cp_board_present(const cp_board_view_t *view) {
    if (!view || !s_display_ready)
        return;
    /* First real window is worth one immediate redraw so the card does not
     * keep claiming "waiting" until the periodic data refresh. */
    const bool first_data = view->has_window && !s_last_had_window;
    const bool key = !s_have_view || first_data || key_state_changed(view, &s_last_view);
    const int64_t now = esp_timer_get_time() / 1000;
    const bool due = s_have_view && now - s_last_refresh_ms >= CARD_DATA_INTERVAL_MS;
    if (!key && !due)
        return;
    if (s_have_view && now - s_last_refresh_ms < CARD_MIN_INTERVAL_MS)
        return;

    const char *setup_code = view->setup_usb ? "USB"
                             : view->setup_softap ? view->setup_password
                                                  : view->setup_proof;
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
        .setup_code = setup_code,
        .has_window = view->has_window,
        .has_last_ack = view->has_last_ack,
        .stale = view->stale,
        .window_reports = view->window_reports,
        .window_identifiers = view->window_identifiers,
        .rssi_min = view->rssi_min,
        .rssi_max = view->rssi_max,
        .last_ack = view->last_ack,
    };
    if (epaper_card_show(&card) == ESP_OK) {
        s_last_view = *view;
        s_have_view = true;
        s_last_had_window = view->has_window;
        s_last_refresh_ms = now;
    }
}

esp_err_t cp_board_start_diagnostic_ui(void) { return ESP_ERR_NOT_SUPPORTED; }

void cp_board_diagnostic_input(const cp_input_event_t *event) { (void)event; }
