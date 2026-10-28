#pragma once
#include "sdkconfig.h"
#include <stdint.h>

typedef enum {
    CP_PERF_JOURNAL_APPEND = 0,
    CP_PERF_JOURNAL_READ = 1,
    CP_PERF_WINDOW_CLOSE = 2,
    CP_PERF_JOURNAL_ACK = 3,
    CP_PERF_UI_RENDER = 4,
    CP_PERF_LCD_TRANSFER = 5, /* Submitted pixel bytes; elapsed_us is zero. */
    CP_PERF_OPERATION_COUNT
} cp_perf_operation_t;

#if defined(CONFIG_CP_PERF_PROFILE) && CONFIG_CP_PERF_PROFILE
#include "esp_timer.h"
/* Counts/bytes and overlapping wall time since the previous report. No heap,
 * task creation or logging here. Calls must be from ordinary task context. */
void cp_perf_note(cp_perf_operation_t operation, uint64_t bytes, uint64_t elapsed_us);
/* Single supervisor caller, at most one sample/report per ten seconds. */
void cp_perf_poll(void);
#define CP_PERF_START(name) const uint64_t name = (uint64_t)esp_timer_get_time()
#define CP_PERF_END(operation, bytes, name) \
    cp_perf_note((operation), (bytes), (uint64_t)esp_timer_get_time() - (name))
#else
/* Disabled profiling does not even evaluate byte-count or timer arguments. */
#define cp_perf_note(...) ((void)0)
#define CP_PERF_START(name) ((void)0)
#define CP_PERF_END(...) ((void)0)
static inline void cp_perf_poll(void) {}
#endif
