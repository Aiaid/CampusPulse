/* Compile the production pipeline and codecs, mocking only ESP/RTOS/network IO.
 * Every cJSON allocation asserts exclusive ownership of the HTTP memory gate;
 * failures exercise actual journal retention, loss accounting and release paths. */
#include <assert.h>
#include <setjmp.h>
#include <stdlib.h>
#include <string.h>
#include "pipeline/host.h"
#include "../components/cp_pipeline/pipeline.c"

static bool memory_owned, http_active, http_finishes_during_wait, store_owned, store_fails;
static unsigned claims, releases, last_wait, allocations, live_allocations, fail_allocation;
static unsigned upload_calls, delays, stop_wait, worker_deletes;
static bool stop_join_times_out, run_uploader;
static uint64_t now_ms = 31000;
static uint32_t internal_heap = 100000;
static cp_network_snapshot_t network;
static jmp_buf task_yield;
static unsigned char flash_bytes[24 * CP_JOURNAL_SLOT_BYTES];
static unsigned char upload_copy[CP_JOURNAL_MAX_BODY];
static size_t upload_length;
static int store_mutex, worker_signal, worker_task;
test_ble_hs_cfg_t ble_hs_cfg;

static void *checked_malloc(size_t n) {
    assert(memory_owned && !http_active);
    ++allocations;
    if (fail_allocation && allocations == fail_allocation)
        return NULL;
    void *p = malloc(n);
    assert(p);
    ++live_allocations;
    return p;
}
static void checked_free(void *p) {
    if (p) {
        assert(memory_owned && live_allocations);
        --live_allocations;
        free(p);
    }
}
bool cp_network_begin_memory_work(uint32_t wait) {
    /* A nonrecursive mutex must never be entered twice by this caller, even
     * with wait=0: apply owns the separate radio-transition claim already. */
    assert(!memory_owned && !store_owned && wait <= 15000);
    ++claims;
    last_wait = wait;
    if (http_active && wait && http_finishes_during_wait)
        http_active = false;
    if (http_active)
        return false;
    memory_owned = true;
    return true;
}
void cp_network_end_memory_work(void) {
    assert(memory_owned && !live_allocations && !store_owned);
    memory_owned = false;
    ++releases;
}
void cp_network_snapshot(cp_network_snapshot_t *out) { *out = network; }
bool cp_network_sha256(const void *p, size_t n, char out[65]) {
    assert(memory_owned && p && n);
    memset(out, 'a', 64);
    out[64] = 0;
    return true;
}
cp_net_upload_result_t cp_network_upload_frozen(const void *p, size_t n,
                                                const cp_network_batch_t *m,
                                                cp_network_ack_t *ack) {
    (void)ack;
    assert(!memory_owned && !live_allocations && !store_owned && m->accepted_count);
    assert(n <= sizeof upload_copy);
    memcpy(upload_copy, p, n);
    upload_length = n;
    ++upload_calls;
    return CP_NET_UPLOAD_RETRY;
}
int64_t esp_timer_get_time(void) { return (int64_t)(now_ms * 1000); }
size_t esp_get_free_heap_size(void) { return internal_heap; }
size_t heap_caps_get_free_size(uint32_t caps) { (void)caps; return internal_heap; }
size_t heap_caps_get_largest_free_block(uint32_t caps) { (void)caps; return internal_heap; }
size_t heap_caps_get_minimum_free_size(uint32_t caps) { (void)caps; return internal_heap; }
void esp_fill_random(void *data, size_t n) { memset(data, 0x42, n); }
uint32_t esp_random(void) { return 42; }
int esp_bt_controller_get_status(void) { return 0; }
unsigned uxTaskGetStackHighWaterMark(TaskHandle_t h) { (void)h; return 3000; }
int xSemaphoreTake(SemaphoreHandle_t h, TickType_t wait) {
    if (h == &worker_signal) {
        stop_wait = wait;
        assert(!memory_owned);
        return stop_join_times_out ? pdFALSE : pdTRUE;
    }
    assert(h == &store_mutex && !store_owned);
    if (store_fails)
        return pdFALSE;
    store_owned = true;
    return pdTRUE;
}
int xSemaphoreGive(SemaphoreHandle_t h) {
    assert(h == &store_mutex && store_owned);
    store_owned = false;
    return pdTRUE;
}
void vTaskDelay(TickType_t ticks) {
    now_ms += ticks;
    assert(!memory_owned && !store_owned && !live_allocations);
    ++delays;
    if (run_uploader)
        longjmp(task_yield, 1);
}
void vTaskDelete(TaskHandle_t h) {
    assert(h == &worker_task);
    ++worker_deletes;
}
/* Unsupported paths fail if accidentally entered by these memory tests. */
int xTaskCreate(void (*fn)(void *), const char *name, unsigned stack, void *arg,
                unsigned priority, TaskHandle_t *out) {
    (void)fn; (void)name; (void)stack; (void)arg; (void)priority; (void)out;
    assert(false); return pdFALSE;
}
QueueHandle_t xQueueCreate(unsigned capacity, size_t width) {
    (void)capacity; (void)width; assert(false); return NULL;
}
int xQueueReceive(QueueHandle_t q, void *item, TickType_t wait) {
    (void)q; (void)item; (void)wait; assert(false); return pdFALSE;
}
int xQueueSend(QueueHandle_t q, const void *item, TickType_t wait) {
    (void)q; (void)item; (void)wait; assert(false); return pdFALSE;
}
void vQueueDelete(QueueHandle_t h) { (void)h; assert(false); }
void vTaskSuspend(TaskHandle_t h) { (void)h; assert(false); }
SemaphoreHandle_t xSemaphoreCreateMutex(void) { assert(false); return NULL; }
SemaphoreHandle_t xSemaphoreCreateBinary(void) { assert(false); return NULL; }
void vSemaphoreDelete(SemaphoreHandle_t h) { (void)h; assert(false); }
EventGroupHandle_t xEventGroupCreate(void) { assert(false); return NULL; }
void vEventGroupDelete(EventGroupHandle_t h) { (void)h; assert(false); }
EventBits_t xEventGroupSetBits(EventGroupHandle_t h, EventBits_t bits) {
    (void)h; (void)bits; assert(false); return 0;
}
EventBits_t xEventGroupClearBits(EventGroupHandle_t h, EventBits_t bits) {
    (void)h; (void)bits; assert(false); return 0;
}
EventBits_t xEventGroupWaitBits(EventGroupHandle_t h, EventBits_t bits,
                               bool clear, bool all, TickType_t wait) {
    (void)h; (void)bits; (void)clear; (void)all; (void)wait; assert(false); return 0;
}
const esp_partition_t *esp_partition_find_first(unsigned type, unsigned subtype,
                                                const char *name) {
    (void)type; (void)subtype; (void)name; assert(false); return NULL;
}
esp_err_t esp_partition_read(const esp_partition_t *p, size_t off, void *out, size_t n) {
    (void)p; (void)off; (void)out; (void)n; assert(false); return ESP_FAIL;
}
esp_err_t esp_partition_write(const esp_partition_t *p, size_t off, const void *in, size_t n) {
    (void)p; (void)off; (void)in; (void)n; assert(false); return ESP_FAIL;
}
esp_err_t esp_partition_erase_range(const esp_partition_t *p, size_t off, size_t n) {
    (void)p; (void)off; (void)n; assert(false); return ESP_FAIL;
}
int ble_gap_disc_cancel(void) { return 0; }
int ble_hs_util_ensure_addr(unsigned value) { (void)value; assert(false); return -1; }
int ble_hs_id_infer_auto(unsigned value, uint8_t *out) {
    (void)value; (void)out; assert(false); return -1;
}
int ble_gap_disc(uint8_t addr, int32_t duration, const struct ble_gap_disc_params *p,
                 int (*cb)(struct ble_gap_event *, void *), void *arg) {
    (void)addr; (void)duration; (void)p; (void)cb; (void)arg; assert(false); return -1;
}
void ble_svc_gap_init(void) { assert(false); }
void ble_svc_gatt_init(void) { assert(false); }
esp_err_t nimble_port_init(void) { assert(false); return ESP_FAIL; }
void nimble_port_run(void) { assert(false); }
int nimble_port_stop(void) { assert(false); return -1; }
esp_err_t nimble_port_deinit(void) { assert(!memory_owned); return ESP_OK; }

static bool test_flash_read(void *ctx, size_t off, void *out, size_t n) {
    (void)ctx;
    assert(off + n <= sizeof flash_bytes);
    memcpy(out, flash_bytes + off, n);
    return true;
}
static bool test_flash_write(void *ctx, size_t off, const void *in, size_t n) {
    (void)ctx;
    assert(memory_owned && store_owned && off + n <= sizeof flash_bytes);
    const unsigned char *source = in;
    for (size_t i = 0; i < n; ++i) {
        assert((flash_bytes[off + i] & source[i]) == source[i]);
        flash_bytes[off + i] &= source[i];
    }
    return true;
}
static bool test_flash_erase(void *ctx, size_t off, size_t n) {
    (void)ctx;
    assert(memory_owned && store_owned && off + n <= sizeof flash_bytes);
    memset(flash_bytes + off, 0xff, n);
    return true;
}
static void reset(void) {
    assert(!memory_owned && !store_owned && !live_allocations);
    memset(&s_health, 0, sizeof s_health);
    memset(&s_policy, 0, sizeof s_policy);
    memset(&s_memory, 0, sizeof s_memory);
    memset(s_losses, 0, sizeof s_losses);
    memset(s_stream_pending, 0, sizeof s_stream_pending);
    memset(&network, 0, sizeof network);
    memset(flash_bytes, 0xff, sizeof flash_bytes);
    cp_flash_t flash = {NULL, sizeof flash_bytes, test_flash_read, test_flash_write,
                        test_flash_erase};
    assert(cp_journal_open(&s_journal, flash) == CP_JOURNAL_OK);
    cp_upload_scheduler_init(&s_upload_scheduler);
    s_store_lock = &store_mutex;
    s_worker_done = &worker_signal;
    s_worker = s_host = NULL;
    s_initialized = s_policy_owned = s_stop_failed = s_pressure_paused = false;
    s_memory_paused = s_memory_raw_paused = s_raw_paused = false;
    s_accept = true;
    s_stop = false;
    s_idle_pause_tick = s_idle_status_at = s_stop_at = s_raw_paused_ms = 0;
    s_resource_exhaustions_seen = s_raw_queue_drops = s_raw_pressure_skips = 0;
    s_unpersisted_window_reports = s_status_dropped = s_address_overflow_reports = 0;
    s_status_seq = s_summary_seq = s_loss_overruns = 0;
    http_active = http_finishes_during_wait = store_fails = false;
    stop_join_times_out = run_uploader = false;
    claims = releases = allocations = fail_allocation = last_wait = 0;
    upload_calls = delays = stop_wait = worker_deletes = 0;
    now_ms = 31000;
    internal_heap = 100000;
    strcpy(s_node, "cp_aabbccddeeff");
    strcpy(s_boot, "00000000-0000-4000-8000-000000000001");
    strcpy(s_policy.core.config_id, "synthetic-config");
    strcpy(s_policy.placement_id, "synthetic-place");
    strcpy(s_policy.dataset, "controlled_test");
    s_policy.max_addresses = 4;
    s_policy.max_items = 16;
    s_policy.max_body_bytes = CP_JOURNAL_MAX_BODY;
    s_policy.summary_window_ms = 30000;
    s_policy.summary_bin_ms = 5000;
    s_policy.warn_pct = 60;
    s_policy.raw_pause_pct = 80;
    s_policy.critical_pct = 95;
    s_policy.resume_pct = 40;
    s_policy.raw_enabled = true;
    s_policy.max_raw_per_window = CP_COLLECT_RAW;
    s_policy.sample_every_n = 1;
    s_policy.fetched_mono_ms = 30000;
    s_policy.lease_ms = 120000;
    s_policy.request_sequence = 1;
    network.network = CP_NETWORK_READY;
    network.auth = CP_AUTH_VALID;
    s_health.storage_ready = true;
    update_store_health();
    assert(cp_collect_begin(&s_window, 1000, 30000, 5000, 1, 4, true));
}
static void observe(unsigned count) {
    for (unsigned i = 0; i < count; ++i) {
        cp_report_t r = {.mono_ms = 1001 + i, .report_seq = i + 1, .address = {1, 2, 3, 4, 5, 6},
                         .raw = CP_RAW_SELECTED, .rssi = -50};
        assert(cp_collect_observe(&s_window, &r));
    }
}
static void read_slot(unsigned slot, char out[CP_JOURNAL_MAX_BODY + 1]) {
    size_t n;
    assert(cp_journal_read(&s_journal, slot, out, CP_JOURNAL_MAX_BODY, &n) == CP_JOURNAL_OK);
    out[n] = 0;
}
static void assert_released(void) {
    assert(!memory_owned && !store_owned && !live_allocations);
}
static void test_window_and_status_share_claim(void) {
    reset();
    observe(3);
    http_active = http_finishes_during_wait = true;
    close_window(30000);
    assert_released();
    assert(claims == 1 && releases == 1 && last_wait == 15000);
    assert(s_health.windows_committed == 1 && s_health.summaries_committed == 1);
    assert(s_health.pending == 4 && !s_health.windows_dropped && s_status_seq == 1);
}
static void test_timeout_losses_and_status_retry(void) {
    reset();
    observe(6); /* Four retained raw items and two already counted raw drops. */
    s_losses[1] = (loss_bucket_t){.window = 1, .drops = 3, .selected_drops = 1,
                                .intentional = 1, .pressure = 1};
    http_active = true;
    close_window(30000);
    assert_released();
    assert(last_wait == 15000 && claims == 1 && releases == 0 && allocations == 0);
    assert(!s_health.pending && s_health.windows_dropped == 1 && s_health.summary_drops == 1);
    assert(s_health.raw_drops == 7 && s_health.aggregation_drops == 3);
    assert(s_unpersisted_window_reports == 9 && s_raw_queue_drops == 1);
    assert(s_raw_pressure_skips == 1 && s_status_dropped == 1 && s_window.raw_count == 0);
    assert(s_window.intentional == 1); /* No timeout relabeled as policy intent. */
    assert(!persist_status() && last_wait == 0 && s_status_dropped == 2 && !allocations);
    http_active = false;
    assert(persist_status());
    char body[CP_JOURNAL_MAX_BODY + 1];
    read_slot(0, body);
    assert(strstr(body, "\"windows_dropped\":1") &&
           strstr(body, "\"unpersisted_window_reports\":9") &&
           strstr(body, "\"status_samples_coalesced\":2"));
    assert_released();
}
static void test_raw_deferral_keeps_bounded_accounting(void) {
    reset();
    observe(3);
    http_active = true;
    flush_raw_if_idle();
    assert(s_window.raw_count == 3 && !s_window.raw_drops && !allocations && last_wait == 0);
    observe(3);
    assert(s_window.raw_count == CP_COLLECT_RAW && s_window.raw_drops == 2);
    http_active = false;
    flush_raw_if_idle();
    assert(s_window.raw_count == 0 && s_window.raw_drops == 2 && s_health.pending == 1);
    close_window(30000);
    assert(s_health.raw_drops == 2 && !s_health.windows_dropped);
    assert_released();
}
static void test_invalid_ingress_loss_preserves_raw_and_releases(void) {
    reset();
    observe(2);
    /* An inconsistent ingress loss bucket cannot produce a truthful window,
     * but its loss total and the raw already retained still have owners. */
    s_losses[1] = (loss_bucket_t){.window = 1, .drops = 2};
    close_window(30000);
    assert_released();
    assert(claims == 1 && releases == 1 && s_health.pending == 2);
    assert(s_health.windows_dropped == 1 && s_health.summary_drops == 1);
    assert(s_unpersisted_window_reports == 4 && s_health.aggregation_drops == 2);
    assert(!s_health.raw_drops && !s_window.raw_count);
}
static void test_allocation_and_store_failures_release(void) {
    reset();
    observe(2);
    close_window(30000);
    unsigned count = allocations;
    assert(count > 100);
    for (unsigned i = 1; i <= count; ++i) {
        reset();
        observe(2);
        fail_allocation = i;
        close_window(30000);
        assert_released();
        assert(claims == 1 && releases == 1);
        assert(s_health.windows_committed + s_health.windows_dropped == 1);
        assert(s_health.summaries_committed + s_health.summary_drops == 1);
    }
    printf("Pipeline window/status OOM sweep: %u allocation sites passed\n", count);
    reset();
    observe(2);
    store_fails = true;
    close_window(30000);
    assert_released();
    assert(s_health.windows_dropped == 1 && s_health.summary_drops == 1);
    assert(s_health.raw_drops == 2 && s_status_dropped == 1 && !s_health.pending);
    assert(claims == 1 && releases == 1);
}
static void test_metadata_failure_and_upload_preserve_frozen_bytes(void) {
    reset();
    observe(1);
    flush_raw_if_idle();
    char frozen[CP_JOURNAL_MAX_BODY + 1];
    read_slot(0, frozen);
    cp_network_batch_t meta;
    allocations = 0;
    assert(batch_metadata(frozen, &meta));
    unsigned count = allocations;
    for (unsigned i = 1; i <= count; ++i) {
        allocations = 0;
        fail_allocation = i;
        assert(!batch_metadata(frozen, &meta));
        assert_released();
        assert(s_health.pending == 1 && s_journal.slots[0].state == CP_SLOT_PENDING);
    }
    printf("Pipeline metadata OOM sweep: %u allocation sites passed\n", count);
    fail_allocation = 0;
    assert(!batch_metadata("{invalid", &meta));
    assert_released();
    http_active = true;
    unsigned before = allocations;
    assert(!batch_metadata(frozen, &meta) && allocations == before);
    run_uploader = true;
    if (!setjmp(task_yield))
        uploader_task(NULL);
    assert(!upload_calls && s_health.pending == 1 && s_health.upload_failures == 1);
    http_active = false;
    now_ms += 60000;
    if (!setjmp(task_yield))
        uploader_task(NULL);
    assert(upload_calls == 1 && upload_length == strlen(frozen));
    assert(!memcmp(upload_copy, frozen, upload_length) && s_health.pending == 1);
    read_slot(0, frozen);
    assert(!memcmp(upload_copy, frozen, upload_length));
    assert_released();
}
static void test_apply_refusal_does_not_reenter_claim(void) {
    reset();
    internal_heap = 20000;
    memory_owned = true; /* Runtime owns radio-transition claim during apply. */
    assert(cp_pipeline_apply(&s_policy) == ESP_ERR_NO_MEM);
    assert(memory_owned && !claims && !allocations && s_status_dropped == 1);
    memory_owned = false;
    internal_heap = 100000;
    assert(cp_pipeline_maintain() == ESP_OK);
    assert(s_health.pending == 1 && s_status_seq == 1);
    assert_released();
}
static void test_stop_budget_and_failed_ownership(void) {
    reset();
    s_initialized = true;
    s_worker = &worker_task;
    assert(cp_pipeline_stop() == ESP_OK && stop_wait == 25000 && worker_deletes == 1);
    assert(!s_initialized && !s_worker);
    reset();
    s_initialized = true;
    s_worker = &worker_task;
    stop_join_times_out = true;
    assert(cp_pipeline_stop() == ESP_ERR_TIMEOUT && stop_wait == 25000 && !worker_deletes);
    assert(s_stop_failed && s_initialized && s_worker == &worker_task);
    assert(cp_pipeline_stop() == ESP_ERR_INVALID_STATE && !worker_deletes);
}
int main(void) {
    cJSON_Hooks hooks = {.malloc_fn = checked_malloc, .free_fn = checked_free};
    cJSON_InitHooks(&hooks);
    test_window_and_status_share_claim();
    test_timeout_losses_and_status_retry();
    test_raw_deferral_keeps_bounded_accounting();
    test_invalid_ingress_loss_preserves_raw_and_releases();
    test_allocation_and_store_failures_release();
    test_metadata_failure_and_upload_preserve_frozen_bytes();
    test_apply_refusal_does_not_reenter_claim();
    test_stop_budget_and_failed_ownership();
    assert_released();
    cJSON_InitHooks(NULL);
    puts("Pipeline memory serialization, allocation failures, durable retry and stop: PASS");
    return 0;
}
