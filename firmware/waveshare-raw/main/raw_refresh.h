#pragma once

#include <stdbool.h>
#include <stdint.h>

#define RAW_REFRESH_WIDTH 200u
#define RAW_REFRESH_HEIGHT 200u
#define RAW_REFRESH_ROW_BYTES (RAW_REFRESH_WIDTH / 8u)
#define RAW_REFRESH_FRAME_BYTES (RAW_REFRESH_ROW_BYTES * RAW_REFRESH_HEIGHT)
#define RAW_REFRESH_PARTIAL_LIMIT 20u
#define RAW_REFRESH_FULL_INTERVAL_MS 60000ULL
#define RAW_REFRESH_FULL_AREA_PERCENT 90u

typedef enum {
    RAW_REFRESH_NONE = 0,
    RAW_REFRESH_FULL,
    RAW_REFRESH_PARTIAL,
} raw_refresh_mode_t;

typedef struct {
    raw_refresh_mode_t mode;
    /* Inclusive bounds. X is a byte column (0..24), not a pixel coordinate. */
    uint8_t x0, x1, y0, y1;
} raw_refresh_plan_t;

typedef struct {
    bool valid;
    uint8_t page;
    uint32_t partial_count;
    uint64_t last_full_ms;
    uint64_t last_commit_ms;
} raw_refresh_state_t;

/*
 * Zero-initialize state. The caller serializes calls and retains the last
 * successfully displayed 5000-byte frame as old_frame. Neither planning nor
 * committing copies frame data. After hardware success, copy the new frame to
 * that baseline and commit; after failure keep the old frame and invalidate.
 *
 * Planning is read-only. A missing baseline, page change, explicit force, or
 * clock rollback requests a full refresh even for identical pixels. Otherwise
 * unchanged pixels return NONE; periodic cleaning waits for an actual change.
 * FULL bounds cover the whole panel; NONE bounds are all zero.
 */
raw_refresh_plan_t raw_refresh_plan(const raw_refresh_state_t *state,
                                    const uint8_t *old_frame,
                                    const uint8_t *new_frame, uint8_t page,
                                    uint64_t now_ms, bool force_full);

/* Call only after the complete hardware update succeeds. NONE is a no-op. */
void raw_refresh_commit(raw_refresh_state_t *state,
                        const raw_refresh_plan_t *plan, uint8_t page,
                        uint64_t now_ms);

/* A failed/uncertain hardware update makes the next plan a full refresh. */
void raw_refresh_invalidate(raw_refresh_state_t *state);
