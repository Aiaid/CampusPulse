#pragma once

#include "cp_settings.h"
#include "raw_setup_view.h"
#include <stdatomic.h>
#include <stddef.h>
#include <stdint.h>

/* Offline recorder adapter foundation for the EXISTING USB v2 settings flow.
 * It neither defines nor limits the proposed v3 raw/evidence/upload mode schema.
 * This module owns no USB reader, task, radio, driver, NVS initialization, factory
 * proof or cloud activation. The caller must provide those bindings explicitly.
 *
 * Exactly one dedicated worker calls poll. USB callbacks only begin/submit/
 * reply_finished/cancel. Their gate is try-only; callbacks never wait for worker
 * I/O. All operations below run on that worker with the gate RELEASED.
 * quiesce/resume affect radio ownership only. Any optional storage writer or
 * evidence consumer remains independent; neither callback may assume a TF card
 * or display exists. Record real scan pauses separately.
 * No adapter may start a second cp_usb reader alongside raw_usb_stream.
 */
typedef esp_err_t (*raw_setup_submit_fn)(const cp_settings_t *, const char *, void *);
typedef struct {
    esp_err_t (*quiesce_radio)(void *context);
    esp_err_t (*resume_radio)(void *context);
    esp_err_t (*stop_network)(void *context);
    /* Bind this callback to cp_provision_start(CP_PROVISION_USB, ..., submit,
     * submit_context), with factory identity/proof provided by the adapter. */
    esp_err_t (*start_session)(void *context, raw_setup_submit_fn submit,
                               void *submit_context);
    esp_err_t (*stop_session)(void *context);
    /* Bind to cp_network_validate_candidate[_with_progress]. Must validate
     * authenticated cloud contact; a Wi-Fi link or broker ACK is insufficient. */
    esp_err_t (*validate_candidate)(void *context, const cp_settings_t *, uint32_t timeout_ms);
    /* Bind to cp_settings_save; called only after validation and network stop. */
    esp_err_t (*save_settings)(void *context, const cp_settings_t *);
    /* Optional, public status only. Bind to cp_provision_set_status/diagnostics;
     * do not claim cloud config activation when the local save succeeds. */
    void (*status)(void *context, raw_setup_state_t state, esp_err_t result);
    void *context;
} raw_setup_ops_t;

typedef struct {
    raw_setup_state_t state;
    esp_err_t last_error;
    bool saved; /* Local durable settings only, never applied cloud activation. */
    uint32_t candidate_generation;
    bool entry_pending;
} raw_setup_snapshot_t;

typedef struct {
    atomic_bool gate;
    atomic_uint candidate_generation;
    raw_setup_ops_t ops;
    raw_setup_snapshot_t view;
    cp_settings_t pending;
    char node_id[16], attempt_id[37];
    uint32_t validation_timeout_ms;
    bool candidate_pending, reply_finished, begin_pending, cancel_pending;
    /* Worker-owned final publication, retried if a concurrent snapshot/USB
     * callback briefly holds the gate. It contains no credential material. */
    raw_setup_snapshot_t deferred_view;
    bool deferred_publication;
} raw_setup_t;

/* Init only on fresh storage, before any caller runs; no secret is supplied. */
esp_err_t raw_setup_init(raw_setup_t *, const char *node_id,
                         const raw_setup_ops_t *, uint32_t validation_timeout_ms);
bool raw_setup_begin(void *context);
esp_err_t raw_setup_submit(const cp_settings_t *, const char *attempt_id, void *context);
/* Call only after the entire framed configure reply was written and its bounded
 * TX drain succeeded. On failed/uncertain TX, cancel securely instead. If never
 * notified, validation never starts. Poll must not substitute a delay. */
uint32_t raw_setup_candidate_generation(raw_setup_t *);
bool raw_setup_reply_finished(raw_setup_t *, uint32_t candidate_generation);
/* Explicit cancellation before validation, or teardown retry after a latched
 * ownership fault. Returns false while validation/save is running. Disconnect
 * alone need not cancel. Worker performs all teardown before returning IDLE. */
bool raw_setup_cancel(raw_setup_t *);
esp_err_t raw_setup_poll(raw_setup_t *);
/* A busy gate returns false without exposing credentials or changing output. */
bool raw_setup_snapshot(raw_setup_t *, raw_setup_snapshot_t *);
