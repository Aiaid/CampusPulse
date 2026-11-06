#pragma once
#include "cp_v3_capture.h"
#include "cp_v3_control.h"
#include <stdbool.h>
#include <stdint.h>

#define EDGE_ONLINE_POLL_MS 3000u
#define EDGE_ONLINE_RETRY_MS 3000u
#define EDGE_ONLINE_CLOCK_AGE_MS 1200000u
typedef struct {
    bool renewal,clock_sealed,clock_adopted,ready_frozen,ready_committed,resume_pending,lease_recovery,ack_pending;
    uint32_t old_epoch,ready_seq;
    uint64_t next_poll_ms,next_lease_ms;
    size_t ready_bytes;
    char ready_body[2048];
} edge_online_state_t;
/* Aging a frozen observation is not clock/capture authority. Keep the original
 * seed's conservative drift bound even when it exceeds the 5 s live-map limit;
 * this can establish a closed past boundary without inventing a new anchor. */
static inline bool edge_online_observation_aged(cp_v3_time_t seed,uint64_t mono,uint64_t upper) {
    if(mono<seed.mono_ms||seed.uncertainty_ms>5000)return false;
    uint64_t elapsed=mono-seed.mono_ms,drift=elapsed/2000+(elapsed%2000!=0);
    if(seed.utc_ms>UINT64_MAX-elapsed||drift>UINT64_MAX-seed.uncertainty_ms)return false;
    uint64_t utc=seed.utc_ms+elapsed,error=seed.uncertainty_ms+drift;
    return utc>=error&&utc-error>=upper;
}

/* A park receipt means the final old status, not only its last window, is
 * durable. Frozen queue contents need not have uploaded to close this boundary. */
static inline bool edge_online_storage_parkable(const cp_v3_capture_status_t *s,
    bool pending_body,uint32_t durable_window,uint32_t status_window,uint32_t windows) {
    return s&&!pending_body&&s->quiescent&&!s->running&&!s->window_handoffs&&!s->event_handoffs&&
        !s->temporal.open_events&&!s->temporal.pending_terminals&&!s->temporal.terminal_events&&
        durable_window==s->last_closed_window_seq&&status_window==windows;
}
static inline bool edge_online_renew_due(cp_v3_time_t now,cp_v3_time_t original_seed,uint64_t capability_expiry) {
    return now.uncertainty_ms>=3000||now.mono_ms<original_seed.mono_ms||
        now.mono_ms-original_seed.mono_ms>=EDGE_ONLINE_CLOCK_AGE_MS||
        now.utc_ms+now.uncertainty_ms>=capability_expiry||
        capability_expiry-(now.utc_ms+now.uncertainty_ms)<=300000;
}
/* Whitelist what the already allocated scanner/raw/storage configuration can
 * reuse. Scope, validity, ruleset and activation boundary are checked separately.
 * Compare fields, never struct padding or pointers. */
static inline bool edge_online_resources_equal(const cp_v3_trial_policy_t *a,const cp_v3_trial_policy_t *b) {
    if(!a||!b)return false;
#define EQ(name) (a->name==b->name)
    return EQ(scan_interval_units)&&EQ(scan_window_units)&&EQ(bin_ms)&&EQ(tf_queue)&&
        EQ(queue_max_bytes)&&EQ(queue_max_items)&&EQ(control_reserve_bytes)&&EQ(control_reserve_items)&&
        EQ(feature_reserve_bytes)&&EQ(feature_reserve_items)&&EQ(status_reserve_bytes)&&EQ(status_reserve_items)&&
        EQ(window_reserve_bytes)&&EQ(window_reserve_items)&&EQ(event_reserve_bytes)&&EQ(event_reserve_items)&&
        EQ(high_water_percent)&&EQ(working_bytes)&&EQ(storage_write_bytes_per_day)&&EQ(max_upload_bytes_per_day)&&
        EQ(source_retention_hours)&&EQ(derived_retention_hours)&&EQ(statistics)&&EQ(collection_enabled)&&
        EQ(candidate_events)&&EQ(drain_frozen)&&EQ(mqtt_tls)&&EQ(stats_max_addresses)&&EQ(window_ms)&&EQ(max_body_bytes)&&
        EQ(temporal.rolling)&&EQ(temporal.slice_ms)&&EQ(temporal.history_ms)&&EQ(temporal.max_event_ms)&&
        EQ(temporal.gap_ms)&&EQ(temporal.min_update_ms)&&EQ(temporal.max_tracks)&&EQ(temporal.max_open_events)&&
        EQ(temporal.report_mode)&&EQ(local_raw.enabled)&&EQ(local_raw.max_segment_bytes)&&EQ(local_raw.max_total_bytes)&&
        EQ(local_raw.min_free_bytes)&&EQ(local_raw.sync_interval_ms);
#undef EQ
}
