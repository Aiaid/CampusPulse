#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* Worker-only, allocation-free observation/snapshot. No network, TF, JSON or
 * people estimate. BLE callbacks only copy reports into their own bounded queue.
 * This core never owns/clears an external classifier's temporal history. */
#define CP_V3_STATS_MAX_CAPACITY 512u
#define CP_V3_STATS_MAX_BINS 12u
#define CP_V3_STATS_PAYLOAD_MAX 1650u
#define CP_V3_STATS_VERSION "cp-v3-stats/1"
#define CP_V3_STATS_RULESET "unclassified-v1"
#define CP_V3_STATS_HEAT_VERSION "address-bin-presence/1"
typedef enum {
    CP_V3_STATS_PHONE_RELATED, CP_V3_STATS_E_BIKE_RELATED, CP_V3_STATS_CAR_RELATED,
    CP_V3_STATS_OTHER, CP_V3_STATS_UNKNOWN, CP_V3_STATS_CONFLICTING,
    CP_V3_STATS_CLASS_COUNT
} cp_v3_stats_class_t;
typedef enum { CP_V3_STATS_NO_VERDICT, CP_V3_STATS_CANDIDATE, CP_V3_STATS_VERIFIED } cp_v3_stats_strength_t;
enum {
    CP_V3_STATS_HINT_COMPANY = 1u, CP_V3_STATS_HINT_OUI = 2u,
    CP_V3_STATS_PROTOCOL = 4u, CP_V3_STATS_MODEL = 8u,
};
typedef struct {
    uint64_t seq, mono_us;
    uint8_t address[6], address_type, kind, event_type, props, data_status, sid;
    uint8_t primary_phy, secondary_phy, direct_address_type, direct_address[6];
    uint16_t periodic_interval;
    int16_t rssi, tx_power;
    const uint8_t *payload;
    size_t length;
} cp_v3_stats_report_t;
typedef struct {
    cp_v3_stats_class_t category;
    cp_v3_stats_strength_t strength;
    uint8_t evidence;
    uint32_t rule_id; /* Nonzero reviewed rule ID; company/OUI alone is rejected. */
} cp_v3_stats_verdict_t;
/* Invoked only after complete structural+AD semantic validation. Borrowed report
 * bytes are valid only until return. Versioned rules/ground truth remain caller
 * responsibilities; a true rules_verified flag is never created by this core. */
typedef cp_v3_stats_verdict_t (*cp_v3_stats_classify_fn)(void *, const cp_v3_stats_report_t *);
typedef void *(*cp_v3_stats_allocate_fn)(void *, size_t);
typedef void (*cp_v3_stats_release_fn)(void *, void *);
typedef struct {
    uint16_t capacity;
    uint32_t window_ms, bin_ms; /* Exact division, <=12bins.60s/5s and30s/5s fit. */
    const char *rules_version; /* Only unclassified-v1 is currently accepted. */
    /* Reserved extension hooks: this version rejects non-NULL classify or true
     * rules_verified. No candidate/classified count can be activated yet. */
    bool rules_verified;
    cp_v3_stats_classify_fn classify;
    void *classify_context;
} cp_v3_stats_config_t;
typedef struct {
    bool reports_seen_known, queue_drops_known, processing_losses_known;
    uint64_t reports_seen, queue_drops, processing_losses; /* Per-window source claims. */
} cp_v3_stats_source_t;
typedef struct {
    uint64_t reports, rssi_samples;
    int64_t rssi_sum;
    int16_t rssi_min, rssi_max;
    uint16_t unique_keys; /* Deterministic heat: one address/type contribution/bin. */
    uint64_t scan_active_us, scan_paused_us, scan_unknown_us;
} cp_v3_stats_bin_t;
typedef struct {
    uint16_t capacity, unique_keys, counts[CP_V3_STATS_CLASS_COUNT];
    uint16_t candidate_keys[4], verified_keys; /* Candidates remain in primary unknown. */
    uint8_t bin_count;
    uint32_t window_ms, bin_ms, duration_ms;
    uint8_t configured_bins;
    uint64_t start_mono_us, end_mono_us, snapshot_mono_us;
    bool window_closed, estimated_total_available; /* Always false for estimates. */
    uint64_t worker_reports, malformed_reports, unsupported_reports;
    uint64_t received_reports, adv_reports, scan_response_reports;
    uint64_t fragment_more_reports, truncated_reports, unknown_status_reports;
    uint64_t address_overflow_reports, outside_window_reports, out_of_order_reports;
    uint64_t rule_rejections, unvalidated_rule_reports, rssi_unknown_reports;
    uint64_t rssi_samples;
    int64_t rssi_sum;
    int16_t rssi_min, rssi_max;
    uint64_t forward_sequence_gaps, duplicate_sequences, regressing_sequences;
    bool report_gaps_known, source_consistent, counters_saturated;
    uint64_t first_report_mono_us, last_report_mono_us, max_report_gap_us;
    uint64_t leading_gap_us, trailing_gap_us;
    uint64_t scan_active_us, scan_paused_us, scan_unknown_us, coverage_regressions;
    uint64_t scan_coverage_ms, callback_drops, aggregation_drops;
    bool received_reports_known, callback_drops_known, aggregation_drops_known;
    uint8_t quality_mask; /*1partial2clock4scan8address16callback32aggregation. */
    uint16_t scan_gap_bins, empty_report_bins;
    uint32_t heat_total; /* Sum of address-bin presences, not people/devices. */
    cp_v3_stats_source_t source;
    cp_v3_stats_bin_t bins[CP_V3_STATS_MAX_BINS];
    char rules_version[65];
    char extractor_version[32];
    bool rules_verified;
} cp_v3_stats_snapshot_t;
typedef struct cp_v3_stats cp_v3_stats_t;
typedef enum { CP_V3_STATS_OK, CP_V3_STATS_INVALID, CP_V3_STATS_OUTSIDE_WINDOW,
    CP_V3_STATS_ADDRESS_FULL, CP_V3_STATS_BAD_AD, CP_V3_STATS_UNSUPPORTED_REPORT } cp_v3_stats_result_t;

/* Includes header, hash slots, entries and alignment. Returns0for bad capacity. */
size_t cp_v3_stats_memory_bytes(uint16_t capacity);
size_t cp_v3_stats_memory_alignment(void);
uint16_t cp_v3_stats_hash_slots(uint16_t capacity);
cp_v3_stats_t *cp_v3_stats_init(void *memory, size_t bytes, const cp_v3_stats_config_t *);
cp_v3_stats_t *cp_v3_stats_alloc(const cp_v3_stats_config_t *, cp_v3_stats_allocate_fn,
    cp_v3_stats_release_fn, void *allocator_context);
void cp_v3_stats_free(cp_v3_stats_t *);
bool cp_v3_stats_begin(cp_v3_stats_t *, uint64_t start_mono_us);
cp_v3_stats_result_t cp_v3_stats_observe(cp_v3_stats_t *, const cp_v3_stats_report_t *);
/* Ordered radio-state transitions. Snapshot extrapolates only the last explicitly
 * known state, never radio activity from the presence/absence of reports. */
bool cp_v3_stats_scan_state(cp_v3_stats_t *, uint64_t mono_us, bool scanning);
bool cp_v3_stats_set_source(cp_v3_stats_t *, cp_v3_stats_source_t);
/* Default is false. Caller must establish a trusted whole-window UTC mapping;
 * this function reads no RTC and invents no time anchor. */
bool cp_v3_stats_set_clock_usable(cp_v3_stats_t *, bool usable);
/* Pure copy/derivation; does not reset this window or external history. */
bool cp_v3_stats_snapshot(const cp_v3_stats_t *, uint64_t now_mono_us, cp_v3_stats_snapshot_t *);
