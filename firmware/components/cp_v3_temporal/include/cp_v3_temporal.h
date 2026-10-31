#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* Local, volatile observation state. No radio/storage/network or wire format.
 * A single worker owns all calls. Caller-owned arena may be in PSRAM; it is NOT
 * durable. Address/type keys never appear in event or history snapshots. */
#define CP_V3_TEMPORAL_MAX_TRACKS 512u
#define CP_V3_TEMPORAL_HISTORY_MS 600000u
#define CP_V3_TEMPORAL_DEFAULT_SLICE_MS 2000u

typedef enum {
    CP_V3_TEMPORAL_OK, CP_V3_TEMPORAL_INVALID, CP_V3_TEMPORAL_NO_MEMORY,
    CP_V3_TEMPORAL_NOT_FOUND, CP_V3_TEMPORAL_LATE,
    CP_V3_TEMPORAL_BACKPRESSURE, CP_V3_TEMPORAL_ENTROPY_FAILED,
    CP_V3_TEMPORAL_EXHAUSTED
} cp_v3_temporal_result_t;
typedef enum { CP_V3_TEMPORAL_OPEN, CP_V3_TEMPORAL_CLOSED,
    CP_V3_TEMPORAL_CENSORED } cp_v3_temporal_event_state_t;
typedef enum {
    CP_V3_TEMPORAL_SNAPSHOT, CP_V3_TEMPORAL_OBSERVED_GAP,
    CP_V3_TEMPORAL_TIMEOUT, CP_V3_TEMPORAL_CAPACITY,
    CP_V3_TEMPORAL_CLOCK_CHANGE, CP_V3_TEMPORAL_CONFIG_CHANGE,
    CP_V3_TEMPORAL_PLACEMENT_CHANGE, CP_V3_TEMPORAL_REBOOT,
    CP_V3_TEMPORAL_LEASE_EXPIRED, CP_V3_TEMPORAL_SCAN_GAP,
    CP_V3_TEMPORAL_LATE_REPORT
} cp_v3_temporal_reason_t;
enum {
    CP_V3_TEMPORAL_HISTORY_TRUNCATED = 1u,
    CP_V3_TEMPORAL_SCAN_GAPS = 2u,
    CP_V3_TEMPORAL_TABLE_LOSS = 4u,
    CP_V3_TEMPORAL_IS_CENSORED = 8u,
    CP_V3_TEMPORAL_REVISION_GAP = 16u
};
typedef struct {
    uint64_t mono_ms, utc_ms;
    uint32_t clock_epoch, uncertainty_ms;
    bool utc_known;
} cp_v3_temporal_time_t;
typedef struct {
    /* Opaque caller-assigned generations, not physical identifiers. Change
     * these at their real boundary; each must be nonzero. */
    uint64_t boot_generation, config_generation, placement_generation;
} cp_v3_temporal_context_t;
typedef struct {
    uint16_t max_tracks, max_open_events, max_terminal_events;
    uint16_t slice_ms; /* 1000, 2000 (default), or 5000. */
    uint32_t history_ms; /* <=600000, positive exact multiple of slice_ms. */
    uint32_t gap_ms, max_event_ms;
} cp_v3_temporal_config_t;
typedef struct {
    size_t total_bytes, state_bytes, tracks_bytes, slices_bytes;
    size_t history_bytes, active_events_bytes, terminal_events_bytes;
    uint16_t history_slices, cell_bytes;
} cp_v3_temporal_memory_t;
typedef bool (*cp_v3_temporal_entropy_fn)(void *, uint8_t random_id[16]);
typedef struct cp_v3_temporal cp_v3_temporal_t;
typedef struct { uint16_t slot; uint32_t generation; } cp_v3_temporal_track_t;
typedef enum { CP_V3_TEMPORAL_UNKNOWN, CP_V3_TEMPORAL_ABSENT,
    CP_V3_TEMPORAL_PRESENT } cp_v3_temporal_presence_t;
typedef struct {
    uint64_t slice_start_mono_ms, slice_end_mono_ms;
    uint16_t coverage_ms, gap_ms;
    bool finalized, before_tracking, counter_saturated;
    cp_v3_temporal_presence_t presence;
    uint16_t reports, rssi_n;
    int32_t rssi_sum;
    int8_t rssi_min, rssi_max; /* meaningful only when rssi_n>0. */
} cp_v3_temporal_history_t;
typedef struct {
    uint8_t event_id[16]; /* random UUIDv4; never derived from an address. */
    uint32_t event_seq, revision, quality_mask;
    cp_v3_temporal_event_state_t state;
    cp_v3_temporal_reason_t reason;
    cp_v3_temporal_context_t context;
    cp_v3_temporal_time_t start,last_seen,observed_until,end; /* end unused while open. */
    uint64_t reports, present_slices, absent_slices, coverage_ms, rssi_n;
    int64_t rssi_sum;
    int8_t rssi_min, rssi_max; /* meaningful only when rssi_n>0. */
} cp_v3_temporal_event_t;
typedef struct {
    uint64_t reports, late_reports, invalid_reports, identity_evictions;
    uint64_t event_evictions, entropy_failures, rejected_reports;
    uint64_t backpressure_occurrences, counter_overflows, event_suppressed_reports;
    uint16_t tracks, open_events, pending_terminals, terminal_events;
    uint16_t history_slices;
    bool coverage_known, blocked;
} cp_v3_temporal_status_t;

cp_v3_temporal_config_t cp_v3_temporal_default_config(void);
/* Exact, ABI-specific arena requirement, including all alignment. Zero/false
 * means invalid config. The arena must be aligned to memory_alignment(). */
size_t cp_v3_temporal_memory_bytes(const cp_v3_temporal_config_t *);
size_t cp_v3_temporal_memory_alignment(void);
bool cp_v3_temporal_memory_layout(const cp_v3_temporal_config_t *, cp_v3_temporal_memory_t *);
cp_v3_temporal_result_t cp_v3_temporal_init(void *arena, size_t bytes,
    const cp_v3_temporal_config_t *, const cp_v3_temporal_context_t *,
    cp_v3_temporal_time_t, cp_v3_temporal_entropy_fn, void *entropy_context,
    cp_v3_temporal_t **out);

/* Coverage starts UNKNOWN. Declare KNOWN only when the worker can account for
 * continuous scanner/ingress coverage. A known interval does not establish
 * complete RF capture or a count of physical devices. Advance closes intervals
 * under the current coverage mode; report() advances first, so all input must
 * be timestamp ordered. Unknown coverage immediately censors open episodes. */
cp_v3_temporal_result_t cp_v3_temporal_set_coverage(cp_v3_temporal_t *,
    cp_v3_temporal_time_t, bool known);
cp_v3_temporal_result_t cp_v3_temporal_advance(cp_v3_temporal_t *, cp_v3_temporal_time_t);
/* A pause/loss censors before advancing unknown coverage, but retains local
 * keys and rolling history. Real clock/config/place/reboot uses boundary(). */
cp_v3_temporal_result_t cp_v3_temporal_censor(cp_v3_temporal_t *,
    cp_v3_temporal_time_t,cp_v3_temporal_reason_t);
cp_v3_temporal_result_t cp_v3_temporal_report(cp_v3_temporal_t *, cp_v3_temporal_time_t,
    uint8_t address_type, const uint8_t address[6], bool rssi_known, int16_t rssi,
    cp_v3_temporal_track_t *track);
/* Explicit clock/config/place/reboot/lease boundary: censor old open episodes,
 * then discard only volatile address/history state. Terminal snapshots remain.
 * Clock/reboot boundaries may restart monotonic time. Other boundaries may not.
 * Entropy IDs and event sequence never reset during this arena's lifetime. */
cp_v3_temporal_result_t cp_v3_temporal_boundary(cp_v3_temporal_t *,
    cp_v3_temporal_time_t, const cp_v3_temporal_context_t *, cp_v3_temporal_reason_t);

/* Ordered history: index 0 is oldest retained slice, count-1 is current.
 * Partial/unknown-coverage non-presence is UNKNOWN, never inferred ABSENT.
 * A generation handle fails after eviction; it cannot alias a replacement key.
 * None of these reads, nor an upload, advances or clears history/events. */
bool cp_v3_temporal_lookup(const cp_v3_temporal_t *, uint8_t address_type,
    const uint8_t address[6], cp_v3_temporal_track_t *);
uint16_t cp_v3_temporal_history_count(const cp_v3_temporal_t *);
cp_v3_temporal_result_t cp_v3_temporal_history_at(const cp_v3_temporal_t *,
    cp_v3_temporal_track_t, uint16_t index, cp_v3_temporal_history_t *);
/* Read-only local inspection, NOT a frozen upload revision: revision is zero
 * before first publication, or the last publication number with newer totals.
 * Slot iteration is bounded by config.max_open_events. */
cp_v3_temporal_result_t cp_v3_temporal_event_at(const cp_v3_temporal_t *,
    uint16_t slot, cp_v3_temporal_event_t *);
/* Explicit optional open publication. Assigns the next revision only if state
 * changed; repeated unchanged calls return identical snapshots. Caller copies
 * and freezes this value before release/retry. Terminal-only is the default;
 * its first terminal revision is 1. This never clears history or counters. */
cp_v3_temporal_result_t cp_v3_temporal_event_publish(cp_v3_temporal_t *,
    uint16_t slot, cp_v3_temporal_event_t *);
cp_v3_temporal_result_t cp_v3_temporal_terminal_peek(const cp_v3_temporal_t *,
    cp_v3_temporal_event_t *);
/* Release only after caller has safely copied/frozen the exact terminal. This
 * is NOT an HTTP receipt or a durability claim. No terminal is overwritten:
 * a full output pool retains pending terminals in active slots and pauses
 * reports. Drain terminals, then explicitly resume known coverage. */
cp_v3_temporal_result_t cp_v3_temporal_terminal_release(cp_v3_temporal_t *,
    const uint8_t event_id[16], uint32_t event_seq, uint32_t revision);
void cp_v3_temporal_status(const cp_v3_temporal_t *, cp_v3_temporal_status_t *);
/* Wipes address/history/event RAM. Caller owns arena lifetime and persistence. */
void cp_v3_temporal_clear(cp_v3_temporal_t *);
