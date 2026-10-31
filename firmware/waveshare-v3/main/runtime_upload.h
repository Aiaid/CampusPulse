#pragma once
#include "cp_v3_queue.h"
#include <string.h>

/* Pure RAM selection only. The caller serializes queue access and still reads
 * and verifies the exact frozen record before attempting upload or receipt ACK.
 * Backoff/exhaustion belongs to a body identity, never to a reusable slot. */
static inline cp_v3_queue_result_t edge_upload_oldest_ready(
    const cp_v3_queue_t *queue, cp_v3_queue_kind_t kind, uint64_t now,
    const char attempt_hash[CP_V3_QUEUE_SLOTS][65],
    const uint32_t attempts[CP_V3_QUEUE_SLOTS],
    const uint64_t next_attempt[CP_V3_QUEUE_SLOTS], uint32_t max_attempts,
    unsigned *out)
{
    if (!queue || !queue->ready || (unsigned)kind > CP_V3_QUEUE_EVENT ||
        !attempt_hash || !attempts || !next_attempt || !max_attempts || !out)
        return CP_V3_QUEUE_INVALID;

    unsigned best = CP_V3_QUEUE_SLOTS;
    for (unsigned i = 0; i < CP_V3_QUEUE_SLOTS; ++i) {
        const cp_v3_queue_slot_t *slot = &queue->slots[i];
        if (slot->state != CP_V3_QUEUE_PENDING || slot->kind != kind)
            continue;
        /* Compare the bounded full SHA string, including its terminator. No
         * retry state is consumed when a reclaimed slot contains a new body. */
        bool tracked = memcmp(slot->expected.body_sha256, attempt_hash[i],
                              sizeof slot->expected.body_sha256) == 0;
        if (tracked && (attempts[i] >= max_attempts || next_attempt[i] > now))
            continue;
        if (best == CP_V3_QUEUE_SLOTS || slot->ordinal < queue->slots[best].ordinal)
            best = i;
    }
    if (best == CP_V3_QUEUE_SLOTS)
        return CP_V3_QUEUE_NOT_FOUND;
    *out = best;
    return CP_V3_QUEUE_OK;
}

/* Counts accepted records, not occupied slots. Historical pending bodies remain
 * untouched and are deliberately excluded from current-boot progress. The sum
 * is wide enough for all 12 uint32_t accepted_count values without wrapping. */
static inline uint64_t edge_upload_pending_current(
    const cp_v3_queue_t *queue, cp_v3_queue_kind_t kind, const char *current_boot)
{
    if (!queue || !queue->ready || (unsigned)kind > CP_V3_QUEUE_EVENT ||
        !current_boot || !*current_boot)
        return 0;
    uint64_t count = 0;
    for (unsigned i = 0; i < CP_V3_QUEUE_SLOTS; ++i) {
        const cp_v3_queue_slot_t *slot = &queue->slots[i];
        if (slot->state == CP_V3_QUEUE_PENDING && slot->kind == kind &&
            memchr(slot->expected.scope.boot_id, '\0',
                   sizeof slot->expected.scope.boot_id) &&
            strncmp(slot->expected.scope.boot_id, current_boot,
                    sizeof slot->expected.scope.boot_id) == 0)
            count += slot->expected.accepted_count;
    }
    return count;
}
