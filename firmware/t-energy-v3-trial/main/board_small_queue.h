#pragma once
#include "nvs_store.h"
#include "cp_v3_budget.h"

#define TE_SMALL_QUEUE_BODY_MAX 1024u
/* Shared queue results retain their numeric values; board-only failures are
 * distinct from FULL and from an uncertain storage transaction. */
typedef enum {
    TE_SMALL_QUEUE_OK=CP_V3_QUEUE_OK,
    TE_SMALL_QUEUE_INVALID=CP_V3_QUEUE_INVALID,
    TE_SMALL_QUEUE_FULL=CP_V3_QUEUE_FULL,
    TE_SMALL_QUEUE_IO=CP_V3_QUEUE_IO,
    TE_SMALL_QUEUE_NOT_FOUND=CP_V3_QUEUE_NOT_FOUND,
    TE_SMALL_QUEUE_MISMATCH=CP_V3_QUEUE_MISMATCH,
    TE_SMALL_QUEUE_RETIRED=CP_V3_QUEUE_RETIRED,
    TE_SMALL_QUEUE_EXPIRED=CP_V3_QUEUE_EXPIRED,
    TE_SMALL_QUEUE_CLOCK_UNKNOWN=CP_V3_QUEUE_CLOCK_UNKNOWN,
    TE_SMALL_QUEUE_BUSY,
    TE_SMALL_QUEUE_POLICY,
    TE_SMALL_QUEUE_UNCERTAIN
} te_v3_small_queue_result_t;
typedef struct {
    cp_v3_sha256_fn sha256; /* Actual SHA-256, never a checksum/test digest. */
    void *sha_context;
    cp_v3_queue_clock_fn clock; /* Trusted conservative UTC bounds. */
    void *clock_context;
    /* Shared, opened daily logical-write budget for this node. Its NVS
     * provider and this queue must be protected by the same outer lock.
     * No queue mutation is attempted if a reservation fails. */
    cp_v3_budget_t *write_budget;
    /* Required nonblocking arbitration over this instance AND every other
     * writer to the shared NVS partition. Callbacks must not reenter it. */
    bool (*try_lock)(void *);
    void (*unlock)(void *);
    void *lock_context;
    /* Required current applied-policy check for every push, including an exact
     * same-boot retry of a previously frozen record.
     * Check exact scope, negotiated stream/body limits and retention deadline.
     * The owner must apply an authenticated real policy first; a constant true
     * callback is not policy validation. Historical reads confer no authority. */
    bool (*admit_new)(void *,cp_v3_queue_kind_t,const cp_v3_expected_t *,size_t,uint64_t);
    void *policy_context;
} te_v3_small_queue_config_t;
typedef struct {
    unsigned occupied_keys, quarantined_slots;
    size_t available_entries, required_entries, encoded_bytes;
    bool target_reuses_tombstone;
} te_v3_small_queue_capacity_t;
/* Caller-owned, zero-initialized, outside a small task stack. Do not mutate its
 * members or call its underlying queue/store directly while bound. */
typedef struct {
    te_nvs_store_t storage;
    cp_v3_queue_store_t raw_store;
    cp_v3_queue_t queue;
    te_v3_small_queue_config_t config;
    bool opened;
    cp_v3_budget_result_t last_budget_result;
} te_v3_small_queue_t;
/* Owner initializes existing NVS without erase-on-error BEFORE open. Open is
 * read-only and never initializes/formats NVS or changes cpqueue/partitions.
 * Explicit reopen reconciles uncertain state with persisted exact records.
 * Same-node historical small/control recovery preserves original body/scope;
 * historical control still requires a strict stateless receipt verifier. */
te_v3_small_queue_result_t te_v3_small_queue_open(te_v3_small_queue_t *,
    const char *node,const char *boot,const te_v3_small_queue_config_t *);
/* Read-only NEW-record admission snapshot under NVS arbitration. At most one
 * window, zero events, one status, one control; at most three occupied keys
 * including damaged/foreign records and tombstones. 1024 body / 2048 record.
 * The entry floor is the adapter's conservative guard, NOT a reservation,
 * guaranteed GC bound, retention promise or proof of device capacity. */
te_v3_small_queue_result_t te_v3_small_queue_preflight(te_v3_small_queue_t *,
    cp_v3_queue_kind_t,const cp_v3_expected_t *,size_t,uint64_t,
    te_v3_small_queue_capacity_t *);
te_v3_small_queue_result_t te_v3_small_queue_push(te_v3_small_queue_t *,
    cp_v3_queue_kind_t,const cp_v3_expected_t *,const void *,size_t,uint64_t,unsigned *);
te_v3_small_queue_result_t te_v3_small_queue_oldest(te_v3_small_queue_t *,cp_v3_queue_kind_t,unsigned *);
te_v3_small_queue_result_t te_v3_small_queue_read(te_v3_small_queue_t *,unsigned,
    void *,size_t,size_t *,cp_v3_expected_t *);
te_v3_small_queue_result_t te_v3_small_queue_ack(te_v3_small_queue_t *,unsigned,const void *,size_t);
te_v3_small_queue_result_t te_v3_small_queue_ack_control(te_v3_small_queue_t *,unsigned,const void *,size_t,
    cp_v3_queue_control_match_fn,void *);
te_v3_small_queue_result_t te_v3_small_queue_expire(te_v3_small_queue_t *);
