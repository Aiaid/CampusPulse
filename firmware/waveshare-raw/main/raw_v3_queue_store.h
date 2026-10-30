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
    uint8_t comparison[CP_V3_QUEUE_SLOT_BYTES];
} raw_v3_queue_store_t;
bool raw_v3_queue_store_prepare(raw_v3_queue_store_t *,const char *directory,
    bool (*sync_metadata)(void *),void *,cp_v3_queue_store_t *);
