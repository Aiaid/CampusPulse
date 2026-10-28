#pragma once
#include <stdbool.h>
#include <stdint.h>
#include <limits.h>

typedef struct {
    uint64_t run;
    uint32_t clock, task_number;
} cp_perf_row_t;
typedef struct {
    uint64_t run_us;
    uint32_t interval_us, cpu_bp;
    /* 0 valid, 1 warmup, 2 missing/deleted, 3 recreated, 4 clock/gap,
     * 5 inconsistent task counter. UINT32_MAX is an unavailable percentage. */
    unsigned reason;
} cp_perf_delta_t;
static inline cp_perf_delta_t cp_perf_step(cp_perf_row_t *row, bool prior, bool present,
    uint64_t run, uint32_t clock, uint32_t task_number, unsigned bits, bool clock_valid) {
    cp_perf_delta_t out = {.cpu_bp = UINT32_MAX, .reason = 2};
    if (!present) return out;
    cp_perf_row_t previous = *row;
    *row = (cp_perf_row_t){.run = run, .clock = clock, .task_number = task_number};
    if (!prior) { out.reason = 1; return out; }
    if (task_number != previous.task_number) { out.reason = 3; return out; }
    out.interval_us = clock - previous.clock;
    /* IDF skips a task's switch-out interval across a U32 source-clock wrap.
     * Unsigned task-counter subtraction alone cannot restore that interval. */
    if (!clock_valid || !out.interval_us || (bits == 32 && clock < previous.clock)) {
        out.reason = 4;
        return out;
    }
    out.run_us = bits == 32 ? (uint32_t)((uint32_t)run - (uint32_t)previous.run)
                            : run - previous.run;
    if ((bits != 32 && bits != 64) || out.run_us > out.interval_us) {
        out.reason = 5;
        return out;
    }
    out.cpu_bp = (uint32_t)(out.run_us * 10000u / out.interval_us);
    out.reason = 0;
    return out;
}
typedef struct {
    uint64_t bytes, wall_us, max_us;
    uint32_t count;
} cp_perf_operation_stats_t;
static inline uint64_t cp_perf_add_u64(uint64_t a, uint64_t b) {
    return b > UINT64_MAX - a ? UINT64_MAX : a + b;
}
static inline void cp_perf_accumulate(cp_perf_operation_stats_t *out,
                                      uint64_t bytes, uint64_t elapsed_us) {
    if (out->count != UINT32_MAX) ++out->count;
    out->bytes = cp_perf_add_u64(out->bytes, bytes);
    out->wall_us = cp_perf_add_u64(out->wall_us, elapsed_us);
    if (elapsed_us > out->max_us) out->max_us = elapsed_us;
}
