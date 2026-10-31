#pragma once
#include "cp_v3_budget.h"
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* Bounded experiment only: no eviction, reset, reclamation or rollover API. */
#define TE_IDENTITY_IDS_MAX 128u
#define TE_IDENTITY_BOOTS_MAX 128u
#define TE_IDENTITY_TRIAL_MS UINT64_C(7200000)
#define TE_IDENTITY_HEADER_BYTES 128u
#define TE_IDENTITY_BOOT_BYTES 16u
#define TE_IDENTITY_ITEM_BYTES 24u
#define TE_IDENTITY_RECORD_BYTES (TE_IDENTITY_HEADER_BYTES + \
    TE_IDENTITY_BOOTS_MAX * TE_IDENTITY_BOOT_BYTES + \
    TE_IDENTITY_IDS_MAX * TE_IDENTITY_ITEM_BYTES + 40u)
#define TE_IDENTITY_WRITE_ALLOWANCE UINT64_C(16384)
#define TE_IDENTITY_REQUIRED_ENTRIES (128u + (TE_IDENTITY_RECORD_BYTES + 31u) / 32u + 8u)

typedef enum {
    TE_IDENTITY_OK, TE_IDENTITY_INVALID, TE_IDENTITY_BUSY, TE_IDENTITY_STATE,
    TE_IDENTITY_IO, TE_IDENTITY_CORRUPT, TE_IDENTITY_OWNER, TE_IDENTITY_BUDGET,
    TE_IDENTITY_CLOCK, TE_IDENTITY_SPACE, TE_IDENTITY_ENTROPY,
    TE_IDENTITY_REUSED, TE_IDENTITY_SEQUENCE, TE_IDENTITY_EXHAUSTED,
    TE_IDENTITY_TRIAL_ENDED, TE_IDENTITY_CHANGED, TE_IDENTITY_LATCHED
} te_identity_result_t;
typedef enum {
    TE_IDENTITY_ABSENT, TE_IDENTITY_PRESENT, TE_IDENTITY_LOAD_IO,
    TE_IDENTITY_LOAD_CORRUPT
} te_identity_load_t;
typedef struct {
    void *context;
    /* Read exact dedicated ledger, including evidence of interrupted writes.
     * ABSENT is positive absence only; never hide malformed/foreign/torn data.
     * Backend must retain every successfully committed state across restart.
     * It must not touch queues, other namespaces, initialize or erase NVS. */
    te_identity_load_t (*load)(void *, void *, size_t, size_t *);
    /* Durable replacement + commit before true. False may have committed.
     * The core independently loads and compares every byte after true. */
    bool (*commit)(void *, const void *, size_t);
    /* Actual current NVS available_entries, excluding NVS-reserved entries.
     * Failure/unknown capacity is denied. A host model is not board evidence. */
    bool (*available_entries)(void *, uint32_t *);
} te_identity_backend_t;
typedef struct {
    te_identity_backend_t backend;
    cp_v3_budget_t *storage_budget;
    /* Use the SAME outer lock and storage owner as every NVS writer. The lock
     * spans budget charge, capacity recheck, commit and exact readback. Core
     * cannot establish other writers' lock discipline: board wiring must. */
    bool (*try_lock)(void *);
    void (*unlock)(void *);
    void *lock_context;
    bool (*sha256)(void *, const void *, size_t, uint8_t out[32]);
    void *hash_context;
    /* Authenticated UTC bounds and this boot's monotonic milliseconds. Unknown
     * time, crossing midnight uncertainty, rollback and two-hour age deny. */
    bool (*clock)(void *, uint64_t *lower, uint64_t *upper, uint64_t *monotonic);
    void *clock_context;
    /* Cryptographic entropy, never a timestamp/counter/PRNG fallback. */
    bool (*entropy)(void *, uint8_t out[16]);
    void *entropy_context;
} te_identity_config_t;
typedef enum { TE_IDENTITY_NEW, TE_IDENTITY_OPEN, TE_IDENTITY_ACTIVE,
    TE_IDENTITY_FAILED } te_identity_state_t;
typedef struct {
    te_identity_state_t state;
    te_identity_config_t config;
    char node[65], boot[37];
    uint64_t boot_monotonic, last_monotonic, last_lower;
    uint32_t last_sequence;
    bool have_record, have_clock, locked;
    te_identity_result_t last_result;
    cp_v3_budget_result_t last_budget_result;
    uint8_t current[TE_IDENTITY_RECORD_BYTES];
    uint8_t scratch[TE_IDENTITY_RECORD_BYTES];
} te_identity_t;

/* One zero-initialized boot-lifetime owner. Read-only open verifies exact node,
 * real configured shared storage budget owner SHA and existing ledger. Never
 * reset/reopen an active/failed object to bypass denial. Fresh-process reopen
 * keeps old reservations and requires begin_boot to durably reserve a NEW boot.
 * No physical NVS backend is supplied and this is NOT wired to the board gate. */
te_identity_result_t te_identity_open(te_identity_t *, const char *node,
                                    const te_identity_config_t *);
/* Only publishes a random UUIDv4 after budgeted durable commit and readback. */
te_identity_result_t te_identity_begin_boot(te_identity_t *, char out_boot[37]);
/* A candidate UUID is not usable until OK. Exact retries also fail; retry the
 * original frozen body/identity instead of requesting another reservation. */
te_identity_result_t te_identity_reserve(te_identity_t *, const char *node,
    const char *boot, const char *uuid, uint32_t sequence);
/* Signature fits board_runtime_adapters.reserve_identity (context = ledger). */
bool te_identity_reserve_callback(void *, const char *, const char *, const char *, uint32_t);
te_identity_result_t te_identity_generate(te_identity_t *, uint32_t sequence, char out_uuid[37]);
