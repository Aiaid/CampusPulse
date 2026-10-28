#include "cp_perf.h"
#if defined(CONFIG_CP_PERF_PROFILE) && CONFIG_CP_PERF_PROFILE
#include "perf_math.h"
#include "esp_log.h"
#include "esp_heap_caps.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#if !CONFIG_FREERTOS_UNICORE || CONFIG_FREERTOS_SMP || \
    !CONFIG_FREERTOS_GENERATE_RUN_TIME_STATS || !CONFIG_FREERTOS_USE_TRACE_FACILITY || \
    !CONFIG_FREERTOS_RUN_TIME_STATS_USING_ESP_TIMER
#error "CPU profiling requires unicore non-SMP FreeRTOS ESP_TIMER run-time statistics"
#endif

enum { TASK_COUNT = 12, IDLE_INDEX = 9, CONTROL_INDEX = 10, USB_INDEX = 11 };
/* Numeric log IDs follow this fixed table. Never log SDK-owned name pointers.
 * IDF source: tcpip=tiT, timer=esp_timer, default loop=sys_evt, unicore idle=IDLE.
 * wifi is an expected driver name; a missing lookup remains explicitly unknown. */
static const char *const task_names[TASK_COUNT] = {
    "cp_supervisor", "cp_network", "cp_upload", "cp_collect", "cp_nimble",
    "wifi", "tiT", "esp_timer", "sys_evt", "IDLE", "cp_control", "cp_usb"
};
static cp_perf_row_t s_rows[TASK_COUNT];
static cp_perf_operation_stats_t s_operations[CP_PERF_OPERATION_COUNT];
static portMUX_TYPE s_operation_lock = portMUX_INITIALIZER_UNLOCKED;
static uint64_t s_last_poll;
static uint16_t s_prior;
static bool s_started;
_Static_assert(sizeof(s_rows) + sizeof(s_operations) + sizeof(s_operation_lock) +
               sizeof(s_last_poll) + sizeof(s_prior) + sizeof(s_started) < 512,
               "Profiling state must stay below 512 bytes");

void cp_perf_note(cp_perf_operation_t operation, uint64_t bytes, uint64_t elapsed_us) {
    if ((unsigned)operation >= CP_PERF_OPERATION_COUNT) return;
    portENTER_CRITICAL(&s_operation_lock);
    cp_perf_accumulate(&s_operations[operation], bytes, elapsed_us);
    portEXIT_CRITICAL(&s_operation_lock);
}

void cp_perf_poll(void) {
    const uint64_t started = (uint64_t)esp_timer_get_time();
    if (s_started && started >= s_last_poll && started - s_last_poll < 10000000u) return;
    const uint64_t gap = started >= s_last_poll ? started - s_last_poll : UINT64_MAX;
    /* Long supervisor stalls invalidate the rate instead of guessing how many
     * counter wraps occurred. Individual rows retain their own sample clocks. */
    bool clock_valid = s_started && gap > 0 && gap <= 60000000u;
    s_started = true;
    s_last_poll = started;
    uint64_t held_total = 0, held_max = 0;
    uint32_t busy_bp = UINT32_MAX;
    TaskStatus_t status; /* One reused object, not an array for every task. */
    for (unsigned i = 0; i < TASK_COUNT; ++i) {
        /* Only the six application workers need stack-margin evidence. The
         * scan cost is included in held_us, every ten seconds in this optional
         * profile. Do not walk Wi-Fi, idle, NimBLE or other SDK task stacks. */
        bool stack_watch = i < 4 || i == CONTROL_INDEX || i == USB_INDEX;
        uint64_t before = (uint64_t)esp_timer_get_time();
        vTaskSuspendAll();
        /* Unicore scheduler suspension prevents deletion/reuse between lookup
         * and read. IDF's nested suspension in lookup/state queries is balanced.
         * It does not disable interrupts, and it is not safe for another core. */
        TaskHandle_t task = xTaskGetHandle(task_names[i]);
        if (task) vTaskGetInfo(task, &status, stack_watch ? pdTRUE : pdFALSE, eInvalid);
        uint64_t sampled = (uint64_t)esp_timer_get_time();
        (void)xTaskResumeAll();
        uint64_t held = sampled >= before ? sampled - before : 0;
        held_total += held;
        if (held > held_max) held_max = held;
        bool present = task && status.eCurrentState != eDeleted && status.eCurrentState != eInvalid;
        bool stack_known = present && stack_watch;
        /* vTaskGetInfo uses prvTaskCheckFreeStackSpace's StackType_t units.
         * IDF's C3 port defines StackType_t as uint8_t, so its units are bytes.
         * Keep the conversion explicit; zero is only meaningful when known. */
        uint32_t stack_min_bytes = stack_known
            ? (uint32_t)status.usStackHighWaterMark * sizeof(StackType_t) : 0;
        cp_perf_delta_t delta = cp_perf_step(&s_rows[i], (s_prior & (1u << i)) != 0,
            present, present ? (uint64_t)status.ulRunTimeCounter : 0,
            (uint32_t)sampled, present ? (uint32_t)status.xTaskNumber : 0,
            sizeof(configRUN_TIME_COUNTER_TYPE) * CHAR_BIT, clock_valid);
        if (present) s_prior |= (uint16_t)(1u << i);
        else s_prior &= (uint16_t)~(1u << i);
        if (i == IDLE_INDEX && delta.reason == 0) busy_bp = 10000u - delta.cpu_bp;
        ESP_LOGI("cp_perf", "task=%u reason=%u cpu_bp=%u run_us=%llu interval_us=%u held_us=%llu stack_known=%u stack_min_bytes=%u",
            i, delta.reason, (unsigned)delta.cpu_bp, (unsigned long long)delta.run_us,
            (unsigned)delta.interval_us, (unsigned long long)held,
            (unsigned)stack_known, (unsigned)stack_min_bytes);
    }
    for (unsigned i = 0; i < CP_PERF_OPERATION_COUNT; ++i) {
        portENTER_CRITICAL(&s_operation_lock);
        cp_perf_operation_stats_t stats = s_operations[i];
        s_operations[i] = (cp_perf_operation_stats_t){0};
        portEXIT_CRITICAL(&s_operation_lock);
        ESP_LOGI("cp_perf", "op=%u count=%u bytes=%llu wall_us=%llu max_us=%llu",
            i, (unsigned)stats.count, (unsigned long long)stats.bytes,
            (unsigned long long)stats.wall_us, (unsigned long long)stats.max_us);
    }
    /* This is one current internal byte-addressable heap sample, not a peak or
     * total chip SRAM. The aggregate query can span multiple SDK heap regions. */
    multi_heap_info_t heap;
    heap_caps_get_info(&heap, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    uint64_t heap_total = (uint64_t)heap.total_allocated_bytes + heap.total_free_bytes;
    /* report_wall_us includes lookups, heap query, logging and preemption up to this line;
     * held_* excludes resume work and interrupts are still enabled. Neither is
     * an exclusive CPU-overhead measurement. Active tasks have an uncharged
     * current-running tail; ISR time is charged to interrupted task intervals. */
    ESP_LOGI("cp_perf", "summary=1 busy_bp=%u counter_bits=%u gap_us=%llu held_total_us=%llu held_max_us=%llu report_wall_us=%llu heap_free=%u heap_total=%llu heap_largest=%u heap_free_blocks=%u",
        (unsigned)busy_bp, (unsigned)(sizeof(configRUN_TIME_COUNTER_TYPE) * CHAR_BIT),
        (unsigned long long)gap, (unsigned long long)held_total, (unsigned long long)held_max,
        (unsigned long long)((uint64_t)esp_timer_get_time() - started),
        (unsigned)heap.total_free_bytes, (unsigned long long)heap_total,
        (unsigned)heap.largest_free_block, (unsigned)heap.free_blocks);
}
#endif
