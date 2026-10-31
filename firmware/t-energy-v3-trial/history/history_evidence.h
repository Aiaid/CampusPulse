#pragma once
#include "cp_v3_control.h"

/* Diagnostic only. No API in this file grants capture or upload permission. */
#define TE_HISTORY_MAX_LEASES 4u
#define TE_HISTORY_MAX_SPANS (TE_HISTORY_MAX_LEASES + 1u)
typedef enum {
    TE_HISTORY_CAPABILITIES, TE_HISTORY_POLICY_ENVELOPE,
    TE_HISTORY_APPLIED_REQUEST, TE_HISTORY_APPLIED_RECEIPT,
    TE_HISTORY_LEASE_REQUEST, TE_HISTORY_LEASE_RECEIPT
} te_history_artifact_t;
typedef enum {
    TE_HISTORY_PRESENT, TE_HISTORY_ABSENT, TE_HISTORY_IO, TE_HISTORY_CORRUPT
} te_history_load_t;
typedef struct {
    void *context;
    /* Read one immutable original artifact. PRESENT requires its exact length;
     * never return a successful prefix. Wrong length/torn/uncommitted/ambiguous
     * data must be CORRUPT. The caller must hold one consistent snapshot/lock
     * across the entire inspect operation. No real NVS provider ships here. */
    te_history_load_t (*load)(void *, te_history_artifact_t, unsigned,
        void *, size_t capacity, size_t *length);
} te_history_source_t;
typedef struct {
    cp_v3_scope_t original_scope;
    /* Actual observation bounds, not censored event's later logical stop.
     * Parsing/binding these to the exact frozen body remains a release blocker. */
    cp_v3_time_t observation_start, observation_end, upload_now;
    size_t frozen_body_bytes;
    unsigned lease_count;
} te_history_query_t;
typedef struct { uint64_t start_utc_ms, end_utc_ms; uint32_t sequence; } te_history_span_t;

/* Low bits are permanent release blockers, even after structural checks pass.
 * A source callback, valid SHA, or successful host test cannot clear these. */
enum {
    TE_HISTORY_NEEDS_DURABLE_ORIGIN = 1u << 0,
    TE_HISTORY_NEEDS_ACTUAL_APPLY_JOURNAL = 1u << 1,
    TE_HISTORY_NEEDS_CLOCK_JOURNAL = 1u << 2,
    TE_HISTORY_NEEDS_PLACEMENT_VALIDITY = 1u << 3,
    TE_HISTORY_NEEDS_BODY_TIME_BINDING = 1u << 4,
    TE_HISTORY_NEEDS_ORIGINAL_DAILY_BUDGET = 1u << 5,
    TE_HISTORY_NEEDS_REGISTRATION_EVIDENCE = 1u << 6,
    TE_HISTORY_BAD_INPUT = 1u << 8,
    TE_HISTORY_MISSING_ARTIFACT = 1u << 9,
    TE_HISTORY_STORAGE_FAILURE = 1u << 10,
    TE_HISTORY_BAD_CAPABILITY = 1u << 11,
    TE_HISTORY_BAD_POLICY = 1u << 12,
    TE_HISTORY_SCOPE_MISMATCH = 1u << 13,
    TE_HISTORY_BAD_APPLIED_RECEIPT = 1u << 14,
    TE_HISTORY_BAD_LEASE_CHAIN = 1u << 15,
    TE_HISTORY_UNKNOWN_TIME = 1u << 16,
    TE_HISTORY_OUTSIDE_AUTHORITY = 1u << 17,
    TE_HISTORY_EXPIRED = 1u << 18,
    TE_HISTORY_UPLOAD_DAY_AMBIGUOUS = 1u << 19,
    TE_HISTORY_BODY_LIMIT = 1u << 20
};
#define TE_HISTORY_RELEASE_BLOCKERS ((1u << 7) - 1u)
typedef enum { TE_HISTORY_NOT_CHECKED, TE_HISTORY_STRUCTURE_MATCHED } te_history_check_t;
typedef struct {
    te_history_check_t check;
    uint32_t blockers;
    cp_v3_control_result_t control_result;
    cp_v3_scope_t original_scope;
    uint64_t original_accept_until_ms, original_daily_upload_limit;
    uint32_t upload_utc_day;
    te_history_span_t spans[TE_HISTORY_MAX_SPANS];
    unsigned span_count;
} te_history_report_t;
/* Caller-owned bounded workspace, outside task stack. Shared JSON internals are
 * used only to extract facts after strict validation; do not use concurrently. */
typedef struct {
    cp_v3_control_t control;
    cp_v3_control_workspace_t parser;
    uint8_t document[CP_V3_CONTROL_JSON_MAX];
    uint8_t request[CP_V3_CONTROL_ACK_MAX], receipt[CP_V3_CONTROL_ACK_MAX];
} te_history_workspace_t;
/* Read-only, no network, no persistence mutation, no fake apply callback, no
 * current-policy argument. All exits retain TE_HISTORY_RELEASE_BLOCKERS. */
void te_history_inspect(te_history_workspace_t *, const te_history_source_t *,
    const te_history_query_t *, cp_v3_sha256_fn, void *, te_history_report_t *);
