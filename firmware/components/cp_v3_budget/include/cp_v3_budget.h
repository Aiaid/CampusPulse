#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* Serialized daily logical-write authorization, not physical flash wear.
 * One owner plus the caller's outer storage mutex must serialize all calls. */
#define CP_V3_BUDGET_RECORD_BYTES 96u
#define CP_V3_BUDGET_OWNER_BYTES 32u
#define CP_V3_BUDGET_MAX_BYTES UINT64_C(1099511627776)
#define CP_V3_BUDGET_DEFAULT_QUANTUM UINT64_C(65536)

typedef enum {
    CP_V3_BUDGET_OK, CP_V3_BUDGET_INVALID, CP_V3_BUDGET_IO,
    CP_V3_BUDGET_CORRUPT, CP_V3_BUDGET_OWNER_MISMATCH,
    CP_V3_BUDGET_NOT_READY, CP_V3_BUDGET_LIMIT,
    CP_V3_BUDGET_CLOCK_UNKNOWN, CP_V3_BUDGET_DAY_AMBIGUOUS,
    CP_V3_BUDGET_DAY_REGRESSION, CP_V3_BUDGET_LATCHED,
    CP_V3_BUDGET_EXHAUSTED
} cp_v3_budget_result_t;
typedef enum {
    CP_V3_BUDGET_LOAD_ABSENT, CP_V3_BUDGET_LOAD_PRESENT,
    CP_V3_BUDGET_LOAD_IO, CP_V3_BUDGET_LOAD_CORRUPT
} cp_v3_budget_load_t;
typedef struct {
    uint8_t owner_key[CP_V3_BUDGET_OWNER_BYTES]; /* stable SHA-256 of node scope */
    uint64_t sequence, reserved_bytes;
    uint32_t utc_day; /* floor(UTC milliseconds / 86400000) */
} cp_v3_budget_record_t;
typedef struct {
    void *context;
    /* ABSENT only means positively absent. Wrong length/torn/foreign/ambiguous
     * nonempty data must return PRESENT for decode failure, or CORRUPT. */
    cp_v3_budget_load_t (*load)(void *, void *record, size_t capacity, size_t *length);
    /* Atomically replace the previous record and sync before true. false may
     * mean committed: core then latches until an explicit reopen/load. */
    bool (*store)(void *, const void *record, size_t length);
    /* Declared logical bytes written by one successful store, including its
     * serialized record and conservatively accounted provider overhead.
     * Must be >=96. Automatically charged before permitting caller I/O. */
    uint64_t logical_write_bytes;
} cp_v3_budget_store_t;
typedef struct {
    cp_v3_budget_store_t store;
    cp_v3_budget_record_t record;
    uint64_t limit_bytes, quantum_bytes, credit_bytes;
    uint64_t authorized_io_bytes, journal_logical_bytes, reserved_added_bytes;
    uint64_t carry_in_reserved_bytes, discarded_credit_bytes;
    uint64_t persist_attempts, persist_successes, rejections, clock_rejections;
    uint64_t uncertain_reserved_bytes;
    uint32_t latest_observed_day;
    bool opened, configured, have_record, latched, have_observed_day;
} cp_v3_budget_t;
typedef struct {
    uint32_t utc_day;
    uint64_t limit_bytes, quantum_bytes, persisted_reserved_bytes, available_credit_bytes;
    uint64_t authorized_io_bytes_since_open, journal_logical_bytes_since_open;
    uint64_t reserved_added_bytes_since_open, carry_in_reserved_bytes, discarded_credit_bytes;
    uint64_t persist_attempts, persist_successes, rejections, clock_rejections;
    uint64_t uncertain_reserved_bytes;
    bool have_day, configured, latched;
} cp_v3_budget_snapshot_t;

/* Exact portable little-endian representation with CRC32 and commit marker.
 * Rejects unknown version, padding, owner, bounds and size. */
bool cp_v3_budget_encode(const cp_v3_budget_record_t *, uint8_t out[CP_V3_BUDGET_RECORD_BYTES]);
bool cp_v3_budget_decode(const void *, size_t, cp_v3_budget_record_t *);
/* Read-only open. All previously reserved bytes remain consumed; RAM credit is
 * always zero, so reboot cannot recover unused reservation. Never auto-formats.
 * Same stable owner_key and provider namespace must be used across all boots,
 * policies and writers for this node. Caller must not repeatedly open live
 * state to recover from a denial; reopening deliberately burns credit. */
cp_v3_budget_result_t cp_v3_budget_open(cp_v3_budget_t *, cp_v3_budget_store_t,
    const uint8_t owner_key[CP_V3_BUDGET_OWNER_BYTES]);
cp_v3_budget_result_t cp_v3_budget_configure(cp_v3_budget_t *, uint64_t limit_bytes, uint64_t quantum_bytes);
/* Call BEFORE logical I/O; failed/cancelled caller I/O is not refunded.
 * UTC bounds must be trusted, ordered, >=2024 and <2200, wholly within one UTC
 * day. Pass 0/0 for unknown time (rejected). Same-day clock rollback cannot
 * reset usage; day regression and midnight-straddling uncertainty are rejected.
 * Bytes include caller's conservative filesystem/journal amplification estimate.
 * Charge may reserve a smaller final quantum when only that much budget remains.
 * A lower policy limit below the persisted reservation denies all further I/O.
 */
cp_v3_budget_result_t cp_v3_budget_charge(cp_v3_budget_t *, uint64_t logical_bytes,
    uint64_t utc_lower_ms, uint64_t utc_upper_ms);
void cp_v3_budget_snapshot(const cp_v3_budget_t *, cp_v3_budget_snapshot_t *);
void cp_v3_budget_clear(cp_v3_budget_t *);
