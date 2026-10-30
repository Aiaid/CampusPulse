#pragma once
#include <stdbool.h>
#include <stdint.h>

#define RAW_ACTIVITY_BINS 10u
#define RAW_ACTIVITY_BIN_US 6000000ULL
typedef struct {
    bool valid;
    uint64_t epoch;
    uint32_t reports, written, rssi_samples;
    int64_t rssi_sum;
    int16_t rssi_min, rssi_max;
} raw_activity_bin_t;
typedef struct {
    raw_activity_bin_t bins[RAW_ACTIVITY_BINS];
    uint64_t first_us, latest_epoch;
    bool started;
} raw_activity_t;
typedef struct {
    uint32_t reports[RAW_ACTIVITY_BINS];
    int16_t rssi[RAW_ACTIVITY_BINS];
    bool rssi_known[RAW_ACTIVITY_BINS];
    uint64_t received, written;
    uint32_t rate, rssi_samples;
    int16_t rssi_min, rssi_mean, rssi_max;
    bool signal_known;
} raw_activity_view_t;
/* Caller serializes accesses. No allocation or raw address/payload retention. */
void raw_activity_report(raw_activity_t *a, uint64_t mono_us, int rssi);
void raw_activity_written(raw_activity_t *a, uint64_t receive_us);
void raw_activity_read(const raw_activity_t *a, uint64_t now_us, raw_activity_view_t *view);
