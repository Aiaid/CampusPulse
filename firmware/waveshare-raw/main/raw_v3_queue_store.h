#pragma once
#include "cp_v3_queue.h"

/* Adapter for an ALREADY mounted volume. Caller serializes every queue operation
 * with all other TF users and keeps the mount alive. No mount/format/raw-file API.
 * directory is fixed by trusted caller (normally /sdcard/cpv3queue), not USB or
 * network input. sync_metadata must be the owning filesystem's metadata/media
 * synchronization contract; NULL selects POSIX directory fsync on host only.
 */
typedef struct {
    char directory[192];
    bool (*sync_metadata)(void *);
    void *sync_context;
    cp_v3_sha256_fn sha256;
    void *sha_context;
    uint8_t comparison[CP_V3_QUEUE_SLOT_BYTES];
} raw_v3_queue_store_t;
bool raw_v3_queue_store_prepare(raw_v3_queue_store_t *,const char *directory,
    bool (*sync_metadata)(void *),void *,cp_v3_queue_store_t *);
/* Enable full-record verification when recovering .rec plus retained .exp. */
void raw_v3_queue_store_set_hash(raw_v3_queue_store_t *,cp_v3_sha256_fn,void *);
/* Set profile_config.expire to this callback and retention_context to the same
 * raw_v3_queue_store_t if using a clock wrapper which also receives that context.
 * Writes a96-byte minimal tombstone before removing this exact expired record. */
bool raw_v3_queue_store_expire(void *,unsigned,const void *,size_t,const cp_v3_queue_tombstone_t *);
