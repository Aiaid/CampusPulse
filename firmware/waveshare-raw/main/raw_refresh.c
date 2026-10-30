#include "raw_refresh.h"

#include <string.h>

static raw_refresh_plan_t full_plan(void) {
    return (raw_refresh_plan_t){
        .mode = RAW_REFRESH_FULL,
        .x0 = 0,
        .x1 = RAW_REFRESH_ROW_BYTES - 1u,
        .y0 = 0,
        .y1 = RAW_REFRESH_HEIGHT - 1u,
    };
}

raw_refresh_plan_t raw_refresh_plan(const raw_refresh_state_t *state,
                                    const uint8_t *old_frame,
                                    const uint8_t *new_frame, uint8_t page,
                                    uint64_t now_ms, bool force_full) {
    if (!state->valid || !old_frame || force_full || page != state->page ||
        now_ms < state->last_commit_ms || now_ms < state->last_full_ms)
        return full_plan();

    if (memcmp(old_frame, new_frame, RAW_REFRESH_FRAME_BYTES) == 0)
        return (raw_refresh_plan_t){.mode = RAW_REFRESH_NONE};

    raw_refresh_plan_t plan = {
        .mode = RAW_REFRESH_PARTIAL,
        .x0 = RAW_REFRESH_ROW_BYTES - 1u,
        .x1 = 0,
        .y0 = RAW_REFRESH_HEIGHT - 1u,
        .y1 = 0,
    };
    for (unsigned y = 0; y < RAW_REFRESH_HEIGHT; ++y) {
        unsigned row = y * RAW_REFRESH_ROW_BYTES;
        if (memcmp(old_frame + row, new_frame + row,
                   RAW_REFRESH_ROW_BYTES) == 0)
            continue;
        if (y < plan.y0) plan.y0 = (uint8_t)y;
        if (y > plan.y1) plan.y1 = (uint8_t)y;
        for (unsigned x = 0; x < RAW_REFRESH_ROW_BYTES; ++x) {
            if (old_frame[row + x] == new_frame[row + x]) continue;
            if (x < plan.x0) plan.x0 = (uint8_t)x;
            if (x > plan.x1) plan.x1 = (uint8_t)x;
        }
    }

    unsigned dirty_bytes = (unsigned)(plan.x1 - plan.x0 + 1u) *
                           (unsigned)(plan.y1 - plan.y0 + 1u);
    if (state->partial_count >= RAW_REFRESH_PARTIAL_LIMIT ||
        now_ms - state->last_full_ms >= RAW_REFRESH_FULL_INTERVAL_MS ||
        dirty_bytes * 100u > RAW_REFRESH_FRAME_BYTES * RAW_REFRESH_FULL_AREA_PERCENT)
        return full_plan();
    return plan;
}

void raw_refresh_commit(raw_refresh_state_t *state,
                        const raw_refresh_plan_t *plan, uint8_t page,
                        uint64_t now_ms) {
    if (plan->mode != RAW_REFRESH_FULL && plan->mode != RAW_REFRESH_PARTIAL)
        return;
    if (plan->mode == RAW_REFRESH_FULL) {
        state->partial_count = 0;
        state->last_full_ms = now_ms;
    } else if (state->partial_count < UINT32_MAX) {
        ++state->partial_count;
    }
    state->valid = true;
    state->page = page;
    state->last_commit_ms = now_ms;
}

void raw_refresh_invalidate(raw_refresh_state_t *state) {
    state->valid = false;
}
