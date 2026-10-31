#pragma once
#include <stdbool.h>
#include <stdint.h>

typedef enum {
    EDGE_UI_WAIT_USB, EDGE_UI_STARTING, EDGE_UI_COLLECTING, EDGE_UI_PAUSED,
    EDGE_UI_STOPPING, EDGE_UI_STOPPED_SAFE, EDGE_UI_ERROR
} edge_ui_phase_t;

/* A copied, non-identifying view. Known bits distinguish zero from unavailable.
 * raw_display_snapshot_t supplies SDK reports/rate/bins, raw written/synced,
 * storage errors, battery, memory, Wi-Fi and TF free space. report_bins are
 * display samples, not a fixed-duration history or a count of people. */
typedef struct {
    edge_ui_phase_t phase;
    bool metrics_known, capture_known, raw_policy_enabled, raw_active, raw_fault;
    bool queue_known, rate_known, history_known, last_window_known;
    bool tf_mounted, storage_fault;
    bool transport_known, mqtt_tls;
    uint16_t history_slices, tracks, open_events;
    uint32_t history_ms, windows, confirmed_windows;
    uint32_t current_pending, historical_pending, last_body_bytes;
    uint32_t upload_failures, retries, raw_queue_used, raw_queue_capacity;
    uint64_t last_window_reports, last_window_drops;
} edge_ui_metrics_t;

/* Lock and copy only; no LVGL, I/O, clock mutation or borrowed pointers.
 * raw_ui_init/update retain the existing display-owner-only LVGL interface.
 * Snapshot pages: 0 diagnostics, 1 BLE activity, 2 vehicle placeholder,
 * 3 elevator placeholder, 4 USB. The caller owns four/five-page navigation.
 * USB availability/stopping/waiting or explicit page4 enables the fifth dot. */
void edge_ui_state(const edge_ui_metrics_t *metrics);
