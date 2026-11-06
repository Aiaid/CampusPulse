#pragma once
#include "cp_v3_stats.h"
#include "cp_v3_temporal.h"
#include "cp_v3_evidence.h"
#include "esp_err.h"

/* ESP-NimBLE worker adapter; one instance/board boot. Stats/history have no
 * network/TF dependency. All large buffers use explicit PSRAM with no fallback.
 * The board owns network, clock, raw writer and durable upload queues. */
typedef bool (*cp_v3_capture_clock_fn)(void *,uint64_t mono_ms,cp_v3_temporal_time_t *);
/* Called only on the collector worker; MUST only copy into a separate bounded
 * raw-writer queue and return. It must not perform disk/network operations. */
typedef bool (*cp_v3_capture_raw_fn)(void *,const cp_v3_stats_report_t *);
typedef struct {
    cp_v3_stats_config_t statistics;
    bool temporal_enabled,report_events;
    cp_v3_temporal_config_t temporal;
    cp_v3_temporal_context_t context;
    uint16_t report_slots,window_slots,event_slots;
    uint32_t min_internal_free,min_internal_largest;
    uint32_t min_psram_free,min_psram_largest;
    uint32_t collector_stack_bytes; /* 0 selects8192. */
    uint32_t stop_after_windows; /* Explicit controlled trial only;0continuous. */
    cp_v3_capture_clock_fn clock;
    cp_v3_temporal_entropy_fn entropy;
    cp_v3_capture_raw_fn raw;
    void *context_pointer;
} cp_v3_capture_config_t;
typedef struct {
    cp_v3_scope_t scope;
    uint32_t window_seq;
    cp_v3_temporal_time_t end_time;
    cp_v3_stats_snapshot_t statistics;
    cp_v3_temporal_status_t temporal;
} cp_v3_capture_window_t;
typedef struct {cp_v3_scope_t scope;cp_v3_temporal_event_t event;uint16_t slice_ms;bool report_allowed;} cp_v3_capture_event_t;
typedef struct {
    uint64_t callback_reports,callback_drops,invalid_reports,raw_reports,raw_accepted,raw_drops,ignored_reports;
    uint64_t windows_closed,window_backpressure,event_backpressure;
    uint32_t last_closed_window_seq;
    uint16_t window_handoffs,event_handoffs;
    bool quiescent; /* stopped and every handoff/terminal has been released */
    uint64_t source_ledger_overflow,scan_failures,ble_resets,authority_pauses,events_consumed_local;
    size_t statistics_bytes,temporal_bytes,report_bytes,window_bytes,event_bytes,ledger_bytes,index_bytes;
    uint16_t statistics_alignment,statistics_alignment_remainder;
    uint16_t temporal_alignment,temporal_alignment_remainder; /* UINT16_MAX before a successful allocation. */
    uint32_t collector_stack_min;
    uint32_t internal_free,internal_largest,psram_free,psram_largest;
    bool prepared,running,paused,failed;
    bool ble_ready;
    bool bounded_complete;
    char failure_stage[32];
    esp_err_t last_error;
    cp_v3_temporal_status_t temporal;
} cp_v3_capture_status_t;
typedef struct cp_v3_capture cp_v3_capture_t;

/* Must be called after cryptographic early-boot entropy has initialized IDs.
 * Prepares scanner paused and allocates actual stats/history/report pools.
 * No capture permission is granted here. Never deinitializes observer-only
 * NimBLE (IDF5.5.3 has a known deinit assertion). Lifetime ends on reboot. */
esp_err_t cp_v3_capture_prepare(const cp_v3_capture_config_t *,cp_v3_capture_t **);
/* Call only after exact committed applied/lease receipt, with the existing
 * conservative monotonic deadline. Initial generation must match prepare's
 * actual context. Resume permits only the same complete scope; a changed policy
 * first requires a successful paused rebind. Resume cannot reuse a closed window
 * sequence. Scope is copied, never synthesized; board stream-sequence allocation
 * remains boot-global. */
esp_err_t cp_v3_capture_start(cp_v3_capture_t *,const cp_v3_scope_t *,
    uint32_t next_window_seq,uint32_t interval_units,uint32_t window_units,
    uint64_t capture_deadline_mono_ms);
/* Worker-owned scope boundary only: no radio start, allocation or authorization.
 * Caller has paused/censored capture, durably drained every old handoff, parked
 * its storage owner and checked that all allocated/operational resources match.
 * Node, boot and boot_generation must stay unchanged. Assignment generation must
 * increase and equal context.config_generation. Placement generation increases
 * for a changed placement/dataset; otherwise it stays unchanged. All sequences,
 * counters, event identity state and finite-trial allowance survive the rebind.
 * Busy state/old handoffs are rejected. A terminal discovered at the boundary
 * retains its OLD scope and context; drain it and retry after INVALID_STATE.
 * timeout_ms must be nonzero. TIMEOUT is an uncertain completion: keep capture
 * and storage paused; it never authorizes start. ESP_OK means the worker has
 * installed the new scope, but start still requires its real committed ACK.
 * This does not refresh capability/clock authority or support resource changes. */
esp_err_t cp_v3_capture_rebind(cp_v3_capture_t *,const cp_v3_scope_t *,
    const cp_v3_temporal_context_t *,uint32_t timeout_ms);
/* Same closed-boundary contract, with a compiled ruleset for the next window.
 * No cadence/capacity/resource change is supported. Old snapshots keep their
 * original ruleset. rebind() above preserves the current compiled ruleset. */
esp_err_t cp_v3_capture_rebind_rules(cp_v3_capture_t *,const cp_v3_scope_t *,
    const cp_v3_temporal_context_t *,const char *rules_version,uint32_t timeout_ms);
esp_err_t cp_v3_capture_deadline(cp_v3_capture_t *,uint64_t capture_deadline_mono_ms);
/* Pauses scanner, closes a partial window and censors observation episodes.
 * Pending snapshots stay in bounded handoff queues. timeout0 is nonblocking. */
esp_err_t cp_v3_capture_pause(cp_v3_capture_t *,cp_v3_temporal_reason_t,uint32_t timeout_ms);
/* Peek only. Caller freezes exact body+identity and commits durable storage
 * before release; repeated peeks return the same snapshot. The handoff itself
 * remains volatile, with explicit backpressure; it is not durable custody. */
bool cp_v3_capture_window(cp_v3_capture_t *,cp_v3_capture_window_t *,uint32_t timeout_ms);
bool cp_v3_capture_window_release(cp_v3_capture_t *,uint32_t window_seq,uint64_t generation);
bool cp_v3_capture_event(cp_v3_capture_t *,cp_v3_capture_event_t *,uint32_t timeout_ms);
bool cp_v3_capture_event_release(cp_v3_capture_t *,const uint8_t event_id[16],uint32_t revision);
void cp_v3_capture_status(cp_v3_capture_t *,cp_v3_capture_status_t *);
/* Available even if the first allocation/floor check failed. Sanitized stage
 * labels and measured heap values only; no addresses, captures or credentials. */
void cp_v3_capture_prepare_status(cp_v3_capture_status_t *);
