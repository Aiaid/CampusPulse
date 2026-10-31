#pragma once
#include "cp_v3_queue.h"

/* Pure, read-only diagnostic for the T-Energy one-item, local_raw=off serializer
 * subset. This is neither an authorization callback nor an ACK. No networking,
 * queue/ledger mutation, retained policy package, or current capture authority. */
#define TE_LOCAL_GUARD_BODY_MAX 1024u
typedef enum {
    TE_LOCAL_GUARD_NOT_CHECKED,
    TE_LOCAL_GUARD_STRUCTURE_MATCHED,
    TE_LOCAL_GUARD_BAD_INPUT,
    TE_LOCAL_GUARD_UNSUPPORTED,
    TE_LOCAL_GUARD_HASH_MISMATCH,
    TE_LOCAL_GUARD_BAD_BODY,
    TE_LOCAL_GUARD_SCOPE_MISMATCH,
    TE_LOCAL_GUARD_UNKNOWN_TIME,
    TE_LOCAL_GUARD_FUTURE,
    TE_LOCAL_GUARD_EXPIRED
} te_local_guard_check_t;
enum {
    TE_LOCAL_GUARD_NEEDS_DURABLE_ORIGIN_AND_ORIGINAL_CLOCK = 1u << 0,
    TE_LOCAL_GUARD_NEEDS_BACKEND_AUTHORIZATION = 1u << 1,
    TE_LOCAL_GUARD_NEEDS_LOCAL_DURABLE_BUDGET = 1u << 2,
    TE_LOCAL_GUARD_NEEDS_QUEUE_EXPIRY = 1u << 3,
    TE_LOCAL_GUARD_NEEDS_TRUSTED_DESTINATION_AND_RECEIPT = 1u << 4
};
#define TE_LOCAL_GUARD_OBLIGATIONS ((1u << 5) - 1u)
typedef struct {
    /* Caller must supply a trusted current UTC estimate, never a guessed time.
     * UTC==0, epoch==0, and uncertainty>5000 ms fail closed. */
    cp_v3_time_t upload_now;
    /* Exact original persisted queue deadline, already capped at the original
     * policy accept_until. Zero/unknown fails. Queue still owns expiration and
     * tombstone persistence; this diagnostic never deletes or acknowledges. */
    uint64_t source_expires_at_ms;
    /* Local conservative age ceiling, not a substitute for retained backend
     * policy/lease/placement checks. Required and never inferred from new policy. */
    uint64_t max_source_age_ms;
} te_local_guard_time_t;
typedef struct {
    te_local_guard_check_t check;
    uint32_t obligations; /* Always TE_LOCAL_GUARD_OBLIGATIONS, on every exit. */
    /* Derived from the original body's UTC +/- uncertainty and duration. */
    uint64_t observation_start_lower_ms, observation_end_upper_ms;
    uint64_t observation_end_lower_ms, current_lower_ms, current_upper_ms;
    uint32_t clock_epoch;
} te_local_guard_report_t;

/* Verifies exact SHA/byte length, queue kind, same-node and compact wire scope,
 * batch/sequence/window identity, every allowed window/status field, and bounded
 * conservative time. Only unescaped ASCII JSON is supported; other valid JSON
 * encodings fail rather than being normalized. Candidate events, old features,
 * raw records, per-address objects, unknown keys and multiple items all fail.
 * expected placement_id is not present in statistics/1 and cannot be verified
 * against this body: the backend must bind the original policy to placement.
 * Structurally allowed counters cannot prove radio truth or exclude covert
 * numeric encoding. A matched result never clears original-clock provenance,
 * durable resource budgets, backend authority, queue expiry or receipt duties.
 * Caller serializes access and holds immutable body/expected/deadline snapshots. */
void te_local_guard_inspect(cp_v3_queue_kind_t kind,
    const cp_v3_expected_t *expected, const char *current_node_id,
    const void *body, size_t length, const te_local_guard_time_t *time,
    cp_v3_sha256_fn sha256, void *hash_context, te_local_guard_report_t *report);
