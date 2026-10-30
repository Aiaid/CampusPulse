#pragma once
#include <stdbool.h>
#include <stdint.h>
#include "lvgl.h"
#include "raw_setup_view.h"

typedef struct {
    char state[24];
    uint64_t received, written, synced, dropped, invalid, free_bytes;
    uint32_t reports_per_second;
    bool free_known;
    uint8_t page;
    uint64_t total_bytes, uptime_s, recent_received, recent_written;
    uint32_t internal_free, internal_total, psram_free, psram_total;
    uint32_t buffer_used, buffer_capacity, storage_errors;
    bool memory_known, psram_known, battery_known;
    int battery_percent;
    uint16_t battery_mv;
    bool wifi_enabled, wifi_connected, wifi_rssi_known;
    int wifi_rssi;
    char wifi_ssid[33], ip[16];
    uint32_t report_bins[10];
    int16_t rssi_bins[10], rssi_min, rssi_mean, rssi_max;
    bool rssi_bin_known[10], rssi_known;
    uint32_t rssi_samples;
    bool clock_known;
    bool clock_calibrated;
    uint64_t utc_epoch;
    bool setup_available, setup_stopping;
    raw_setup_state_t setup_state;
    int32_t setup_error;
} raw_display_snapshot_t;

/* Caller owns LVGL and invokes these from its sole LVGL task. */
void raw_ui_init(lv_display_t *display);
void raw_ui_update(const raw_display_snapshot_t *snapshot);
