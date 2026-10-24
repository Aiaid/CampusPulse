#include "cp_upload_scheduler.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

static void pending(cp_upload_scheduler_t *scheduler, cp_journal_slot_t *slots, unsigned slot,
                    unsigned stream, uint64_t ordinal) {
    slots[slot] = (cp_journal_slot_t){.state = CP_SLOT_PENDING, .ordinal = ordinal, .length = 100};
    assert(cp_upload_scheduler_bind(scheduler, (uint16_t)slot, stream));
}

static void test_stream_fairness(void) {
    cp_upload_scheduler_t scheduler;
    cp_journal_slot_t slots[12] = {0};
    cp_upload_scheduler_init(&scheduler);
    for (unsigned stream = 0; stream < 4; ++stream)
        for (unsigned batch = 0; batch < 3; ++batch)
            pending(&scheduler, slots, stream + batch * 4, stream, batch * 4 + stream + 1);
    /* A permanently busy stream gets one turn per complete round. */
    for (unsigned round = 0; round < 3; ++round)
        for (unsigned stream = 0; stream < 4; ++stream) {
            unsigned expected = stream + round * 4;
            assert(cp_upload_scheduler_select(&scheduler, slots, 12, 0) == expected);
            slots[expected].state = CP_SLOT_ACKED;
            cp_upload_scheduler_confirmed(&scheduler, (uint16_t)expected);
        }
    assert(cp_upload_scheduler_select(&scheduler, slots, 12, 0) == CP_UPLOAD_NO_SLOT);
}

static void test_retry_head_prevents_same_stream_overtaking(void) {
    cp_upload_scheduler_t scheduler;
    cp_journal_slot_t slots[5] = {0};
    cp_upload_scheduler_init(&scheduler);
    pending(&scheduler, slots, 0, 0, 20); /* physical slot order is not ordinal order */
    pending(&scheduler, slots, 1, 0, 10);
    pending(&scheduler, slots, 2, 1, 30);
    pending(&scheduler, slots, 3, 2, 40);
    pending(&scheduler, slots, 4, 3, 50);
    assert(cp_upload_scheduler_select(&scheduler, slots, 5, 100) == 1);
    assert(cp_upload_scheduler_retry(&scheduler, 1, 100, 7) == 1107);
    for (unsigned stream = 1; stream < 4; ++stream) {
        unsigned slot = stream + 1;
        assert(cp_upload_scheduler_select(&scheduler, slots, 5, 1106) == slot);
        slots[slot].state = CP_SLOT_ACKED;
    }
    uint8_t cursor = scheduler.next_stream;
    assert(cp_upload_scheduler_select(&scheduler, slots, 5, 1106) == CP_UPLOAD_NO_SLOT);
    assert(scheduler.next_stream == cursor);
    assert(cp_upload_scheduler_select(&scheduler, slots, 5, 1107) == 1);
    slots[1].state = CP_SLOT_ACKED;
    assert(cp_upload_scheduler_select(&scheduler, slots, 5, 1107) == 0);
}

static void test_blocked_and_nonpending_slots(void) {
    cp_upload_scheduler_t scheduler;
    cp_journal_slot_t slots[6] = {0};
    cp_upload_scheduler_init(&scheduler);
    for (unsigned i = 0; i < 6; ++i)
        pending(&scheduler, slots, i, 0, i + 1);
    slots[0].state = CP_SLOT_FREE;
    slots[1].state = CP_SLOT_ACKED;
    slots[2].state = CP_SLOT_QUARANTINED;
    cp_upload_scheduler_block(&scheduler, 3);
    assert(!cp_upload_scheduler_bind(&scheduler, 4, 99));
    assert(cp_upload_scheduler_select(&scheduler, slots, 6, 0) == 5);
    /* A blocked old receipt remains pending evidence, even while later data advances. */
    assert(slots[3].state == CP_SLOT_PENDING && scheduler.blocked[3]);
}

static void test_exponential_backoff_and_reset(void) {
    cp_upload_scheduler_t scheduler;
    cp_journal_slot_t slots[2] = {0};
    cp_upload_scheduler_init(&scheduler);
    pending(&scheduler, slots, 0, 0, 1);
    pending(&scheduler, slots, 1, 1, 2);
    const uint64_t delays[] = {1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000};
    uint64_t now = 0;
    for (unsigned i = 0; i < sizeof(delays) / sizeof(delays[0]); ++i) {
        uint64_t deadline = cp_upload_scheduler_retry(&scheduler, 0, now, 249);
        assert(deadline == now + delays[i] + 249);
        assert(scheduler.retry_exp[1] == 0 && scheduler.retry_at[1] == 0);
        now = deadline;
    }
    cp_upload_scheduler_confirmed(&scheduler, 0);
    assert(!scheduler.retry_exp[0] && !scheduler.retry_at[0]);
    assert(cp_upload_scheduler_retry(&scheduler, 0, 10000, 500) == 11000);
    cp_upload_scheduler_block(&scheduler, 0);
    pending(&scheduler, slots, 0, 3, 100); /* journal slot reused for a different frozen body */
    assert(!scheduler.retry_exp[0] && !scheduler.retry_at[0] && !scheduler.blocked[0]);
    assert(scheduler.stream[0] == 3);
    assert(cp_upload_scheduler_retry(&scheduler, 0, 0, 250) == 1000);
}

static void test_unknown_metadata_discovery_lane(void) {
    cp_upload_scheduler_t scheduler;
    cp_journal_slot_t slots[5] = {0};
    cp_upload_scheduler_init(&scheduler);
    for (unsigned i = 0; i < 4; ++i)
        pending(&scheduler, slots, i, i, i + 10);
    slots[4] = (cp_journal_slot_t){.state = CP_SLOT_PENDING, .ordinal = 20, .length = 100};
    for (unsigned i = 0; i < 5; ++i)
        assert(cp_upload_scheduler_select(&scheduler, slots, 5, 0) == i);
    /* OOM/read IO during discovery backs off, without blocking known streams. */
    assert(cp_upload_scheduler_retry(&scheduler, 4, 0, 0) == 1000);
    for (unsigned i = 0; i < 4; ++i)
        assert(cp_upload_scheduler_select(&scheduler, slots, 5, 999) == i);
    assert(cp_upload_scheduler_select(&scheduler, slots, 5, 1000) == 4);
    /* Binding after discovery is not an upload grant: reselecting respects the
     * newly known stream's original delayed head. */
    assert(cp_upload_scheduler_bind(&scheduler, 4, 0));
    assert(cp_upload_scheduler_retry(&scheduler, 0, 1000, 0) == 2000);
    for (unsigned i = 1; i < 4; ++i)
        slots[i].state = CP_SLOT_ACKED;
    assert(cp_upload_scheduler_select(&scheduler, slots, 5, 1999) == CP_UPLOAD_NO_SLOT);
    assert(cp_upload_scheduler_select(&scheduler, slots, 5, 2000) == 0);
    slots[0].state = CP_SLOT_ACKED;
    assert(cp_upload_scheduler_select(&scheduler, slots, 5, 2000) == 4);
}

static void test_bounds_and_overflow(void) {
    cp_upload_scheduler_t scheduler;
    cp_journal_slot_t slots[CP_JOURNAL_MAX_SLOTS] = {0};
    cp_upload_scheduler_init(&scheduler);
    pending(&scheduler, slots, CP_JOURNAL_MAX_SLOTS - 1, 2, UINT64_MAX);
    assert(cp_upload_scheduler_retry(&scheduler, CP_JOURNAL_MAX_SLOTS - 1, UINT64_MAX - 10, 249) ==
           UINT64_MAX);
    assert(cp_upload_scheduler_select(&scheduler, slots, CP_JOURNAL_MAX_SLOTS, UINT64_MAX - 1) ==
           CP_UPLOAD_NO_SLOT);
    assert(cp_upload_scheduler_select(&scheduler, slots, CP_JOURNAL_MAX_SLOTS, UINT64_MAX) ==
           CP_JOURNAL_MAX_SLOTS - 1);
    assert(!cp_upload_scheduler_bind(&scheduler, CP_JOURNAL_MAX_SLOTS, 0));
    assert(cp_upload_scheduler_retry(&scheduler, CP_JOURNAL_MAX_SLOTS, 0, 0) == 0);
    assert(cp_upload_scheduler_select(&scheduler, slots, CP_JOURNAL_MAX_SLOTS + 1, 0) ==
           CP_UPLOAD_NO_SLOT);
    assert(cp_upload_scheduler_select(NULL, slots, 1, 0) == CP_UPLOAD_NO_SLOT);
    assert(cp_upload_scheduler_select(&scheduler, NULL, 1, 0) == CP_UPLOAD_NO_SLOT);
}

int main(void) {
    test_stream_fairness();
    test_retry_head_prevents_same_stream_overtaking();
    test_blocked_and_nonpending_slots();
    test_exponential_backoff_and_reset();
    test_bounds_and_overflow();
    test_unknown_metadata_discovery_lane();
    puts("upload scheduler: 6 fairness, ordering, backoff, reuse and boundary groups passed");
    return 0;
}
