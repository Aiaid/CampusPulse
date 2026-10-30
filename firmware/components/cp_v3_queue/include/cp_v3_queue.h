#pragma once
#include "cp_v3_evidence.h"

#define CP_V3_QUEUE_FEATURE_SLOTS 8u
#define CP_V3_QUEUE_STATUS_SLOTS 2u
#define CP_V3_QUEUE_CONTROL_SLOTS 2u
#define CP_V3_QUEUE_SLOTS 12u
#define CP_V3_QUEUE_SLOT_BYTES 6144u
#define CP_V3_QUEUE_BODY_MAX 4096u
typedef enum { CP_V3_QUEUE_FEATURE, CP_V3_QUEUE_STATUS, CP_V3_QUEUE_CONTROL } cp_v3_queue_kind_t;
typedef enum { CP_V3_QUEUE_FREE, CP_V3_QUEUE_PENDING, CP_V3_QUEUE_QUARANTINED } cp_v3_queue_state_t;
typedef enum { CP_V3_QUEUE_OK, CP_V3_QUEUE_INVALID, CP_V3_QUEUE_FULL, CP_V3_QUEUE_IO,
    CP_V3_QUEUE_NOT_FOUND, CP_V3_QUEUE_MISMATCH, CP_V3_QUEUE_RETIRED } cp_v3_queue_result_t;
/* load: 0 absent, 1 record, 2 occupied/torn/foreign, -1 IO. An invalid record
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
    uint64_t ordinal;
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
    uint32_t io_failures, corrupt_slots, retired_slots;
    uint8_t scratch[CP_V3_QUEUE_SLOT_BYTES];
    bool ready;
} cp_v3_queue_t;
/* Caller-owned static/RAM state; do not put on a small worker stack. Old boot
 * records remain quarantined and cannot transmit under the current boot. */
cp_v3_queue_result_t cp_v3_queue_open(cp_v3_queue_t *, cp_v3_queue_store_t,
    const char *node_id, const char *boot_id, cp_v3_sha256_fn, void *);
cp_v3_queue_result_t cp_v3_queue_push(cp_v3_queue_t *, cp_v3_queue_kind_t,
    const cp_v3_expected_t *, const void *body, size_t length, unsigned *slot);
cp_v3_queue_result_t cp_v3_queue_oldest(const cp_v3_queue_t *, cp_v3_queue_kind_t, unsigned *slot);
cp_v3_queue_result_t cp_v3_queue_read(cp_v3_queue_t *, unsigned, void *, size_t,
    size_t *, cp_v3_expected_t *);
/* Only ingestion streams use this built-in matcher. Control reserves are
 * durable storage only: no generic HTTP/broker ACK can reclaim a control slot. */
cp_v3_queue_result_t cp_v3_queue_ack(cp_v3_queue_t *, unsigned, const void *, size_t);
unsigned cp_v3_queue_pending(const cp_v3_queue_t *, cp_v3_queue_kind_t);
size_t cp_v3_queue_pending_bytes(const cp_v3_queue_t *, cp_v3_queue_kind_t);
