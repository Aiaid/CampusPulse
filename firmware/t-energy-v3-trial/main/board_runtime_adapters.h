#pragma once
#include "board_runtime.h"
#include "board_handoff.h"
#include "board_window_freeze.h"
#include "board_small_queue.h"
#include "board_shared_capture.h"
#include "board_capabilities.h"
#include "cp_v3_transport.h"
#include "cp_v3_budget.h"

/* Experimental window-path binding; all objects and buffers are single-owner,
 * boot-lifetime and must remain unchanged until the record is acknowledged.
 * Historical age validation, fresh identity reservation and their durable
 * production providers remain unimplemented. Historical control replay uses
 * receipt-only transport and does not grant current-boot capture authority.
 * This adapter alone cannot establish the prerequisites for collection. */
#define TE_RT_RECEIPT_MAX 4096u
#define TE_RT_WINDOW_IDS_MAX 128u
typedef struct {
    te_v3_small_queue_t *queue;
    const cp_settings_t *settings;
    const cp_v3_transport_config_t *transport_config;
    const te_v3_capability_request_t *capability;
    cp_v3_control_workspace_t *workspace;
    cp_v3_budget_t *uplink_budget;
    bool (*budget_lock)(void *);
    void (*budget_unlock)(void *);
    uint32_t registration_seq;
    uint32_t apply_seq;
    uint32_t lease_contact_seq, next_window_seq;
    /* Independently generated UUIDv4 identities, reserved once and never
     * reused across ambiguous writes, retries, policies or boots. */
    char ack_batch_id[37], lease_batch_id[37];
    cp_v3_actual_apply_fn actual_apply;
    void *apply_context;
    cp_v3_boundary_t closed_boundary;
    /* A separate read-only, locked medium audit must detect every damaged,
     * foreign and unknown occupied key. No production binding exists yet. */
    bool (*backlog_audit_empty)(void *);
    /* Strictly parse the exact frozen small-statistics body and prove its
     * observations have aged past their conservative UTC upper bound. False
     * includes unknown/unprovable time. This is not authorization: server
     * validates the original historical lease and policy inside ingestion. */
    bool (*historical_aged)(void *,const void *,size_t,const cp_v3_expected_t *,cp_v3_time_t);
    /* Read-only local recovery guard for the exact frozen body: validate its
     * original scope/identity, observation time and local resource ledger.
     * The authenticated backend resolves historical applied policy, lease,
     * placement and cloud quota; this callback must never grant new capture
     * authority. An unknown local upload/storage budget still denies recovery.
     * A production implementation of this guard is not yet wired. */
    bool (*historical_authorized)(void *,cp_v3_queue_kind_t,const void *,size_t,
                                  const cp_v3_expected_t *,cp_v3_time_t);
    bool transport_started, tls_verified, registered;
    bool recovery_complete, ack_frozen, ack_stored, ack_committed, lease_committed;
    unsigned control_slot;
    size_t control_length;
    cp_v3_expected_t control_expected;
    uint8_t control_body[TE_SMALL_QUEUE_BODY_MAX];
    char capability_json[CP_V3_CONTROL_CAP_MAX];
    te_v3_shared_capture_t *capture;
    cp_v3_control_t *control;
    te_v3_window_freeze_t *freeze;
    te_handoff_t handoff;
    cp_v3_capture_window_t release_scratch;
    uint64_t expiry_utc_ms;
    unsigned slot;
    cp_v3_expected_t stored_identity;
    uint8_t stored_hash[TE_HANDOFF_HASH_BYTES];
    bool stored, released, sent;
    /* Cryptographic entropy. Identity reservation must atomically and durably
     * reject every previously reserved UUID across boots and enforce strictly
     * increasing seq within this exact node+boot. It must charge its own writes
     * and retain reservations on ambiguous results. No such provider is wired. */
    bool (*entropy)(void *,uint8_t out[16]);
    bool (*reserve_identity)(void *,const char *node,const char *boot,
                             const char *uuid,uint32_t seq);
    char identity_boot[37];
    uint32_t window_seq;
    bool identity_active, identity_fault;
    unsigned window_id_count;
    char window_ids[TE_RT_WINDOW_IDS_MAX][37];
    /* Trusted time and current capacity must be real measurements; queue_ready
     * includes durable backlog and all resource budgets, not nominal space. */
    bool (*now)(void *,cp_v3_time_t *);
    bool (*queue_ready)(void *);
    /* HTTPS implementation validates chain/hostname/time/origin and sends the
     * exact body and hash; return false on ambiguity. It may not acknowledge
     * storage itself. */
    bool (*post_statistics)(void *,const void *,size_t,const cp_v3_expected_t *,
                            void *,size_t,size_t *);
    void *io;
    uint8_t readback[TE_SMALL_QUEUE_BODY_MAX], receipt[TE_RT_RECEIPT_MAX];
} te_runtime_window_adapter_t;
/* RECOVER can return EMPTY only with a separate successful medium audit and no
 * remaining backlog. PEEK requires cryptographic entropy plus durable identity
 * reservation. One boot is limited to TE_RT_WINDOW_IDS_MAX windows; exhaustion,
 * uncertainty and reservation failures latch closed. */
te_runtime_result_t te_runtime_window_perform(void *,te_runtime_phase_t);
bool te_runtime_window_pause(void *);
