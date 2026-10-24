#pragma once
#include <stdbool.h>
#include <stdint.h>
#define CP_COLLECT_ADDRESSES 64u
#define CP_COLLECT_BINS 16u
#define CP_COLLECT_RAW 4u
typedef enum {
    CP_RAW_OFF,
    CP_RAW_SELECTED,
    CP_RAW_INTENTIONAL,
    CP_RAW_PRESSURE
} cp_raw_disposition_t;
typedef struct {
    uint64_t mono_ms;
    uint32_t report_seq;
    uint8_t address[6], address_type, report_type, payload_length, payload[31];
    int16_t rssi;
    cp_raw_disposition_t raw;
} cp_report_t;
typedef struct {
    bool used;
    uint8_t address[6], address_type;
    uint32_t reports, adv, scan_responses, first_ms, last_ms, samples;
    int16_t rssi_min, rssi_max;
    int64_t rssi_sum;
    uint32_t bins[CP_COLLECT_BINS];
} cp_address_summary_t;
typedef struct {
    uint64_t start_ms;
    uint32_t window_ms, bin_ms, window_seq, address_capacity;
    uint32_t reports_seen, reports_aggregated, aggregation_drops, adv, scan_responses;
    uint32_t rssi_samples;
    int16_t rssi_min, rssi_max;
    int64_t rssi_sum;
    bool address_overflow, raw_enabled;
    uint32_t summary_drops, selected, intentional, pressure, raw_drops;
    unsigned address_count, raw_count;
    cp_address_summary_t addresses[CP_COLLECT_ADDRESSES];
    cp_report_t raw[CP_COLLECT_RAW];
} cp_collect_t;
bool cp_collect_begin(cp_collect_t *, uint64_t start_ms, uint32_t window_ms, uint32_t bin_ms,
                      uint32_t seq, unsigned max_addresses, bool raw_enabled);
bool cp_collect_observe(cp_collect_t *, const cp_report_t *);
/* Loss buckets preserve selection accounting at callback ingress even when the
 * bounded report queue is full. No missing reports are relabeled intentional. */
bool cp_collect_losses(cp_collect_t *, uint32_t aggregation_drops, uint32_t selected_drops,
                       uint32_t intentional, uint32_t pressure);
