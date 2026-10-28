#include "../alloc_monitor.c"
#include <assert.h>
#include <pthread.h>
#include <stdio.h>

static esp_alloc_failed_hook_t hook;
static unsigned registrations;
static esp_err_t registration_result = ESP_FAIL;
static esp_err_t recursive_result;

esp_err_t heap_caps_register_failed_alloc_callback(esp_alloc_failed_hook_t callback) {
    assert(callback);
    ++registrations;
    recursive_result = cp_alloc_monitor_init();
    if (registration_result == ESP_OK) hook = callback;
    return registration_result;
}
static void notify(size_t requested, uint32_t caps) {
    assert(hook);
    /* Invalid and NULL strings prove the hook never dereferences/retains them. */
    hook(requested, caps, (const char *)(uintptr_t)1u);
}
static void sample_is(uint32_t count, uint32_t recorded, uint32_t bytes, uint32_t caps) {
    cp_alloc_monitor_snapshot_t s = cp_alloc_monitor_snapshot();
    assert(s.failure_count == count && s.recorded_failure_count == recorded);
    assert(s.details_available && s.last_requested_bytes == bytes && s.last_caps == caps);
}
static void registration_and_retention(void) {
    cp_alloc_monitor_snapshot_t s = cp_alloc_monitor_snapshot();
    assert(!s.failure_count && !s.details_available);
    assert(cp_alloc_monitor_init() == ESP_FAIL && registrations == 1 && !hook);
    assert(recursive_result == ESP_ERR_INVALID_STATE);
    registration_result = ESP_OK;
    assert(cp_alloc_monitor_init() == ESP_OK && registrations == 2 && hook);
    assert(recursive_result == ESP_ERR_INVALID_STATE);
    notify(4096, 0x808);
    sample_is(1, 1, 4096, 0x808);
    assert(cp_alloc_monitor_init() == ESP_OK && registrations == 2);
    sample_is(1, 1, 4096, 0x808);
    hook(8192, 0x1000, NULL);
    sample_is(2, 2, 8192, 0x1000);
}
static void busy_details_and_wrap(void) {
    uint32_t version = __atomic_load_n(&s_details_version, __ATOMIC_SEQ_CST);
    __atomic_store_n(&s_details_version, version + 1u, __ATOMIC_SEQ_CST);
    notify(777, 888); /* One attempt: count advances without waiting on details. */
    cp_alloc_monitor_snapshot_t s = cp_alloc_monitor_snapshot();
    assert(s.failure_count == 3 && !s.details_available);
    assert(!s.last_requested_bytes && !s.last_caps && !s.recorded_failure_count);
    __atomic_store_n(&s_details_version, version + 2u, __ATOMIC_SEQ_CST);
    sample_is(3, 2, 8192, 0x1000); /* Old detail is explicitly numbered as old. */
    __atomic_store_n(&s_details_version, UINT32_MAX - 1u, __ATOMIC_SEQ_CST);
    notify(99, 55);
    sample_is(4, 4, 99, 55);
    assert(__atomic_load_n(&s_details_version, __ATOMIC_SEQ_CST) == 0);
}
enum { WORKERS = 4, FAILURES_PER_WORKER = 10000 };
static void *writer(void *argument) {
    uint32_t worker = (uint32_t)(uintptr_t)argument;
    for (uint32_t i = 1; i <= FAILURES_PER_WORKER; ++i) {
        uint32_t caps = i * WORKERS + worker;
        notify(caps ^ UINT32_C(0xa5a5a5a5), caps);
    }
    return NULL;
}
static void concurrent_callbacks(void) {
    /* Establish the invariant before other threads start publishing details. */
    notify(UINT32_C(0xa5a5a5a5), 0);
    uint32_t before = cp_alloc_monitor_snapshot().failure_count;
    pthread_t threads[WORKERS];
    for (uintptr_t i = 0; i < WORKERS; ++i)
        assert(!pthread_create(&threads[i], NULL, writer, (void *)i));
    uint32_t previous = before;
    for (unsigned i = 0; i < 20000; ++i) {
        cp_alloc_monitor_snapshot_t s = cp_alloc_monitor_snapshot();
        assert(s.failure_count >= previous);
        previous = s.failure_count;
        if (s.details_available) {
            assert(s.recorded_failure_count <= s.failure_count);
            assert(s.last_requested_bytes == (s.last_caps ^ UINT32_C(0xa5a5a5a5)));
        }
    }
    for (unsigned i = 0; i < WORKERS; ++i) assert(!pthread_join(threads[i], NULL));
    cp_alloc_monitor_snapshot_t s = cp_alloc_monitor_snapshot();
    assert(s.failure_count == before + WORKERS * FAILURES_PER_WORKER);
    assert(s.details_available);
    assert(s.last_requested_bytes == (s.last_caps ^ UINT32_C(0xa5a5a5a5)));
}
static void saturation(void) {
    __atomic_store_n(&s_failures, UINT32_MAX - 1u, __ATOMIC_RELAXED);
    notify(1, 2);
    sample_is(UINT32_MAX, UINT32_MAX, 1, 2);
    notify(SIZE_MAX, UINT32_MAX);
    sample_is(UINT32_MAX, UINT32_MAX, UINT32_MAX, UINT32_MAX);
    assert(cp_alloc_monitor_init() == ESP_OK && registrations == 2);
    sample_is(UINT32_MAX, UINT32_MAX, UINT32_MAX, UINT32_MAX);
}
int main(void) {
    registration_and_retention();
    busy_details_and_wrap();
    concurrent_callbacks();
    saturation();
    puts("Allocation monitor: boot retention, bounded details, 40000 concurrent failures, saturation: PASS");
    return 0;
}
