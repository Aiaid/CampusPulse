#include "raw_refresh.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

static uint8_t baseline[RAW_REFRESH_FRAME_BYTES];
static uint8_t candidate[RAW_REFRESH_FRAME_BYTES];

static void assert_full(raw_refresh_plan_t plan) {
    assert(plan.mode == RAW_REFRESH_FULL);
    assert(plan.x0 == 0 && plan.x1 == 24);
    assert(plan.y0 == 0 && plan.y1 == 199);
}

static raw_refresh_state_t initialized(uint64_t now_ms) {
    raw_refresh_state_t state = {0};
    memset(baseline, 0xff, sizeof baseline);
    memset(candidate, 0xff, sizeof candidate);
    raw_refresh_plan_t plan = raw_refresh_plan(&state, baseline, candidate,
                                              0, now_ms, false);
    assert_full(plan); /* Even an entirely white initial image must refresh. */
    assert(!state.valid); /* Planning cannot establish a hardware baseline. */
    raw_refresh_commit(&state, &plan, 0, now_ms);
    assert(state.valid && state.partial_count == 0);
    assert(state.last_full_ms == now_ms && state.last_commit_ms == now_ms);
    return state;
}

static void test_identical_frame_and_planning_are_read_only(void) {
    raw_refresh_state_t state = initialized(1000);
    raw_refresh_state_t before = state;
    raw_refresh_plan_t plan = raw_refresh_plan(&state, baseline, candidate,
                                              0, 2000, false);
    assert(plan.mode == RAW_REFRESH_NONE);
    assert(plan.x0 == 0 && plan.x1 == 0 && plan.y0 == 0 && plan.y1 == 0);
    assert(memcmp(&before, &state, sizeof state) == 0);
    raw_refresh_commit(&state, &plan, 3, 2000);
    assert(memcmp(&before, &state, sizeof state) == 0);

    state.partial_count = RAW_REFRESH_PARTIAL_LIMIT;
    plan = raw_refresh_plan(&state, baseline, candidate, 0, 61000, false);
    assert(plan.mode == RAW_REFRESH_NONE); /* No periodic blink while idle. */
}

static void test_actual_frame_bytes_and_aligned_dirty_bounds(void) {
    raw_refresh_state_t state = initialized(1000);
    /* The same changed-bit count at distinct byte/row positions is different. */
    candidate[10u * RAW_REFRESH_ROW_BYTES + 7u] ^= 0x01;
    candidate[16u * RAW_REFRESH_ROW_BYTES + 8u] ^= 0x80;
    raw_refresh_state_t before = state;
    raw_refresh_plan_t plan = raw_refresh_plan(&state, baseline, candidate,
                                              0, 2000, false);
    assert(plan.mode == RAW_REFRESH_PARTIAL);
    assert(plan.x0 == 7 && plan.x1 == 8 && plan.y0 == 10 && plan.y1 == 16);
    assert(memcmp(&before, &state, sizeof state) == 0);
    raw_refresh_commit(&state, &plan, 0, 2000);
    memcpy(baseline, candidate, sizeof baseline);
    assert(state.partial_count == 1 && state.last_full_ms == 1000);

    candidate[10u * RAW_REFRESH_ROW_BYTES + 7u] ^= 0x01;
    candidate[16u * RAW_REFRESH_ROW_BYTES + 8u] ^= 0x80;
    candidate[11u * RAW_REFRESH_ROW_BYTES + 9u] ^= 0x01;
    candidate[17u * RAW_REFRESH_ROW_BYTES + 10u] ^= 0x80;
    assert(memcmp(candidate, baseline, sizeof baseline) != 0);
    plan = raw_refresh_plan(&state, baseline, candidate, 0, 3000, false);
    assert(plan.mode == RAW_REFRESH_PARTIAL);
    assert(plan.x0 == 7 && plan.x1 == 10 && plan.y0 == 10 && plan.y1 == 17);

    state = initialized(0);
    candidate[0] ^= 0x80;
    plan = raw_refresh_plan(&state, baseline, candidate, 0, 1, false);
    assert(plan.mode == RAW_REFRESH_PARTIAL);
    assert(plan.x0 == 0 && plan.x1 == 0 && plan.y0 == 0 && plan.y1 == 0);
    candidate[0] ^= 0x80;
    candidate[RAW_REFRESH_FRAME_BYTES - 1] ^= 0x01;
    plan = raw_refresh_plan(&state, baseline, candidate, 0, 1, false);
    assert(plan.mode == RAW_REFRESH_PARTIAL);
    assert(plan.x0 == 24 && plan.x1 == 24 && plan.y0 == 199 && plan.y1 == 199);
}

static void test_page_force_and_missing_baseline(void) {
    raw_refresh_state_t state = initialized(1000);
    assert_full(raw_refresh_plan(&state, baseline, candidate, 1, 2000, false));
    assert_full(raw_refresh_plan(&state, baseline, candidate, 0, 2000, true));
    assert_full(raw_refresh_plan(&state, NULL, candidate, 0, 2000, false));
    raw_refresh_plan_t plan = raw_refresh_plan(&state, baseline, candidate,
                                              1, 2000, false);
    raw_refresh_commit(&state, &plan, 1, 2000);
    assert(state.page == 1 && state.last_full_ms == 2000);
    assert(raw_refresh_plan(&state, baseline, candidate, 1, 3000, false).mode ==
           RAW_REFRESH_NONE);
}

static void test_partial_count_and_elapsed_cleaning_boundaries(void) {
    raw_refresh_state_t state = initialized(1000);
    for (unsigned i = 0; i < RAW_REFRESH_PARTIAL_LIMIT; ++i) {
        candidate[0] ^= 1;
        raw_refresh_plan_t plan = raw_refresh_plan(&state, baseline, candidate,
                                                  0, 1001 + i, false);
        assert(plan.mode == RAW_REFRESH_PARTIAL);
        raw_refresh_commit(&state, &plan, 0, 1001 + i);
        memcpy(baseline, candidate, sizeof baseline);
        assert(state.partial_count == i + 1);
    }
    candidate[0] ^= 1;
    raw_refresh_plan_t plan = raw_refresh_plan(&state, baseline, candidate,
                                              0, 2000, false);
    assert_full(plan);
    assert(state.partial_count == RAW_REFRESH_PARTIAL_LIMIT);
    raw_refresh_commit(&state, &plan, 0, 2000);
    assert(state.partial_count == 0 && state.last_full_ms == 2000);

    state = initialized(1000);
    candidate[0] ^= 1;
    assert(raw_refresh_plan(&state, baseline, candidate, 0, 60999, false).mode ==
           RAW_REFRESH_PARTIAL);
    assert_full(raw_refresh_plan(&state, baseline, candidate, 0, 61000, false));
    assert_full(raw_refresh_plan(&state, baseline, candidate, 0, 61001, false));
}

static void test_dirty_bounding_area_threshold(void) {
    raw_refresh_state_t state = initialized(1000);
    /* Sparse corner changes still require their whole bounding rectangle. */
    candidate[0] ^= 1;
    candidate[179u * RAW_REFRESH_ROW_BYTES + 24u] ^= 1;
    raw_refresh_plan_t plan = raw_refresh_plan(&state, baseline, candidate,
                                              0, 2000, false);
    assert(plan.mode == RAW_REFRESH_PARTIAL); /* Exactly 90% is allowed. */
    assert(plan.x0 == 0 && plan.x1 == 24 && plan.y0 == 0 && plan.y1 == 179);
    candidate[180u * RAW_REFRESH_ROW_BYTES + 24u] ^= 1;
    assert_full(raw_refresh_plan(&state, baseline, candidate, 0, 2000, false));
}

static void test_failure_does_not_commit_and_invalidates_baseline(void) {
    raw_refresh_state_t state = initialized(1000);
    candidate[10] ^= 1;
    raw_refresh_state_t before = state;
    uint8_t old_byte = baseline[10];
    raw_refresh_plan_t plan = raw_refresh_plan(&state, baseline, candidate,
                                              0, 2000, false);
    assert(plan.mode == RAW_REFRESH_PARTIAL);
    /* Failed hardware: no commit and no copy into the caller's baseline. */
    assert(memcmp(&before, &state, sizeof state) == 0);
    assert(baseline[10] == old_byte);
    raw_refresh_invalidate(&state);
    assert(!state.valid);
    assert(state.partial_count == before.partial_count);
    assert(state.last_full_ms == before.last_full_ms);
    assert(state.last_commit_ms == before.last_commit_ms);
    assert_full(raw_refresh_plan(&state, baseline, candidate, 0, 2001, false));
    assert_full(raw_refresh_plan(&state, baseline, baseline, 0, 2001, false));

    plan = raw_refresh_plan(&state, baseline, candidate, 0, 2002, false);
    raw_refresh_commit(&state, &plan, 0, 2002);
    memcpy(baseline, candidate, sizeof baseline);
    assert(state.valid && state.partial_count == 0 && state.last_full_ms == 2002);
    assert(raw_refresh_plan(&state, baseline, candidate, 0, 2003, false).mode ==
           RAW_REFRESH_NONE);
}

static void test_monotonic_clock_rollback_rebases_after_success(void) {
    raw_refresh_state_t state = initialized(1000);
    candidate[0] ^= 1;
    raw_refresh_plan_t plan = raw_refresh_plan(&state, baseline, candidate,
                                              0, 5000, false);
    raw_refresh_commit(&state, &plan, 0, 5000);
    memcpy(baseline, candidate, sizeof baseline);
    /* Rollback after a partial can remain later than the last full refresh. */
    assert_full(raw_refresh_plan(&state, baseline, candidate, 0, 4999, false));
    plan = raw_refresh_plan(&state, baseline, candidate, 0, 500, false);
    assert_full(plan);
    assert(state.last_commit_ms == 5000 && state.partial_count == 1);
    raw_refresh_commit(&state, &plan, 0, 500);
    assert(state.last_full_ms == 500 && state.last_commit_ms == 500);
    assert(state.partial_count == 0);
    candidate[0] ^= 1;
    assert(raw_refresh_plan(&state, baseline, candidate, 0, 501, false).mode ==
           RAW_REFRESH_PARTIAL);
}

int main(void) {
    test_identical_frame_and_planning_are_read_only();
    test_actual_frame_bytes_and_aligned_dirty_bounds();
    test_page_force_and_missing_baseline();
    test_partial_count_and_elapsed_cleaning_boundaries();
    test_dirty_bounding_area_threshold();
    test_failure_does_not_commit_and_invalidates_baseline();
    test_monotonic_clock_rollback_rebases_after_success();
    puts("raw refresh host tests passed");
    return 0;
}
