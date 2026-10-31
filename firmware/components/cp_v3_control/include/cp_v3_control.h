#pragma once
#include "cp_v3_evidence.h"

#define CP_V3_CONTROL_JSON_MAX 8192u
#define CP_V3_CONTROL_CAP_MAX 4096u
#define CP_V3_CONTROL_ACK_MAX 2048u
#define CP_V3_CONTROL_TOKENS 512u
#define CP_V3_SMALL_PRODUCER "cp-v3-small/1"
typedef enum { CP_V3_TEMPORAL_REPORT_OFF, CP_V3_TEMPORAL_REPORT_TERMINAL,
    CP_V3_TEMPORAL_REPORT_REVISIONS } cp_v3_control_report_mode_t;
typedef struct {
    bool rolling;
    uint32_t slice_ms, history_ms, max_event_ms, gap_ms, min_update_ms;
    uint16_t max_tracks, max_open_events;
    cp_v3_control_report_mode_t report_mode;
} cp_v3_control_temporal_t;
typedef struct {
    bool enabled;
    uint64_t max_segment_bytes, max_total_bytes, min_free_bytes;
    uint32_t sync_interval_ms;
} cp_v3_control_raw_t;
typedef enum {
    CP_V3_CONTROL_OK, CP_V3_CONTROL_INVALID, CP_V3_CONTROL_UNSUPPORTED,
    CP_V3_CONTROL_HASH_MISMATCH, CP_V3_CONTROL_BINDING_MISMATCH,
    CP_V3_CONTROL_NOT_CURRENT, CP_V3_CONTROL_WAIT, CP_V3_CONTROL_BOUNDARY,
    CP_V3_CONTROL_RESOURCE, CP_V3_CONTROL_STATE, CP_V3_CONTROL_EXPIRED
} cp_v3_control_result_t;
typedef enum {
    CP_V3_CONTROL_EMPTY, CP_V3_CONTROL_INITIALIZED, CP_V3_CONTROL_REGISTERING,
    CP_V3_CONTROL_REGISTERED, CP_V3_CONTROL_OFFERED, CP_V3_CONTROL_ACK_PENDING,
    CP_V3_CONTROL_APPLIED, CP_V3_CONTROL_FAILED, CP_V3_CONTROL_PAUSED
} cp_v3_control_state_t;
typedef struct {
    uint32_t closed_window_seq, closed_segment_seq;
    bool window_open, segment_open;
} cp_v3_boundary_t;
typedef struct {
    cp_v3_scope_t scope;
    cp_v3_limits_t evidence;
    uint32_t scan_interval_units, scan_window_units, bin_ms;
    bool tf_queue; /* false=flash_journal; neither requires TF in shared logic. */
    uint64_t queue_max_bytes, control_reserve_bytes, feature_reserve_bytes, status_reserve_bytes;
    uint32_t queue_max_items, control_reserve_items, feature_reserve_items, status_reserve_items, high_water_percent;
    uint64_t working_bytes, storage_write_bytes_per_day, max_upload_bytes_per_day;
    uint32_t source_retention_hours, derived_retention_hours;
    uint32_t retry_min_ms, retry_max_ms, retry_max_attempts;
    uint32_t lease_ms, after_window_seq, after_segment_seq;
    uint64_t not_before_utc_ms, expires_utc_ms, accept_until_utc_ms;
    /* Small statistics never narrows capacity through legacy evidence limits. */
    bool statistics, collection_enabled, mobile_research, candidate_events, drain_frozen, mqtt_tls;
    uint16_t stats_max_addresses;
    uint32_t window_ms, max_body_bytes;
    uint64_t window_reserve_bytes, event_reserve_bytes;
    uint32_t window_reserve_items, event_reserve_items;
    cp_v3_control_temporal_t temporal;
    cp_v3_control_raw_t local_raw;
} cp_v3_trial_policy_t;
typedef enum { CP_V3_APPLY_OK, CP_V3_APPLY_UNSUPPORTED, CP_V3_APPLY_BOUNDARY_FAILED,
    CP_V3_APPLY_RESOURCE_EXHAUSTED, CP_V3_APPLY_STORAGE_FAILED, CP_V3_APPLY_INTERNAL_ERROR } cp_v3_apply_result_t;
/* Must actually check/reserve configured resources and leave scanner paused.
 * Success freezes an applied ACK, but grants no capture/upload permission until
 * its exact committed server receipt is matched. Boundary is checked afterward.
 */
typedef cp_v3_apply_result_t (*cp_v3_actual_apply_fn)(void *, const cp_v3_trial_policy_t *, cp_v3_boundary_t *);
typedef struct {
    bool collection, uplink, preserve_unacknowledged;
    bool local_raw, frozen_only;
    uint64_t deadline_utc_ms, deadline_mono_ms;
    cp_v3_control_result_t reason;
} cp_v3_control_permissions_t;

/* Caller-owned bounded parsing workspace; allocate outside callback/task stack.
 * Treat token internals as private. No heap, credentials, I/O or board APIs. */
typedef struct {
    uint16_t start, end, key_start, key_end, first, next;
    uint8_t kind;
    uint64_t number;
} cp_v3_control_token_t;
typedef struct {
    cp_v3_control_token_t tokens[CP_V3_CONTROL_TOKENS];
    const uint8_t *input;
    size_t length, position;
    uint16_t count;
    bool valid;
    char canonical[CP_V3_CONTROL_JSON_MAX + 64];
} cp_v3_control_workspace_t;
typedef struct {
    cp_v3_control_state_t state;
    cp_v3_trial_policy_t policy;
    char node_id[65], boot_id[37], capability_sha256[65];
    char capability_json[CP_V3_CONTROL_CAP_MAX], policy_json[CP_V3_CONTROL_JSON_MAX];
    char registration_json[CP_V3_CONTROL_JSON_MAX], acknowledgement_json[CP_V3_CONTROL_ACK_MAX];
    size_t capability_length, policy_length, registration_length, acknowledgement_length;
    uint32_t registration_seq, apply_seq;
    uint64_t registered_uptime_ms, registered_at_utc_ms, acknowledged_at_utc_ms;
    uint64_t capability_issued_utc_ms, capability_expires_utc_ms;
    uint64_t capability_working_bytes, capability_write_bytes, capability_queue_bytes, capability_tf_bytes;
    uint32_t capability_queue_items, capability_addresses, capability_bins, capability_window_ms;
    uint32_t capability_reports, capability_evidence_bytes, capability_interval_min, capability_interval_max;
    uint8_t capability_fields;
    bool capability_tf_queue;
    uint64_t applied_at_utc_ms, deadline_utc_ms, deadline_mono_ms, last_mono_ms;
    uint32_t clock_epoch;
    cp_v3_boundary_t acknowledgement_boundary;
    cp_v3_apply_result_t apply_result;
    cp_v3_control_workspace_t *workspace;
    cp_v3_sha256_fn sha256;
    void *hash_context;
    bool small_statistics, capability_events, capability_local_raw, capability_temporal, capability_mqtt_tls;
    uint32_t capability_body_bytes, capability_raw_sync_ms;
    uint64_t capability_raw_segment_bytes;
    cp_v3_control_temporal_t temporal_cap;
    uint8_t capability_slices, capability_report_modes;
    char lease_json[CP_V3_CONTROL_ACK_MAX];
    size_t lease_length;
    uint32_t contact_seq, pending_contact_seq, span_seq;
    uint64_t contact_uptime_ms, pending_uptime_ms, lease_server_utc_ms;
    uint64_t capture_span_start_utc_ms;
    bool lease_pending, lease_contiguous;
    uint64_t trusted_utc_lower_ms;
    uint64_t staged_from_generation;
    uint64_t last_applied_generation;
} cp_v3_control_t;

cp_v3_control_result_t cp_v3_control_init(cp_v3_control_t *, cp_v3_control_workspace_t *,
    const char *node, const char *boot, const void *capabilities_json, size_t length,
    cp_v3_time_t now, cp_v3_sha256_fn, void *);
cp_v3_control_result_t cp_v3_control_registration(cp_v3_control_t *, uint32_t registration_seq,
    uint64_t uptime_ms, const char **bytes, size_t *length);
cp_v3_control_result_t cp_v3_control_registration_receipt(cp_v3_control_t *,
    const void *json, size_t length, cp_v3_time_t now);
cp_v3_control_result_t cp_v3_control_offer(cp_v3_control_t *, const void *config_response,
    size_t length, cp_v3_time_t now);
cp_v3_control_result_t cp_v3_control_apply(cp_v3_control_t *, cp_v3_time_t now,
    cp_v3_boundary_t boundary, uint32_t apply_seq, cp_v3_actual_apply_fn, void *);
const char *cp_v3_control_ack_bytes(const cp_v3_control_t *, size_t *length);
cp_v3_control_result_t cp_v3_control_ack_receipt(cp_v3_control_t *, const void *json,
    size_t length, cp_v3_time_t now);
cp_v3_control_permissions_t cp_v3_control_permissions(cp_v3_control_t *, cp_v3_time_t now);
/* Explicit lease only. Retries return identical bytes; a replay never extends
 * authority. A fresh receipt after a gap starts a new capture span. */
cp_v3_control_result_t cp_v3_control_lease_request(cp_v3_control_t *, uint32_t contact_seq,
    uint64_t uptime_ms, const char **bytes, size_t *length);
cp_v3_control_result_t cp_v3_control_lease_receipt(cp_v3_control_t *, const void *, size_t, cp_v3_time_t);
/* Caller owns separate candidate state. Stage does not replace active policy.
 * Activation requires closed boundary and invokes real allocation while paused.
 * Frozen durable queues and boot-global stream sequences are caller-owned and
 * MUST survive activation. Candidate and active share only parsing workspace. */
cp_v3_control_result_t cp_v3_control_stage(cp_v3_control_t *, cp_v3_control_t *candidate,
    const void *config_response, size_t, cp_v3_time_t);
cp_v3_control_result_t cp_v3_control_activate_staged(cp_v3_control_t *, cp_v3_control_t *candidate,
    cp_v3_time_t, cp_v3_boundary_t, uint32_t apply_seq, cp_v3_actual_apply_fn, void *);
/* Caller has stopped scanning and closed/censored observations before supplying
 * a new trusted UTC map. Strictly advancing epoch; no lease renewal. */
cp_v3_control_result_t cp_v3_control_clock_boundary(cp_v3_control_t *, cp_v3_time_t, cp_v3_boundary_t);
/* Pure historical small-control verifier. Exact body SHA and every request
 * field must match committed receipt; this never grants observation authority. */
cp_v3_control_result_t cp_v3_control_match_frozen_receipt(cp_v3_control_workspace_t *,
    const cp_v3_scope_t *, const void *body, size_t body_length,
    const void *receipt, size_t receipt_length, cp_v3_sha256_fn, void *);
void cp_v3_control_clear(cp_v3_control_t *);
