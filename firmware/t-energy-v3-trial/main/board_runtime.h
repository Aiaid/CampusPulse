#pragma once
#include <stdbool.h>

/* Host-testable ordering core only. Not a board integration or proof that its
 * callbacks perform the work below. Single owner, non-reentrant, boot-lifetime
 * instance; no reset/resume API. Callback context must outlive this object.
 * A failure halts permanently and requests capture pause, preserving all staged
 * data. Neither a successful callback nor this state machine proves hardware,
 * radio, TLS, storage or server behavior. */
typedef enum {
    TE_RT_CONNECT, TE_RT_REGISTER, TE_RT_VALIDATE, TE_RT_RECOVER,
    TE_RT_ACK_FREEZE, TE_RT_ACK_STORE, TE_RT_ACK_SEND,
    TE_RT_LEASE, TE_RT_START, TE_RT_MONITOR, TE_RT_PEEK,
    TE_RT_FREEZE, TE_RT_STORE, TE_RT_RELEASE, TE_RT_SEND,
    TE_RT_HALTED
} te_runtime_phase_t;
typedef enum { TE_RT_OK, TE_RT_EMPTY, TE_RT_FAIL } te_runtime_result_t;
typedef enum { TE_RT_PROGRESS, TE_RT_IDLE, TE_RT_STOPPED, TE_RT_INVALID } te_runtime_step_result_t;

typedef struct {
    /* Each callback performs exactly the phase requested, synchronously. OK is
     * permitted only after the following proof, EMPTY only for RECOVER or PEEK:
     * CONNECT: TLS chain, hostname, validity and isolated origin verified.
     * REGISTER: actual registration accepted for the boot and capabilities.
     * VALIDATE: policy authenticity, bounds, resources and global persisted
     * queue budget checked, including all old/foreign/uncertain records.
     * RECOVER: one oldest historical record settled by strict exact receipt or
     * conservative trusted expiry; EMPTY only after all old backlog settled.
     * Never reassign scope, boot, identity, sequence or bytes. Unknown time,
     * damage, uncertain commits or foreign records fail closed.
     * ACK_FREEZE: create applied ACK with exact frozen identity and bytes.
     * ACK_STORE: persist and read back those exact bytes and identity.
     * ACK_SEND: verify committed applied ACK receipt against exact stored
     * identity/bytes, then remove only that record durably.
     * LEASE: obtain and strictly verify an independent committed lease receipt.
     * START: start only with current control/lease and queue admission.
     * MONITOR: check lease, policy/scope, resource and queue admission before
     * each subsequent phase; perform authenticated renewal if required, with
     * receipt verification; otherwise fail and synchronously stop observation.
     * PEEK: copy exact window without release; EMPTY means no window.
     * FREEZE: freeze immutable body and original scope/identity for that peek.
     * STORE: commit and read back exact frozen bytes and identity durably.
     * RELEASE: release exactly the persisted peek, not a newer window.
     * SEND: strict committed statistics receipt verification against the exact
     * durable record, then durably acknowledge only that record.
     * No callback may upload raw or per-address observations. Adapters must
     * preserve the original staged data on failures and ambiguous results. */
    te_runtime_result_t (*perform)(void *, te_runtime_phase_t);
    /* Must synchronously request collector pause even when start failed
     * ambiguously. False means pause is unconfirmed, never success. */
    bool (*pause)(void *);
    void *context;
} te_runtime_ops_t;
typedef struct {
    te_runtime_phase_t phase, after_monitor, failed_phase;
    bool active, busy, pause_confirmed;
} te_runtime_t;
/* Zero-initialize once. Callback failures and invalid return values stop; the
 * instance and callback-owned pending records must not be reinitialized to
 * bypass reconciliation. Scheduler must invoke frequently enough to uphold the
 * collector's own independent monotonic lease deadline; blocking callbacks must
 * not extend that deadline. No calls from an ISR or concurrent owner. */
te_runtime_step_result_t te_runtime_step(te_runtime_t *, const te_runtime_ops_t *);
