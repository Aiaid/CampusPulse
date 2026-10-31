#pragma once
#include "board_runtime_adapters.h"
#include "trial_bootstrap.h"

/* Single application-task owner, boot lifetime, no reset/resume API. This is a
 * fail-closed integration boundary, NOT a ready board service. main and the
 * board runtime gate remain unchanged. The fixed module calls below cannot be
 * replaced by caller-supplied per-phase success callbacks.
 *
 * Production providers for the low blocker bits do not exist. They are set by
 * code, never by a caller's bool or non-NULL callback. Supplying synthetic
 * callbacks/evidence, or changing te_v3_runtime_ready() alone, cannot enable it.
 * Implement and review those providers before changing these interlocks. */
enum {
    TE_COORD_NEEDS_HISTORY_PROVIDER = 1u << 0,
    TE_COORD_NEEDS_IDENTITY_PROVIDER = 1u << 1,
    TE_COORD_NEEDS_MEDIUM_AUDIT = 1u << 2,
    TE_COORD_NEEDS_APPLY_ADMISSION = 1u << 3,
    TE_COORD_NEEDS_CAPTURE_EVIDENCE = 1u << 4,
    TE_COORD_NEEDS_RECEIPT_ONLY = 1u << 5,
    TE_COORD_NEEDS_WINDOW_READ_RESULT = 1u << 6,
    TE_COORD_NEEDS_STATUS_WRITER = 1u << 7,
    TE_COORD_NEEDS_BUDGET_PROVIDER = 1u << 8,
    TE_COORD_RUNTIME_GATE = 1u << 16,
    TE_COORD_BAD_BINDING = 1u << 17,
    TE_COORD_BAD_BOOTSTRAP = 1u << 18,
    TE_COORD_UNPROVEN_CAPABILITY = 1u << 19,
    TE_COORD_BAD_BUDGET = 1u << 20,
    TE_COORD_CLOCK_FAULT = 1u << 21,
    TE_COORD_STEP_LIMIT = 1u << 22,
    TE_COORD_TIME_LIMIT = 1u << 23
};
#define TE_COORD_RELEASE_BLOCKERS ((1u << 9) - 1u)
#define TE_COORD_MAX_STEPS 256u
#define TE_COORD_MAX_ELAPSED_MS 600000u
#define TE_COORD_MAX_PAUSE_MS 1000u
#define TE_COORD_MAX_CLEANUP_ATTEMPTS 3u

typedef enum {
    TE_COORD_NEW, TE_COORD_CONFIGURED, TE_COORD_RUNNING, TE_COORD_BLOCKED,
    TE_COORD_STOPPED, TE_COORD_FAILED
} te_v3_coordinator_state_t;
typedef enum {
    TE_COORD_PROGRESS, TE_COORD_IDLE, TE_COORD_DENIED, TE_COORD_DONE,
    TE_COORD_ERROR, TE_COORD_INVALID
} te_v3_coordinator_result_t;
typedef struct {
    uint32_t max_steps, max_elapsed_ms, pause_timeout_ms, cleanup_attempts;
} te_v3_coordinator_limits_t;
/* Safe to log: no scope IDs, addresses, bodies, credentials, CA, or URLs. Local
 * diagnostics only; this is not a node_status body or a lease renewal. */
typedef struct {
    te_v3_coordinator_state_t state;
    uint32_t blockers, steps, acknowledged_windows, cleanup_attempts;
    te_runtime_phase_t phase, failed_phase;
    te_v3_capability_result_t capability_result;
    esp_err_t capture_error, transport_error;
    bool capture_paused, transport_stopped, secrets_retained;
    bool window_retained, event_retained, durable_record_retained;
} te_v3_coordinator_status_t;
typedef struct {
    te_runtime_window_adapter_t *adapter;
    te_runtime_t runtime;
    trial_bootstrap_t bootstrap;
    cp_v3_transport_config_t transport;
    cp_v3_capture_config_t capture_config;
    te_v3_capability_request_t capability;
    te_v3_capability_evidence_t capability_evidence;
    cp_v3_temporal_config_t capability_temporal;
    te_v3_coordinator_limits_t limits;
    te_v3_coordinator_status_t status;
    uint64_t started_mono_ms, last_mono_ms;
    bool initialized, busy, transport_attempted, capture_attempted;
} te_v3_coordinator_t;

/* Zero-init coordinator and fresh adapter/capture/control once, outside a small
 * task stack. adapter, its queue, capability/evidence, workspace and budgets
 * remain exclusively owned, unchanged by external callers and live for this
 * boot. Capability/evidence values are copied, not treated as live measurements;
 * their arenas and any callback contexts must remain valid. Queue must already have
 * been opened through board_small_queue with the correct shared NVS lock; this
 * API never initializes, formats, erases, or accesses v2/flash cpqueue storage.
 *
 * Parses the actual physical-USB JSON with trial_bootstrap_parse (including the
 * real CA parser), freezes its settings/origin/CA/clock, and installs the fixed
 * transport settings. Caller must wipe input JSON after this call. No network,
 * collector preparation, registration, identity generation or persistence here.
 * True means configuration parsed, NEVER that collection is admitted. */
bool te_v3_coordinator_init(te_v3_coordinator_t *,te_runtime_window_adapter_t *,
    const cp_v3_capture_config_t *,const te_v3_coordinator_limits_t *,
    const char *bootstrap_json,const char *node,const char *boot,uint64_t mono_ms);
/* One bounded state-machine phase per call; no sleeps/retries/spin loop. The
 * owner supplies its actual boot monotonic measurement. Current release always
 * returns DENIED before I/O: mandatory providers above are absent. Future
 * integration must retain per-phase time/authority checks and the collector's
 * independent deadline; a host step bound is not radio deadline enforcement. */
te_v3_coordinator_result_t te_v3_coordinator_step(te_v3_coordinator_t *,uint64_t mono_ms);
/* Request pause first, then stop only this coordinator's attempted transport.
 * At most cleanup_attempts calls perform cleanup; later calls are read-only.
 * Pending handoffs, exact durable records and control evidence are preserved.
 * Successful network stop permits wiping bootstrap secrets; failed stop keeps
 * CA/config memory live because the transport may still reference it. No free
 * or NimBLE deinit: shared capture allocations intentionally live until reboot. */
te_v3_coordinator_result_t te_v3_coordinator_stop(te_v3_coordinator_t *);
bool te_v3_coordinator_status(const te_v3_coordinator_t *,te_v3_coordinator_status_t *);
