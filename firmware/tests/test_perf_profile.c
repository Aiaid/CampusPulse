#include "../components/cp_perf/perf_profile.c"
#include <assert.h>
#include <stdarg.h>
#include <stdio.h>
#include <string.h>

static uint64_t mock_time = 1000;
static unsigned suspended, critical, log_count, lookups, stack_scans;
static unsigned heap_queries;
static uint64_t heap_query_finished;
static bool missing;
static uint32_t generation = 1;
static eTaskState mock_state = eBlocked;
static configRUN_TIME_COUNTER_TYPE cpu_counter;
static TaskStatus_t *scratch;
static uint32_t task_reason[TASK_COUNT], task_bp[TASK_COUNT], busy_bp;
static uint32_t task_stack[TASK_COUNT], task_stack_known[TASK_COUNT];
static uint64_t operation_count[CP_PERF_OPERATION_COUNT];
int64_t esp_timer_get_time(void) { mock_time += 3; return (int64_t)mock_time; }
void heap_caps_get_info(multi_heap_info_t *out, uint32_t caps) {
    assert(out && !suspended && !critical && caps == (MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
    *out = (multi_heap_info_t){.total_free_bytes = 43000, .total_allocated_bytes = 210000,
        .largest_free_block = 20480, .minimum_free_bytes = 12, .free_blocks = 17};
    ++heap_queries;
    mock_time += 37;
    heap_query_finished = mock_time;
}
void cp_test_perf_enter(portMUX_TYPE *lock) { (void)lock; assert(!critical++); }
void cp_test_perf_exit(portMUX_TYPE *lock) { (void)lock; assert(critical-- == 1); }
void vTaskSuspendAll(void) { ++suspended; }
BaseType_t xTaskResumeAll(void) { assert(suspended); --suspended; return pdFALSE; }
TaskHandle_t xTaskGetHandle(const char *name) {
    assert(suspended == 1 && !critical);
    ++lookups;
    /* Model the SDK's nested suspend/resume inside name lookup. */
    vTaskSuspendAll();
    assert(suspended == 2);
    (void)xTaskResumeAll();
    assert(name == task_names[lookups % TASK_COUNT ? lookups % TASK_COUNT - 1 : TASK_COUNT - 1]);
    return missing && !strcmp(name, "wifi") ? NULL : (TaskHandle_t)(uintptr_t)1;
}
void vTaskGetInfo(TaskHandle_t task, TaskStatus_t *status, BaseType_t scan_stack, eTaskState state) {
    unsigned index = (lookups - 1) % TASK_COUNT;
    bool stack_watch = index < 4 || index == CONTROL_INDEX || index == USB_INDEX;
    assert(task && suspended == 1 && scan_stack == (stack_watch ? pdTRUE : pdFALSE) && state == eInvalid);
    if (stack_watch) ++stack_scans;
    if (!scratch) scratch = status;
    assert(scratch == status); /* Exactly one reused TaskStatus_t, no task array. */
    *status = (TaskStatus_t){.xTaskNumber = generation, .eCurrentState = mock_state,
        .pcTaskName = (const char *)(uintptr_t)1, .ulRunTimeCounter = cpu_counter,
        .usStackHighWaterMark = stack_watch ? 2048 : 0};
}
void cp_test_perf_log(const char *format, ...) {
    assert(!suspended && !critical);
    char line[512];
    va_list args;
    va_start(args, format);
    vsnprintf(line, sizeof line, format, args);
    va_end(args);
    ++log_count;
    unsigned index, reason, bp, count;
    if (sscanf(line, "task=%u reason=%u cpu_bp=%u", &index, &reason, &bp) == 3) {
        assert(index < TASK_COUNT);
        task_reason[index] = reason;
        task_bp[index] = bp;
        const char *stack = strstr(line, " stack_known=");
        assert(stack && sscanf(stack, " stack_known=%u stack_min_bytes=%u",
            &task_stack_known[index], &task_stack[index]) == 2);
    } else if (sscanf(line, "op=%u count=%u", &index, &count) == 2) {
        assert(index < CP_PERF_OPERATION_COUNT);
        operation_count[index] = count;
    } else {
        assert(sscanf(line, "summary=1 busy_bp=%u", &busy_bp) == 1);
        unsigned free_bytes, largest, free_blocks;
        unsigned long long total, report_us;
        const char *heap = strstr(line, " heap_free="), *wall = strstr(line, " report_wall_us=");
        assert(heap && sscanf(heap, " heap_free=%u heap_total=%llu heap_largest=%u heap_free_blocks=%u",
            &free_bytes, &total, &largest, &free_blocks) == 4);
        assert(free_bytes == 43000 && total == 253000 && largest == 20480 && free_blocks == 17);
        assert(wall && sscanf(wall, " report_wall_us=%llu", &report_us) == 1 &&
            report_us >= heap_query_finished - s_last_poll);
    }
}
static void math(void) {
    cp_perf_row_t row = {0};
    cp_perf_delta_t d = cp_perf_step(&row, false, true, 0, 100, 1, 32, true);
    assert(d.reason == 1 && d.cpu_bp == UINT32_MAX);
    d = cp_perf_step(&row, true, true, 250, 1100, 1, 32, true);
    assert(!d.reason && d.cpu_bp == 2500 && d.run_us == 250 && d.interval_us == 1000);
    d = cp_perf_step(&row, true, true, 0, 2100, 2, 32, true);
    assert(d.reason == 3 && d.cpu_bp == UINT32_MAX);
    d = cp_perf_step(&row, true, false, 0, 0, 0, 32, true);
    assert(d.reason == 2 && d.cpu_bp == UINT32_MAX);
    row = (cp_perf_row_t){.run = UINT32_MAX - 50u, .clock = 1000, .task_number = 1};
    d = cp_perf_step(&row, true, true, 49, 2000, 1, 32, true);
    assert(!d.reason && d.run_us == 100 && d.cpu_bp == 1000); /* Task counter wraps. */
    row = (cp_perf_row_t){.run = UINT64_MAX - 50u, .clock = 1000, .task_number = 1};
    d = cp_perf_step(&row, true, true, 49, 2000, 1, 64, true);
    assert(!d.reason && d.run_us == 100 && d.cpu_bp == 1000);
    row = (cp_perf_row_t){.run = 1, .clock = UINT32_MAX - 10u, .task_number = 1};
    d = cp_perf_step(&row, true, true, 11, 9, 1, 32, true);
    assert(d.reason == 4 && d.cpu_bp == UINT32_MAX); /* SDK source-clock wrap loses a slice. */
    row = (cp_perf_row_t){.run = 1, .clock = UINT32_MAX - 10u, .task_number = 1};
    d = cp_perf_step(&row, true, true, 11, 9, 1, 64, true);
    assert(!d.reason && d.interval_us == 20 && d.cpu_bp == 5000);
    d = cp_perf_step(&row, true, true, 999, 10, 1, 64, true);
    assert(d.reason == 5 && d.cpu_bp == UINT32_MAX); /* Never clamp fabricated >100% CPU. */
    d = cp_perf_step(&row, true, true, 999, 10, 1, 64, true);
    assert(d.reason == 4); /* Zero clock interval. */
    d = cp_perf_step(&row, true, true, 1000, 100, 1, 64, false);
    assert(d.reason == 4); /* Clock reversal/overlong supervisor stall. */
    cp_perf_operation_stats_t op = {.count = UINT32_MAX - 1u, .bytes = UINT64_MAX - 2u,
        .wall_us = UINT64_MAX - 2u};
    cp_perf_accumulate(&op, 4, 7);
    cp_perf_accumulate(&op, 1, 2);
    assert(op.count == UINT32_MAX && op.bytes == UINT64_MAX && op.wall_us == UINT64_MAX && op.max_us == 7);
}
static void module(void) {
    CP_PERF_START(start);
    CP_PERF_END(CP_PERF_JOURNAL_APPEND, 17, start);
    cp_perf_note(CP_PERF_JOURNAL_APPEND, 20, 9);
    cp_perf_note(CP_PERF_LCD_TRANSFER, 480, 0);
    assert(s_operations[CP_PERF_LCD_TRANSFER].bytes == 480 &&
           !s_operations[CP_PERF_LCD_TRANSFER].wall_us);
    cp_perf_note((cp_perf_operation_t)99, 1, 1);
    cp_perf_poll();
    assert(log_count == TASK_COUNT + CP_PERF_OPERATION_COUNT + 1 && lookups == TASK_COUNT &&
           operation_count[0] == 2 && busy_bp == UINT32_MAX);
    assert(IDLE_INDEX == 9 && CONTROL_INDEX == 10 && !strcmp(task_names[10], "cp_control"));
    assert(USB_INDEX == 11 && !strcmp(task_names[11], "cp_usb"));
    assert(stack_scans == 6 && task_stack_known[CONTROL_INDEX] && task_stack[CONTROL_INDEX] == 2048);
    assert(heap_queries == 1);
    assert(task_stack_known[USB_INDEX] && task_stack[USB_INDEX] == 2048);
    for (unsigned i = 0; i < 4; ++i) assert(task_stack_known[i] && task_stack[i] == 2048);
    for (unsigned i = 4; i < 10; ++i) assert(!task_stack_known[i] && !task_stack[i]);
    assert(task_reason[0] == 1 && !s_operations[0].count);
    assert(operation_count[CP_PERF_LCD_TRANSFER] == 1);
    cp_perf_poll();
    assert(log_count == TASK_COUNT + CP_PERF_OPERATION_COUNT + 1 && lookups == TASK_COUNT);
    assert(heap_queries == 1); /* No heap sampling between ten-second reports. */
    mock_time += 10000000;
    cpu_counter = 2500000;
    missing = true;
    cp_perf_poll();
    assert(!task_reason[0] && task_bp[0] >= 2499 && task_bp[0] <= 2500);
    assert(task_reason[5] == 2 && task_bp[5] == UINT32_MAX && busy_bp >= 7500 && busy_bp <= 7501);
    mock_time += 10000000;
    ++generation;
    cpu_counter = 0;
    missing = false;
    cp_perf_poll();
    assert(task_reason[0] == 3 && task_reason[5] == 1 && busy_bp == UINT32_MAX);
    mock_time += 61000000;
    cp_perf_poll();
    assert(task_reason[0] == 4 && busy_bp == UINT32_MAX);
    mock_time += 10000000;
    mock_state = eDeleted; /* xTaskGetHandle may find a task awaiting deletion. */
    cp_perf_poll();
    assert(task_reason[0] == 2 && busy_bp == UINT32_MAX);
    assert(!task_stack_known[CONTROL_INDEX] && !task_stack[CONTROL_INDEX]);
    assert(!task_stack_known[USB_INDEX] && !task_stack[USB_INDEX]);
    mock_time += 10000000;
    mock_state = eBlocked;
    cp_perf_poll();
    assert(task_reason[0] == 1 && busy_bp == UINT32_MAX);
    assert(!suspended && !critical);
}
int main(void) {
    math();
    module();
    printf("Optional CPU/operation profiling: %u-bit counters, lifetime/wrap/unknown boundaries: PASS\n",
           (unsigned)(sizeof(configRUN_TIME_COUNTER_TYPE) * CHAR_BIT));
    return 0;
}
