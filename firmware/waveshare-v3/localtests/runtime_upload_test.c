#include "runtime_upload.h"
#include <assert.h>
#include <stdio.h>

static cp_v3_queue_t queue, original;
static char attempt_hash[CP_V3_QUEUE_SLOTS][65];
static uint32_t attempts[CP_V3_QUEUE_SLOTS];
static uint64_t next_attempt[CP_V3_QUEUE_SLOTS];
static const char *boot = "00000000-0000-4000-8000-000000000001";
static const char *old_boot = "00000000-0000-4000-8000-000000000002";

static void pending(unsigned i, cp_v3_queue_kind_t kind, uint64_t ordinal,
                    char hash, const char *source_boot, uint32_t count)
{
    cp_v3_queue_slot_t *slot = &queue.slots[i];
    slot->state = CP_V3_QUEUE_PENDING;
    slot->kind = kind;
    slot->ordinal = ordinal;
    memset(slot->expected.body_sha256, hash, 64);
    slot->expected.body_sha256[64] = '\0';
    strcpy(slot->expected.scope.boot_id, source_boot);
    slot->expected.accepted_count = count;
}

static void track(unsigned i, uint32_t count, uint64_t next)
{
    memcpy(attempt_hash[i], queue.slots[i].expected.body_sha256, 65);
    attempts[i] = count;
    next_attempt[i] = next;
}

static cp_v3_queue_result_t oldest(cp_v3_queue_kind_t kind, uint64_t now,
                                   unsigned *out)
{
    cp_v3_queue_t before = queue;
    char hashes_before[CP_V3_QUEUE_SLOTS][65];
    uint32_t attempts_before[CP_V3_QUEUE_SLOTS];
    uint64_t next_before[CP_V3_QUEUE_SLOTS];
    memcpy(hashes_before, attempt_hash, sizeof hashes_before);
    memcpy(attempts_before, attempts, sizeof attempts_before);
    memcpy(next_before, next_attempt, sizeof next_before);
    cp_v3_queue_result_t result = edge_upload_oldest_ready(
        &queue, kind, now, attempt_hash, attempts, next_attempt, 3, out);
    assert(!memcmp(&queue, &before, sizeof queue));
    assert(!memcmp(attempt_hash, hashes_before, sizeof attempt_hash));
    assert(!memcmp(attempts, attempts_before, sizeof attempts));
    assert(!memcmp(next_attempt, next_before, sizeof next_attempt));
    return result;
}

int main(void)
{
    queue.ready = true;
    /* Physical slot order is deliberately unrelated to insertion order. */
    pending(8, CP_V3_QUEUE_WINDOW, 10, 'a', old_boot, 2);
    pending(2, CP_V3_QUEUE_WINDOW, 11, 'b', boot, 5);
    pending(1, CP_V3_QUEUE_WINDOW, 20, 'c', boot, 3);
    pending(3, CP_V3_QUEUE_EVENT, 1, 'd', boot, 7);
    pending(4, CP_V3_QUEUE_STATUS, 2, 'e', boot, 1);
    pending(5, CP_V3_QUEUE_WINDOW, 0, 'f', boot, 100);
    queue.slots[5].state = CP_V3_QUEUE_QUARANTINED;
    pending(6, CP_V3_QUEUE_WINDOW, 0, '0', boot, 100);
    queue.slots[6].state = CP_V3_QUEUE_FREE;
    original = queue;

    unsigned slot = 99;
    assert(oldest(CP_V3_QUEUE_WINDOW, 100, &slot) == CP_V3_QUEUE_OK && slot == 8);
    track(8, 1, 101);
    assert(oldest(CP_V3_QUEUE_WINDOW, 100, &slot) == CP_V3_QUEUE_OK && slot == 2);
    assert(oldest(CP_V3_QUEUE_WINDOW, 101, &slot) == CP_V3_QUEUE_OK && slot == 8);
    /* Exhaustion retains the oldest body but cannot starve a later one. */
    track(8, 3, 0);
    assert(oldest(CP_V3_QUEUE_WINDOW, UINT64_MAX, &slot) == CP_V3_QUEUE_OK && slot == 2);
    track(2, 1, 150);
    track(1, 2, 200);
    slot = 99;
    assert(oldest(CP_V3_QUEUE_WINDOW, 100, &slot) == CP_V3_QUEUE_NOT_FOUND && slot == 99);
    assert(oldest(CP_V3_QUEUE_EVENT, 100, &slot) == CP_V3_QUEUE_OK && slot == 3);
    assert(oldest(CP_V3_QUEUE_CONTROL, 100, &slot) == CP_V3_QUEUE_NOT_FOUND);
    assert(!memcmp(&queue, &original, sizeof queue));

    /* Retry metadata for another body cannot suppress this slot. A new body at
     * an exhausted/backed-off slot starts fresh without clearing caller RAM. */
    memcpy(attempt_hash[2], attempt_hash[8], 65);
    attempts[2] = UINT32_MAX;
    next_attempt[2] = UINT64_MAX;
    assert(oldest(CP_V3_QUEUE_WINDOW, 100, &slot) == CP_V3_QUEUE_OK && slot == 2);
    track(2, 3, UINT64_MAX);
    queue.slots[2].expected.body_sha256[0] = '1';
    original = queue;
    assert(oldest(CP_V3_QUEUE_WINDOW, 100, &slot) == CP_V3_QUEUE_OK && slot == 2);
    assert(attempts[2] == 3 && next_attempt[2] == UINT64_MAX);
    assert(attempt_hash[2][0] == 'b' && attempt_hash[2][63] == 'b' && !attempt_hash[2][64]);
    assert(!memcmp(&queue, &original, sizeof queue));

    assert(edge_upload_pending_current(&queue, CP_V3_QUEUE_WINDOW, boot) == 8);
    assert(edge_upload_pending_current(&queue, CP_V3_QUEUE_WINDOW, old_boot) == 2);
    assert(edge_upload_pending_current(&queue, CP_V3_QUEUE_EVENT, boot) == 7);
    assert(edge_upload_pending_current(&queue, CP_V3_QUEUE_STATUS, boot) == 1);
    assert(edge_upload_pending_current(&queue, CP_V3_QUEUE_WINDOW, "other") == 0);
    assert(!memcmp(&queue, &original, sizeof queue));
    memset(queue.slots[1].expected.scope.boot_id, 'x',
           sizeof queue.slots[1].expected.scope.boot_id);
    assert(edge_upload_pending_current(&queue, CP_V3_QUEUE_WINDOW, boot) == 5);
    strcpy(queue.slots[1].expected.scope.boot_id, boot);
    queue.slots[1].expected.accepted_count = UINT32_MAX;
    queue.slots[2].expected.accepted_count = UINT32_MAX;
    assert(edge_upload_pending_current(&queue, CP_V3_QUEUE_WINDOW, boot) == 2ULL * UINT32_MAX);
    original = queue;

    assert(oldest((cp_v3_queue_kind_t)-1, 100, &slot) == CP_V3_QUEUE_INVALID);
    assert(oldest((cp_v3_queue_kind_t)99, 100, &slot) == CP_V3_QUEUE_INVALID);
    assert(oldest(CP_V3_QUEUE_WINDOW, 100, NULL) == CP_V3_QUEUE_INVALID);
    assert(edge_upload_oldest_ready(NULL, CP_V3_QUEUE_WINDOW, 100, attempt_hash,
                                   attempts, next_attempt, 3, &slot) == CP_V3_QUEUE_INVALID);
    assert(edge_upload_oldest_ready(&queue, CP_V3_QUEUE_WINDOW, 100, NULL,
                                   attempts, next_attempt, 3, &slot) == CP_V3_QUEUE_INVALID);
    assert(edge_upload_oldest_ready(&queue, CP_V3_QUEUE_WINDOW, 100, attempt_hash,
                                   NULL, next_attempt, 3, &slot) == CP_V3_QUEUE_INVALID);
    assert(edge_upload_oldest_ready(&queue, CP_V3_QUEUE_WINDOW, 100, attempt_hash,
                                   attempts, NULL, 3, &slot) == CP_V3_QUEUE_INVALID);
    assert(edge_upload_oldest_ready(&queue, CP_V3_QUEUE_WINDOW, 100, attempt_hash,
                                   attempts, next_attempt, 0, &slot) == CP_V3_QUEUE_INVALID);
    assert(edge_upload_pending_current(NULL, CP_V3_QUEUE_WINDOW, boot) == 0);
    assert(edge_upload_pending_current(&queue, CP_V3_QUEUE_WINDOW, NULL) == 0);
    assert(edge_upload_pending_current(&queue, CP_V3_QUEUE_WINDOW, "") == 0);
    assert(edge_upload_pending_current(&queue, (cp_v3_queue_kind_t)-1, boot) == 0);
    assert(!memcmp(&queue, &original, sizeof queue));
    queue.ready = false;
    assert(oldest(CP_V3_QUEUE_WINDOW, 100, &slot) == CP_V3_QUEUE_INVALID);
    assert(edge_upload_pending_current(&queue, CP_V3_QUEUE_WINDOW, boot) == 0);
    puts("Identity-scoped fair scheduling and current-boot pending progress passed");
    return 0;
}
