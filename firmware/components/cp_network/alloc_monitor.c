#include "alloc_monitor.h"
#include "esp_attr.h"
#include "esp_heap_caps.h"
#include "sdkconfig.h"
#include <limits.h>
#include <stddef.h>

#if defined(CONFIG_HEAP_ABORT_WHEN_ALLOCATION_FAILS) && CONFIG_HEAP_ABORT_WHEN_ALLOCATION_FAILS
#error "Allocation monitoring must not enable SDK abort-on-allocation-failure"
#endif

/* Only 32-bit atomics: the C3 SDK implements their read/modify/write operations
 * with brief interrupt masking in IRAM. No application spinlock, 64-bit atomic,
 * heap operation, logging, task scheduling or service API runs in the callback. */
static uint32_t s_failures, s_details_version, s_recorded_failure;
static uint32_t s_requested_bytes, s_caps, s_registration;

static uint32_t IRAM_ATTR increment_saturated(void) {
    uint32_t before = __atomic_load_n(&s_failures, __ATOMIC_RELAXED);
    while (before != UINT32_MAX) {
        if (__atomic_compare_exchange_n(&s_failures, &before, before + 1u, false,
                                        __ATOMIC_RELAXED, __ATOMIC_RELAXED))
            return before + 1u;
    }
    return UINT32_MAX;
}

static void IRAM_ATTR allocation_failed(size_t requested, uint32_t caps,
                                        const char *function_name) {
    (void)function_name; /* Do not retain or dereference SDK strings/pointers. */
    uint32_t index = increment_saturated();
    uint32_t version = __atomic_load_n(&s_details_version, __ATOMIC_SEQ_CST);
    /* Never wait for another callback. Count every failure, but allow its
     * optional size/caps details to be skipped when publication is busy. */
    if ((version & 1u) ||
        !__atomic_compare_exchange_n(&s_details_version, &version, version + 1u, false,
                                     __ATOMIC_SEQ_CST, __ATOMIC_SEQ_CST))
        return;
    if (index >= __atomic_load_n(&s_recorded_failure, __ATOMIC_SEQ_CST)) {
        __atomic_store_n(&s_requested_bytes,
            requested > UINT32_MAX ? UINT32_MAX : (uint32_t)requested, __ATOMIC_SEQ_CST);
        __atomic_store_n(&s_caps, caps, __ATOMIC_SEQ_CST);
        __atomic_store_n(&s_recorded_failure, index, __ATOMIC_SEQ_CST);
    }
    __atomic_store_n(&s_details_version, version + 2u, __ATOMIC_SEQ_CST);
}

esp_err_t cp_alloc_monitor_init(void) {
    uint32_t expected = 0;
    if (!__atomic_compare_exchange_n(&s_registration, &expected, 1u, false,
                                     __ATOMIC_ACQUIRE, __ATOMIC_RELAXED))
        return expected == 2u ? ESP_OK : ESP_ERR_INVALID_STATE;
    esp_err_t error = heap_caps_register_failed_alloc_callback(allocation_failed);
    __atomic_store_n(&s_registration, error == ESP_OK ? 2u : 0u, __ATOMIC_RELEASE);
    return error;
}

cp_alloc_monitor_snapshot_t cp_alloc_monitor_snapshot(void) {
    cp_alloc_monitor_snapshot_t out = {0};
    uint32_t version = __atomic_load_n(&s_details_version, __ATOMIC_SEQ_CST);
    if (!(version & 1u)) {
        uint32_t requested = __atomic_load_n(&s_requested_bytes, __ATOMIC_SEQ_CST);
        uint32_t caps = __atomic_load_n(&s_caps, __ATOMIC_SEQ_CST);
        uint32_t recorded = __atomic_load_n(&s_recorded_failure, __ATOMIC_SEQ_CST);
        /* Sequentially ordered atomic fields make the version checks bound
         * one coherent tuple even with concurrent callbacks on another CPU. */
        if (recorded && version == __atomic_load_n(&s_details_version, __ATOMIC_SEQ_CST)) {
            out.recorded_failure_count = recorded;
            out.last_requested_bytes = requested;
            out.last_caps = caps;
            out.details_available = true;
        }
    }
    out.failure_count = __atomic_load_n(&s_failures, __ATOMIC_RELAXED);
    return out;
}
