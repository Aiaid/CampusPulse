#pragma once
#include "cp_v3_capture.h"
#include "cp_v3_control.h"

/* Integration README (host-testable adapter; deliberately not wired to main):
 * One board worker owns this zero-initialized object and all calls. Keep it
 * outside the worker stack. prepare allocates through the shared collector,
 * paused, with raw == NULL; it grants no observation authority. The real board
 * must supply measured PSRAM/internal floors and its trusted clock/entropy.
 * This adapter does not enable te_v3_runtime_ready(), register capabilities,
 * verify receipts, allocate a durable queue, or claim hardware acceptance.
 *
 * Pass ONLY the control instance whose actual applied ACK and independent
 * lease receipts were verified by cp_v3_control_ack_receipt and
 * cp_v3_control_lease_receipt. start/maintain call the real shared permissions
 * function and check that state/config/scope still match. Never manufacture a
 * control instance or use mocks on device. Maintain frequently, passing actual
 * bounded durable-queue admission; false pauses capture. The collector also
 * enforces the frozen monotonic deadline between board-worker calls.
 * Prepared config.context.config_generation must equal the applied assignment
 * generation. The first successful start freezes scope and scan settings for
 * this instance. A policy/place generation change requires an explicit pause
 * and observation boundary, then a separately reviewed collector reprepare or
 * controlled context-update integration; this adapter provides no such update.
 * Shared prepare is boot-lifetime one-shot, so do not reset/reprepare this object
 * in the current boot to evade that requirement.
 *
 * Peek copies remain volatile. Freeze exact bytes/scope/identity, commit and
 * readback-verify durable queue storage, then release the EXACT peeked value.
 * This helper cannot prove durability. A failed release retains its copy for
 * reconciliation. Never reset the bridge to discard pending records. No I/O
 * occurs here; main/CMake/host runner are intentionally unchanged.
 */
typedef struct {
    cp_v3_capture_t *collector;
    cp_v3_capture_config_t config;
    cp_v3_scope_t scope;
    cp_v3_capture_window_t held_window;
    cp_v3_capture_event_t held_event;
    uint64_t deadline_mono_ms;
    uint32_t span_seq,scan_interval_units,scan_window_units;
    bool attempted, prepared, started, active, faulted, window_held, event_held;
    esp_err_t last_error;
} te_v3_shared_capture_t;

/* Nonzero headroom floors are mandatory; raw callbacks are rejected. prepare
 * is one-shot even on failure, matching the shared collector boot lifetime. */
esp_err_t te_v3_shared_capture_prepare(te_v3_shared_capture_t *,const cp_v3_capture_config_t *);
esp_err_t te_v3_shared_capture_start(te_v3_shared_capture_t *,cp_v3_control_t *,
    cp_v3_time_t now,uint32_t next_window_seq,bool queue_ready);
/* Recheck authority, scope, full prepare config and queue before any deadline
 * extension. A shorter/expired/overflowing deadline pauses, never extends.
 * No automatic resume after queue backpressure or an authority boundary. */
esp_err_t te_v3_shared_capture_maintain(te_v3_shared_capture_t *,cp_v3_control_t *,
    cp_v3_time_t now,bool queue_ready);
esp_err_t te_v3_shared_capture_pause(te_v3_shared_capture_t *,cp_v3_temporal_reason_t,uint32_t timeout_ms);
bool te_v3_shared_capture_window(te_v3_shared_capture_t *,cp_v3_capture_window_t *);
bool te_v3_shared_capture_window_release(te_v3_shared_capture_t *,const cp_v3_capture_window_t *);
bool te_v3_shared_capture_event(te_v3_shared_capture_t *,cp_v3_capture_event_t *);
bool te_v3_shared_capture_event_release(te_v3_shared_capture_t *,const cp_v3_capture_event_t *);
