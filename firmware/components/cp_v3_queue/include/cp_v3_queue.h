#pragma once
#include "cp_v3_evidence.h"

#define CP_V3_QUEUE_FEATURE_SLOTS 8u
#define CP_V3_QUEUE_WINDOW_SLOTS 4u
#define CP_V3_QUEUE_EVENT_SLOTS 4u
#define CP_V3_QUEUE_STATUS_SLOTS 2u
#define CP_V3_QUEUE_CONTROL_SLOTS 2u
#define CP_V3_QUEUE_SLOTS 12u
#define CP_V3_QUEUE_SLOT_BYTES 6144u
#define CP_V3_QUEUE_BODY_MAX 4096u
typedef enum { CP_V3_QUEUE_FEATURE, CP_V3_QUEUE_STATUS, CP_V3_QUEUE_CONTROL,
    CP_V3_QUEUE_WINDOW, CP_V3_QUEUE_EVENT } cp_v3_queue_kind_t;
typedef enum { CP_V3_QUEUE_FEATURE_TRIAL, CP_V3_QUEUE_SMALL_RESULTS } cp_v3_queue_profile_t;
typedef enum { CP_V3_QUEUE_FREE, CP_V3_QUEUE_PENDING, CP_V3_QUEUE_QUARANTINED } cp_v3_queue_state_t;
typedef enum { CP_V3_QUEUE_OK, CP_V3_QUEUE_INVALID, CP_V3_QUEUE_FULL, CP_V3_QUEUE_IO,
    CP_V3_QUEUE_NOT_FOUND, CP_V3_QUEUE_MISMATCH, CP_V3_QUEUE_RETIRED,
    CP_V3_QUEUE_EXPIRED, CP_V3_QUEUE_CLOCK_UNKNOWN } cp_v3_queue_result_t;
typedef struct {
    char body_sha256[65];
    uint8_t record_sha256[32];
    uint64_t ordinal, source_expires_at_ms;
    uint32_t body_bytes;
} cp_v3_queue_tombstone_t;
/* Trusted clock returns a conservative lower bound on current UTC, not a
 * server/network claim. Expire must first sync a minimal tombstone, then erase
 * only this exact source record. It is distinct from successful receipt ACK. */
typedef bool (*cp_v3_queue_clock_fn)(void *,uint64_t *utc_lower_bound_ms,uint64_t *utc_upper_bound_ms);
typedef bool (*cp_v3_queue_expire_fn)(void *,unsigned,const void *,size_t,
    const cp_v3_queue_tombstone_t *);
typedef struct {
    uint8_t window_slots,event_slots,status_slots,control_slots;
    uint16_t max_body_bytes;
} cp_v3_queue_limits_t;
typedef struct {
    cp_v3_queue_profile_t profile;
    cp_v3_queue_clock_fn clock;
    cp_v3_queue_expire_fn expire;
    void *retention_context;
    cp_v3_queue_limits_t limits; /* All zero:4/4/2/2,4096. Total<=12. */
    bool allow_historical_small; /* Same-node old boot, exact frozen body only. */
    /* Only strict config_ack/lease replay+stateless reclamation. Reading these
     * records never grants current-boot capture authority. Default false. */
    bool allow_historical_control_reclaim;
} cp_v3_queue_profile_config_t;
#define CP_V3_QUEUE_TOMBSTONE_BYTES 96u
bool cp_v3_queue_tombstone_encode(const cp_v3_queue_tombstone_t *,void *,size_t);
bool cp_v3_queue_tombstone_decode(const void *,size_t,cp_v3_queue_tombstone_t *);
/* Pure full-record CRC/body-SHA/full-SHA verification for storage transaction
 * recovery. Output is identity metadata, NOT an expiry decision/tombstone. An
 * older legacy record can have source_expires_at_ms==0. No body is modified. */
bool cp_v3_queue_record_check(const void *,size_t,unsigned slot,cp_v3_sha256_fn,void *,cp_v3_queue_tombstone_t *identity);
/* load: 0 absent, 1 record, 2 occupied/torn/foreign, 3 minimal expired tombstone
 * (slot reusable), 4 tombstone plus uncertain occupied files, -1 IO. A tombstone
 * carries CP_V3_QUEUE_TOMBSTONE_BYTES encoded bytes for peak ordinal recovery.
 * An invalid record
 * must never be treated as absent. store must refuse an occupied slot, atomically
 * publish and sync before success. reclaim may run ONLY after matched receipt;
 * uncertain failures must preserve/occupy the slot until reopen. No formatting.
 * All calls are serialized by one worker; callbacks must own storage arbitration.
 */
typedef struct {
    void *context;
    int (*load)(void *, unsigned, void *, size_t, size_t *);
    bool (*store)(void *, unsigned, const void *, size_t);
    bool (*reclaim)(void *, unsigned, const void *, size_t);
} cp_v3_queue_store_t;
typedef struct {
    cp_v3_queue_state_t state;
    cp_v3_queue_kind_t kind;
    cp_v3_queue_profile_t profile;
    cp_v3_queue_limits_t limits;
    uint64_t ordinal;
    uint64_t source_expires_at_ms;
    cp_v3_expected_t expected;
    uint8_t record_sha256[32];
} cp_v3_queue_slot_t;
typedef struct {
    cp_v3_queue_store_t store;
    cp_v3_sha256_fn sha256;
    void *sha_context;
    char node_id[65], boot_id[37];
    cp_v3_queue_slot_t slots[CP_V3_QUEUE_SLOTS];
    uint64_t next_ordinal;
    uint32_t io_failures, corrupt_slots, retired_slots, historical_slots;
    uint64_t expired_items, expired_bytes;
    cp_v3_queue_profile_config_t config;
    uint8_t scratch[CP_V3_QUEUE_SLOT_BYTES];
    bool ready;
} cp_v3_queue_t;
/* Caller-owned static/RAM state; do not put on a small worker stack. Legacy old
 * boots quarantine; historical small source replay requires explicit opt-in. */
cp_v3_queue_result_t cp_v3_queue_open(cp_v3_queue_t *, cp_v3_queue_store_t,
    const char *node_id, const char *boot_id, cp_v3_sha256_fn, void *);
/* SMALL_RESULTS requires both retention callbacks. Old v1/profile/boot records
 * remain occupied and unchanged; a trusted expiry can remove only v2 records
 * whose original recorded source-retention deadline has elapsed. */
cp_v3_queue_result_t cp_v3_queue_open_profile(cp_v3_queue_t *, cp_v3_queue_store_t,
    const char *,const char *,cp_v3_sha256_fn,void *,const cp_v3_queue_profile_config_t *);
cp_v3_queue_result_t cp_v3_queue_push(cp_v3_queue_t *, cp_v3_queue_kind_t,
    const cp_v3_expected_t *, const void *body, size_t length, unsigned *slot);
cp_v3_queue_result_t cp_v3_queue_push_expiring(cp_v3_queue_t *,cp_v3_queue_kind_t,
    const cp_v3_expected_t *,const void *,size_t,uint64_t source_expires_at_ms,unsigned *);
/* Call periodically even when offline; reads/ACKs/pushes also invoke this sweep.
 * Unknown UTC fails closed; no body is uploaded or expiry falsely reported. */
cp_v3_queue_result_t cp_v3_queue_expire(cp_v3_queue_t *);
cp_v3_queue_result_t cp_v3_queue_oldest(const cp_v3_queue_t *, cp_v3_queue_kind_t, unsigned *slot);
cp_v3_queue_result_t cp_v3_queue_read(cp_v3_queue_t *, unsigned, void *, size_t,
    size_t *, cp_v3_expected_t *);
/* Only ingestion streams use this built-in matcher. Control requires the
 * separate strict frozen-body-aware ack_control verifier below. */
cp_v3_queue_result_t cp_v3_queue_ack(cp_v3_queue_t *, unsigned, const void *, size_t);
typedef bool (*cp_v3_queue_control_match_fn)(void *,const cp_v3_expected_t *,
    const void *frozen_body,size_t,const void *receipt,size_t);
/* verifier is a reviewed strict protocol parser, not an HTTP-status/bool flag.
 * It must be pure and must not reenter this queue or modify frozen bytes. */
cp_v3_queue_result_t cp_v3_queue_ack_control(cp_v3_queue_t *,unsigned,const void *,size_t,
    cp_v3_queue_control_match_fn,void *);
unsigned cp_v3_queue_pending(const cp_v3_queue_t *, cp_v3_queue_kind_t);
size_t cp_v3_queue_pending_bytes(const cp_v3_queue_t *, cp_v3_queue_kind_t);
unsigned cp_v3_queue_capacity(const cp_v3_queue_t *,cp_v3_queue_kind_t);
size_t cp_v3_queue_encoded_size(const cp_v3_queue_t *,size_t body_bytes);
