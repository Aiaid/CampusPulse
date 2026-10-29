/* Compile the production pipeline and codecs, mocking only ESP/RTOS/network IO.
 * Every cJSON allocation asserts exclusive ownership of the HTTP memory gate;
 * failures exercise actual journal retention, loss accounting and release paths. */
#include <assert.h>
#include <setjmp.h>
#include <stdlib.h>
#include <string.h>
#include "cJSON.h"
#include "pipeline/host.h"
static unsigned capture_depth;
static void capture_enter(void) { ++capture_depth; }
static void capture_exit(void) { assert(capture_depth); --capture_depth; }
static void *upload_alloc(size_t);
static void upload_free(void *);
static void *seal_alloc(size_t);
static void seal_free(void *);
#define CP_PIPELINE_UPLOAD_ALLOC upload_alloc
#define CP_PIPELINE_UPLOAD_FREE upload_free
#define CP_PIPELINE_SEAL_ALLOC seal_alloc
#define CP_PIPELINE_SEAL_FREE seal_free
#undef portENTER_CRITICAL
#undef portEXIT_CRITICAL
#define portENTER_CRITICAL(lock) do { (void)(lock); capture_enter(); } while (0)
#define portEXIT_CRITICAL(lock) do { (void)(lock); capture_exit(); } while (0)
#include "../components/cp_pipeline/pipeline.c"

static bool memory_owned, http_active, http_finishes_during_wait, store_owned, store_fails;
static unsigned claims, releases, last_wait, allocations, live_allocations, fail_allocation;
static unsigned upload_calls, delays, stop_wait, worker_deletes;
static unsigned upload_live, upload_allocations;
static unsigned seal_live, seal_allocations, seal_releases;
static size_t seal_bytes;
static bool seal_allocation_fails, seal_reduces_heap;
static size_t upload_allocated_bytes;
static bool upload_allocation_fails;
static bool upload_memory_adequate=true;
static unsigned upload_ready_checks,upload_finalizations;
static bool stop_join_times_out, run_uploader;
static uint64_t now_ms = 31000;
static uint32_t internal_heap = 100000;
static uint32_t internal_largest, startup_heap, startup_largest;
static unsigned startup_host_creates, startup_collector_creates;
static unsigned host_stops, host_deinits;
static cp_network_snapshot_t network;
static jmp_buf task_yield;
/* Leave room for a complete 128-address window split into 4 KiB bodies.
 * Production Flash layout and journal admission limits are unchanged. */
static unsigned char flash_bytes[64 * CP_JOURNAL_SLOT_BYTES];
static unsigned char upload_copy[CP_JOURNAL_MAX_BODY];
static size_t upload_length;
static int store_mutex, worker_signal, worker_task, host_signal, host_task_handle;
static bool apply_startup_test;
static bool collector_start_succeeds, host_stop_fails, host_deinit_fails;
static bool capture_queue_enabled, stop_during_timestamp, capture_queue_full;
static cp_report_t captured_report;
static cp_report_t capture_ring[REPORT_QUEUE];
static unsigned captured_count;
static unsigned capture_read_count;
unsigned uxQueueMessagesWaiting(QueueHandle_t queue) {
    (void)queue;
    return captured_count - capture_read_count;
}
static const char *fixture_directory;
static cp_net_upload_result_t upload_result = CP_NET_UPLOAD_RETRY;
static bool run_collector, inject_report_after_timeout, collector_completed;
static unsigned stream_remaining, stream_step_ms, stream_burst;
static bool stream_persist, service_during_delay;
static unsigned persist_preemption_reports;
static bool persist_preempted, seal_after_upload_read;
static unsigned upload_calls_before_persist;
static struct ble_gap_event report_event(void);
test_ble_hs_cfg_t ble_hs_cfg;

static void *checked_malloc(size_t n) {
    assert(memory_owned && !http_active);
    ++allocations;
    if (persist_preemption_reports && !persist_preempted) {
        persist_preempted = true;
        /* Deterministic preemption at a real JSON allocation. Collector work
         * remains allocation-free even while persistence owns the memory gate. */
        for (unsigned i = 0; i < persist_preemption_reports; ++i) {
            cp_report_t r = {.mono_ms = s_window.start_ms + 1 + i,
                .report_seq = i + 100, .address = {1,2,3,4,5,6},
                .raw = CP_RAW_OFF, .rssi = -50};
            consume_report(&r);
        }
    }
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
static void *upload_alloc(size_t n) {
    assert(memory_owned && !store_owned && !http_active && n>=2 && n<=CP_JOURNAL_MAX_BODY+1);
    ++upload_allocations;
    upload_allocated_bytes=n;
    if(upload_allocation_fails)return NULL;
    void *p=malloc(n);assert(p);++upload_live;return p;
}
static void upload_free(void *p) {
    if(p){assert(upload_live);--upload_live;free(p);}
}
static void *seal_alloc(size_t n) {
    assert(memory_owned && !http_active && !store_owned && !capture_depth);
    assert(!s_initialized && !persistence_pending());
    /* The only runtime bank allocation is the two actual-bin arrays. Core
     * storage must never return to a long-lived combined heap allocation. */
    assert(n && n <= 2 * CP_COLLECT_ADDRESSES * CP_COLLECT_BINS * sizeof(uint32_t));
    ++seal_allocations;
    if (seal_allocation_fails)
        return NULL;
    void *p = malloc(n);
    assert(p);
    ++seal_live;
    seal_bytes = n;
    if (seal_reduces_heap)
        internal_heap -= (uint32_t)n;
    return p;
}
static void seal_free(void *p) {
    if (!p)
        return;
    assert(!s_initialized && !persistence_pending() && seal_live);
    --seal_live;
    ++seal_releases;
    free(p);
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
    if (seal_after_upload_read && upload_live) {
        seal_after_upload_read = false;
        close_window(s_window.window_ms);
        upload_calls_before_persist = upload_calls;
    }
}
bool cp_network_begin_upload_memory_work(uint32_t wait,size_t reserve) {
    assert(reserve>=2&&reserve<=CP_JOURNAL_MAX_BODY+1);
    return cp_network_begin_memory_work(wait);
}
bool cp_network_upload_memory_ready(bool allocated) {
    assert(memory_owned&&!store_owned&&allocated==(upload_live!=0));
    ++upload_ready_checks;return allocated&&upload_memory_adequate;
}
void cp_network_finalize_upload_body(void) {
    assert(!memory_owned&&!store_owned&&!upload_live&&!live_allocations);
    ++upload_finalizations;
}
void cp_network_snapshot(cp_network_snapshot_t *out) { *out = network; }
bool cp_network_sha256(const void *p, size_t n, char out[65]) {
    assert(p && n);
    memset(out, 'a', 64);
    out[64] = 0;
    return true;
}
cp_net_upload_result_t cp_network_upload_frozen(const void *p, size_t n,
                                                const cp_network_batch_t *m,
                                                cp_network_ack_t *ack) {
    *ack = (cp_network_ack_t){.http_status = upload_result == CP_NET_UPLOAD_REJECTED ? 422 : 503};
    assert(!memory_owned && !live_allocations && !store_owned && m->accepted_count);
    assert(n <= sizeof upload_copy);
    memcpy(upload_copy, p, n);
    upload_length = n;
    ++upload_calls;
    return upload_result;
}
int64_t esp_timer_get_time(void) {
    if (stop_during_timestamp) {
        stop_during_timestamp = false;
        request_stop_at(now_ms - 1);
    }
    return (int64_t)(now_ms * 1000);
}
size_t esp_get_free_heap_size(void) { return internal_heap; }
size_t heap_caps_get_free_size(uint32_t caps) { (void)caps; return internal_heap; }
size_t heap_caps_get_largest_free_block(uint32_t caps) {
    (void)caps;
    return internal_largest ? internal_largest : internal_heap;
}
size_t heap_caps_get_minimum_free_size(uint32_t caps) { (void)caps; return internal_heap; }
void esp_fill_random(void *data, size_t n) { memset(data, 0x42, n); }
uint32_t esp_random(void) { return 42; }
int esp_bt_controller_get_status(void) { return 0; }
unsigned uxTaskGetStackHighWaterMark(TaskHandle_t h) { (void)h; return 3000; }
int xSemaphoreTake(SemaphoreHandle_t h, TickType_t wait) {
    if (apply_startup_test && (h == &host_signal || (h == &worker_signal && !wait)))
        return wait ? pdTRUE : pdFALSE;
    if (h == &worker_signal) {
        stop_wait = wait;
        assert(!memory_owned || (apply_startup_test && !s_capture_started && !s_accept));
        if (apply_startup_test && startup_heap && !s_capture_started && !stop_join_times_out) {
            /* Join the production collector after a rejected startup, with
             * elapsed time that previously produced a sub-second empty seal. */
            assert(!s_accept && !s_capture_started && s_stop);
            now_ms += 100;
            run_collector = true;
            if (!setjmp(task_yield))
                collector_worker(NULL);
            run_collector = false;
            assert(collector_completed);
        }
        return stop_join_times_out ? pdFALSE : pdTRUE;
    }
    assert(h == &store_mutex && !store_owned);
    if (store_fails)
        return pdFALSE;
    store_owned = true;
    return pdTRUE;
}
int xSemaphoreGive(SemaphoreHandle_t h) {
    if (run_collector && h == &worker_signal) {
        collector_completed = true;
        return pdTRUE;
    }
    assert(h == &store_mutex && store_owned);
    store_owned = false;
    return pdTRUE;
}
void vTaskDelay(TickType_t ticks) {
    now_ms += ticks;
    assert(!memory_owned && !store_owned && !live_allocations && !upload_live);
    ++delays;
    if (service_during_delay) {
        http_active = false;
        (void)persist_pending(0);
    }
    if (run_uploader)
        longjmp(task_yield, 1);
}
void vTaskDelete(TaskHandle_t h) {
    assert(h == &worker_task || (apply_startup_test && h == &host_task_handle));
    ++worker_deletes;
}
/* Unsupported paths fail if accidentally entered by these memory tests. */
int xTaskCreate(void (*fn)(void *), const char *name, unsigned stack, void *arg,
                unsigned priority, TaskHandle_t *out) {
    (void)name; (void)stack; (void)arg; (void)priority;
    assert(apply_startup_test);
    if (fn == host_task) {
        ++startup_host_creates;
        *out = &host_task_handle;
        return pdPASS;
    }
    assert(fn == collector_worker && !s_accept);
    ++startup_collector_creates;
    struct ble_gap_event event = report_event();
    assert(discovery(&event, NULL) == 0 && !captured_count);
    *out = collector_start_succeeds ? &worker_task : NULL;
    if (collector_start_succeeds && startup_heap) {
        assert(s_host == &host_task_handle);
        internal_heap = startup_heap;
        internal_largest = startup_largest;
    }
    return collector_start_succeeds ? pdPASS : pdFALSE;
}
QueueHandle_t xQueueCreate(unsigned capacity, size_t width) {
    (void)capacity; (void)width; assert(false); return NULL;
}
int xQueueReceive(QueueHandle_t q, void *item, TickType_t wait) {
    (void)q;
    assert(run_collector);
    if (stream_remaining) {
        now_ms += stream_step_ms;
        struct ble_gap_event event = report_event();
        for (unsigned n = 0; n < stream_burst; ++n)
            assert(discovery(&event, NULL) == 0);
        if (!--stream_remaining)
            request_stop_at(now_ms);
        /* The previous loop iteration may have published a seal. This mock
         * schedules the real persister between report receives, not in drain. */
        if (stream_persist && persistence_pending())
            (void)persist_pending(0);
    }
    if (inject_report_after_timeout) {
        assert(wait);
        inject_report_after_timeout = false;
        struct ble_gap_event event = report_event();
        assert(discovery(&event, NULL) == 0);
        request_stop_at(now_ms);
        return pdFALSE; /* Snapshot was empty before callback admission/stop. */
    }
    if (capture_read_count < captured_count) {
        *(cp_report_t *)item = capture_ring[capture_read_count % REPORT_QUEUE];
        ++capture_read_count;
        return pdTRUE;
    }
    return pdFALSE;
}
int xQueueSend(QueueHandle_t q, const void *item, TickType_t wait) {
    (void)q;
    assert(capture_queue_enabled && capture_depth == 1 && !wait);
    if (capture_queue_full)
        return pdFALSE;
    if (captured_count - capture_read_count == REPORT_QUEUE)
        return pdFALSE;
    captured_report = *(const cp_report_t *)item;
    capture_ring[captured_count % REPORT_QUEUE] = captured_report;
    ++captured_count;
    return pdTRUE;
}
void vQueueDelete(QueueHandle_t h) { (void)h; assert(false); }
void vTaskSuspend(TaskHandle_t h) {
    assert(!h && run_collector && collector_completed);
    longjmp(task_yield, 1);
}
SemaphoreHandle_t xSemaphoreCreateMutex(void) { assert(false); return NULL; }
SemaphoreHandle_t xSemaphoreCreateBinary(void) { assert(false); return NULL; }
void vSemaphoreDelete(SemaphoreHandle_t h) { (void)h; assert(false); }
EventGroupHandle_t xEventGroupCreate(void) { assert(false); return NULL; }
void vEventGroupDelete(EventGroupHandle_t h) { (void)h; assert(false); }
EventBits_t xEventGroupSetBits(EventGroupHandle_t h, EventBits_t bits) {
    (void)h; assert(apply_startup_test); return bits;
}
EventBits_t xEventGroupClearBits(EventGroupHandle_t h, EventBits_t bits) {
    (void)h; (void)bits; assert(apply_startup_test); return 0;
}
EventBits_t xEventGroupWaitBits(EventGroupHandle_t h, EventBits_t bits,
                               bool clear, bool all, TickType_t wait) {
    (void)h; (void)bits; (void)clear; (void)all; (void)wait;
    assert(apply_startup_test);
    radio_sync();
    struct ble_gap_event event = report_event();
    assert(discovery(&event, NULL) == 0 && !captured_count && !s_accept);
    return READY_BIT;
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
int ble_hs_util_ensure_addr(unsigned value) { (void)value; assert(apply_startup_test); return 0; }
int ble_hs_id_infer_auto(unsigned value, uint8_t *out) {
    (void)value; *out = 0; assert(apply_startup_test); return 0;
}
int ble_gap_disc(uint8_t addr, int32_t duration, const struct ble_gap_disc_params *p,
                 int (*cb)(struct ble_gap_event *, void *), void *arg) {
    (void)addr; (void)duration; (void)p; (void)cb; (void)arg; assert(apply_startup_test); return 0;
}
void ble_svc_gap_init(void) { assert(apply_startup_test); }
void ble_svc_gatt_init(void) { assert(apply_startup_test); }
esp_err_t nimble_port_init(void) { assert(apply_startup_test); return ESP_OK; }
void nimble_port_run(void) { assert(false); }
int nimble_port_stop(void) {
    assert(apply_startup_test); ++host_stops; return host_stop_fails ? -1 : 0;
}
esp_err_t nimble_port_deinit(void) {
    ++host_deinits; return host_deinit_fails ? ESP_FAIL : ESP_OK;
}

static bool test_flash_read(void *ctx, size_t off, void *out, size_t n) {
    (void)ctx;
    assert(off + n <= sizeof flash_bytes);
    memcpy(out, flash_bytes + off, n);
    return true;
}
static bool test_flash_write(void *ctx, size_t off, const void *in, size_t n) {
    (void)ctx;
    assert(store_owned && off + n <= sizeof flash_bytes);
    /* Journal ACK writes only its existing four-byte state marker, after TLS
     * and the body are released; append/erase still require the memory gate. */
    assert(memory_owned || (run_uploader && upload_result == CP_NET_UPLOAD_ACKED &&
                            n == 4 && !http_active && !upload_live && !live_allocations));
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
    s_initialized = s_persist_busy = s_final_window_pending = false;
    s_sealed.pending = s_raw_handoff.pending = false;
    release_seal_bank();
    assert(!seal_live);
    memset(&s_health, 0, sizeof s_health);
    memset(&s_sealed, 0, sizeof s_sealed);
    memset(&s_raw_handoff, 0, sizeof s_raw_handoff);
    s_persist_busy = s_final_window_pending = false;
    s_final_duration = s_collector_stack_free = 0;
    s_final_sealed_ms = 0;
    s_active_window_seq = 1;
    s_active_raw_failures = 0;
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
    s_host_done = &host_signal;
    apply_startup_test = false;
    collector_start_succeeds = host_stop_fails = host_deinit_fails = false;
    s_worker = s_host = NULL;
    s_initialized = s_policy_owned = s_stop_failed = s_pressure_paused = false;
    s_memory_paused = s_memory_raw_paused = s_raw_paused = false;
    s_accept = true;
    s_capture_started = true;
    s_stop = false;
    s_idle_pause_tick = s_idle_status_at = s_stop_at = s_raw_paused_ms = 0;
    s_last_ingress_ms = s_lease_deadline = 0;
    s_origin = 1000;
    s_first_window = 1;
    s_report_seq = 0;
    capture_queue_enabled = stop_during_timestamp = capture_queue_full = false;
    captured_count = capture_depth = 0;
    upload_result = CP_NET_UPLOAD_RETRY;
    run_collector = inject_report_after_timeout = collector_completed = false;
    capture_read_count = 0;
    stream_remaining = stream_step_ms = 0;
    stream_burst = 1;
    stream_persist = service_during_delay = false;
    persist_preemption_reports = 0;
    persist_preempted = seal_after_upload_read = false;
    upload_calls_before_persist = 0;
    s_resource_exhaustions_seen = s_raw_queue_drops = s_raw_pressure_skips = 0;
    s_unpersisted_window_reports = s_status_dropped = s_address_overflow_reports = 0;
    s_status_seq = s_summary_seq = s_loss_overruns = 0;
    http_active = http_finishes_during_wait = store_fails = false;
    stop_join_times_out = run_uploader = false;
    claims = releases = allocations = fail_allocation = last_wait = 0;
    upload_calls = delays = stop_wait = worker_deletes = 0;
    assert(!upload_live);
    upload_allocations=0;upload_allocated_bytes=0;upload_allocation_fails=false;
    upload_memory_adequate=true;upload_ready_checks=upload_finalizations=0;
    now_ms = 31000;
    internal_heap = 100000;
    internal_largest = startup_heap = startup_largest = 0;
    startup_host_creates = startup_collector_creates = host_stops = host_deinits = 0;
    seal_allocation_fails = seal_reduces_heap = false;
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
    network.policy_response_sequence = 1;
    s_health.storage_ready = true;
    update_store_health();
    memory_owned = true;
    assert(reserve_seal_bank(s_policy.max_addresses, cp_collect_bin_count(s_policy.summary_window_ms, s_policy.summary_bin_ms)));
    memory_owned = false;
    assert(cp_collect_compact_begin(&s_window, 1000, 30000, 5000, 1, 4, true));
    seal_allocations = seal_releases = 0;
}
static void observe(unsigned count) {
    for (unsigned i = 0; i < count; ++i) {
        cp_report_t r = {.mono_ms = 1001 + i, .report_seq = i + 1, .address = {1, 2, 3, 4, 5, 6},
                         .raw = CP_RAW_SELECTED, .rssi = -50};
        assert(cp_collect_compact_observe(&s_window, &r));
    }
}
static void read_slot(unsigned slot, char out[CP_JOURNAL_MAX_BODY + 1]) {
    size_t n;
    assert(cp_journal_read(&s_journal, slot, out, CP_JOURNAL_MAX_BODY, &n) == CP_JOURNAL_OK);
    out[n] = 0;
}
static void assert_released(void) {
    assert(!memory_owned && !store_owned && !live_allocations && !capture_depth);
}
static void write_fixtures(const char *prefix) {
    if (!fixture_directory)
        return;
    for (unsigned slot = 0; slot < s_journal.count; slot++) {
        if (s_journal.slots[slot].state != CP_SLOT_PENDING)
            continue;
        char body[CP_JOURNAL_MAX_BODY + 1], path[512];
        read_slot(slot, body);
        int n = snprintf(path, sizeof path, "%s/%s-%u.json", fixture_directory, prefix, slot);
        assert(n > 0 && (size_t)n < sizeof path);
        FILE *file = fopen(path, "wb");
        assert(file && fwrite(body, 1, strlen(body), file) == strlen(body));
        assert(fclose(file) == 0);
    }
}
static struct ble_gap_event report_event(void) {
    static const uint8_t payload[] = {2, 1, 6};
    return (struct ble_gap_event){.type = BLE_GAP_EVENT_DISC,
        .disc = {.addr = {.val = {6, 5, 4, 3, 2, 1}, .type = 0}, .rssi = -50,
                 .length_data = sizeof payload, .data = payload}};
}
static void seal_and_persist(uint32_t duration) {
    close_window(duration);
    assert(persist_pending(MEMORY_WORK_WAIT_MS));
}
static void handoff_and_persist(void) {
    flush_raw_if_idle();
    if (persistence_pending())
        (void)persist_pending(0);
}
static void test_stop_boundary_and_inflight_ingress(void) {
    reset();
    capture_queue_enabled = true;
    now_ms = 6000;
    struct ble_gap_event event = report_event();
    assert(discovery(&event, NULL) == 0 && captured_count == 1);
    assert(cp_collect_compact_observe(&s_window, &captured_report));
    request_stop_at(now_ms);
    assert(s_stop_at == 6001 && !s_accept && s_last_ingress_ms == 6000);
    seal_and_persist((uint32_t)(s_stop_at - s_window.start_ms));
    assert(s_health.summaries_committed == 1 && !s_health.summary_drops);
    write_fixtures("exclusive-stop");
    assert_released();

    reset();
    capture_queue_enabled = stop_during_timestamp = true;
    now_ms = 6000;
    assert(discovery(&event, NULL) == 0);
    assert(!captured_count && !s_report_seq && !s_health.reports_seen && !s_last_ingress_ms);
    assert(s_stop_at == 5999 && !s_accept);
    assert_released();

    reset();
    capture_queue_enabled = capture_queue_full = true;
    now_ms = 6000;
    assert(discovery(&event, NULL) == 0);
    request_stop_at(now_ms);
    assert(!captured_count && s_stop_at == 6001 && s_losses[1].drops == 1);
    assert(s_health.callback_queue_drops == 1 && !s_health.collector_rejections);
    seal_and_persist((uint32_t)(s_stop_at - s_window.start_ms));
    assert(s_health.aggregation_drops == 1 && !s_health.windows_dropped);
    assert_released();

    reset();
    capture_queue_enabled = true;
    now_ms = s_lease_deadline = 6000;
    assert(discovery(&event, NULL) == 0);
    assert(!captured_count && !s_report_seq && s_stop_at == 6000);
    assert_released();
}
static void test_sub_bin_partial_windows(void) {
    const unsigned durations[] = {1488, 1880, 4999, 5000, 5001};
    for (unsigned i = 0; i < sizeof durations / sizeof durations[0]; i++) {
        reset();
        s_policy.raw_enabled = false;
        assert(cp_collect_compact_begin(&s_window, 1000, 30000, 5000, 1, 4, false));
        cp_report_t report = {.mono_ms = 1000 + durations[i] - 1, .report_seq = 1,
            .address = {2, 0, 0, 0, 0, 1}, .rssi = -50};
        static const uint8_t evidence[][11] = {
            {6,9,'Y','A','D','E','A'}, {4,9,'B','Y','D'}, {5,9,'X'},
            {6,9,'Y','A','D','E','A',3,3,0x12,0x18}, {3,0xff,0x20,0x00}
        };
        static const uint8_t lengths[] = {7,5,3,11,4};
        report.payload_length = lengths[i];
        memcpy(report.payload, evidence[i], lengths[i]);
        assert(cp_collect_compact_observe(&s_window, &report));
        seal_and_persist(durations[i]);
        assert(s_health.windows_committed == 1 && s_health.summaries_committed == 1);
        assert(!s_health.windows_dropped && !s_health.summary_drops);
        char prefix[32];
        snprintf(prefix, sizeof prefix, "partial-%u", durations[i]);
        write_fixtures(prefix);
        assert_released();
    }
}
static void test_full_vehicle_summary_window(void) {
    reset();
    s_policy.raw_enabled = false;
    s_policy.max_addresses = 64;
    s_policy.max_body_bytes = 8192;
    memory_owned = true;
    assert(reserve_seal_bank(s_policy.max_addresses, cp_collect_bin_count(s_policy.summary_window_ms, s_policy.summary_bin_ms)));
    memory_owned = false;
    assert(cp_collect_compact_begin(&s_window, 1000, 30000, 5000, 1, 64, false));
    for (unsigned i = 0; i < 64; ++i) {
        cp_report_t report = {.mono_ms = 1001 + i, .report_seq = i + 1,
            .address = {2,0,0,0,0,(uint8_t)i}, .rssi = -50,
            .payload_length = 7, .payload = {6,9,'Y','A','D','E','A'}};
        assert(cp_collect_compact_observe(&s_window, &report));
    }
    seal_and_persist(30000);
    assert(s_health.windows_committed == 1 && s_health.summaries_committed == 64);
    assert(s_health.pending == 7 && !s_health.windows_dropped && !s_health.summary_drops);
    assert(s_sealed.window.raw_count == 0 && s_sealed.window.address_count == 64);
    write_fixtures("vehicle-full64");
    assert_released();
}
static void test_final_drain_after_timeout(void) {
    reset();
    capture_queue_enabled = run_collector = inject_report_after_timeout = true;
    now_ms = 6000;
    if (!setjmp(task_yield))
        collector_worker(NULL);
    assert(collector_completed && captured_count == 1 && capture_read_count == 1);
    assert(s_sealed.pending && !claims);
    assert(persist_pending(0));
    assert(s_stop_at == 6001 && s_health.windows_committed == 1 && s_health.summaries_committed == 1);
    assert(s_window.reports_seen == 1 && !s_health.windows_dropped && !s_health.summary_drops);
    write_fixtures("exclusive-stop-drain");
    assert_released();
}
static void test_window_and_status_share_claim(void) {
    reset();
    observe(3);
    http_active = http_finishes_during_wait = true;
    seal_and_persist(30000);
    assert_released();
    assert(claims == 1 && releases == 1 && last_wait == 15000);
    assert(s_health.windows_committed == 1 && s_health.summaries_committed == 1);
    assert(s_health.pending == 4 && !s_health.windows_dropped && s_status_seq == 1);
}
static void test_timeout_losses_and_status_retry(void) {
    reset(); observe(6);
    s_losses[1] = (loss_bucket_t){.window = 1, .drops = 3, .selected_drops = 1,
                                .intentional = 1, .pressure = 1};
    http_active = true;
    close_window(30000);
    assert(!claims && !allocations && s_sealed.pending);
    assert(!persist_pending(0) && !persist_pending(MEMORY_WORK_WAIT_MS));
    assert(s_sealed.pending && !s_health.windows_dropped && !s_health.raw_drops);
    assert(!s_health.pending && !s_status_dropped);
    assert_released();
    http_active = false;
    assert(persist_pending(0));
    assert(!s_sealed.pending && s_health.windows_committed == 1);
    assert(s_health.raw_drops == 3 && s_health.aggregation_drops == 3);
    assert(!s_unpersisted_window_reports && s_raw_queue_drops == 1 && s_raw_pressure_skips == 1);
    assert_released();
}
static void test_raw_deferral_keeps_bounded_accounting(void) {
    reset(); observe(3);
    http_active = true;
    flush_raw_if_idle();
    assert(!s_window.raw_count && s_raw_handoff.pending && s_raw_handoff.count == 3);
    assert(!claims && !allocations);
    assert(!persist_pending(0) && s_raw_handoff.pending);
    observe(3);
    assert(s_window.raw_count == 3 && !s_window.raw_drops);
    flush_raw_if_idle(); /* Busy handoff never overwrites retained raw. */
    assert(s_raw_handoff.count == 3 && s_window.raw_count == 3);
    close_window(30000);
    http_active = false;
    assert(persist_pending(0));
    assert(!s_raw_handoff.pending && !s_sealed.pending);
    assert(!s_health.raw_drops && !s_health.windows_dropped && s_health.pending == 5);
    assert_released();
}
static void test_invalid_ingress_loss_preserves_raw_and_releases(void) {
    reset();
    observe(2);
    /* An inconsistent ingress loss bucket cannot produce a truthful window,
     * but its loss total and the raw already retained still have owners. */
    s_losses[1] = (loss_bucket_t){.window = 1, .drops = 2};
    seal_and_persist(30000);
    assert_released();
    assert(claims == 1 && releases == 1 && s_health.pending == 2);
    assert(s_health.windows_dropped == 1 && s_health.summary_drops == 1);
    assert(s_unpersisted_window_reports == 4 && s_health.aggregation_drops == 2);
    assert(!s_health.raw_drops && !s_sealed.window.raw_count);
}
static void test_allocation_and_store_failures_release(void) {
    reset();
    observe(2);
    seal_and_persist(30000);
    unsigned count = allocations;
    assert(count > 100);
    for (unsigned i = 1; i <= count; ++i) {
        reset();
        observe(2);
        fail_allocation = i;
        seal_and_persist(30000);
        assert_released();
        assert(claims == 1 && releases == 1);
        assert(s_health.windows_committed + s_health.windows_dropped == 1);
        assert(s_health.summaries_committed + s_health.summary_drops == 1);
    }
    printf("Pipeline window/status OOM sweep: %u allocation sites passed\n", count);
    reset();
    observe(2);
    store_fails = true;
    seal_and_persist(30000);
    assert_released();
    assert(s_health.windows_dropped == 1 && s_health.summary_drops == 1);
    assert(s_health.raw_drops == 2 && s_status_dropped == 1 && !s_health.pending);
    assert(claims == 1 && releases == 1);
}
static void test_metadata_failure_and_upload_preserve_frozen_bytes(void) {
    reset();
    observe(1);
    handoff_and_persist();
    char frozen[CP_JOURNAL_MAX_BODY + 1];
    read_slot(0, frozen);
    cp_network_batch_t meta;
    allocations = 0;
    assert(batch_metadata(frozen, strlen(frozen), &meta));
    unsigned count = allocations;
    for (unsigned i = 1; i <= count; ++i) {
        allocations = 0;
        fail_allocation = i;
        assert(!batch_metadata(frozen, strlen(frozen), &meta));
        assert_released();
        assert(s_health.pending == 1 && s_journal.slots[0].state == CP_SLOT_PENDING);
    }
    printf("Pipeline metadata OOM sweep: %u allocation sites passed\n", count);
    fail_allocation = 0;
    assert(!batch_metadata("{invalid", strlen("{invalid"), &meta));
    assert_released();
    http_active = true;
    unsigned before = allocations;
    assert(batch_metadata(frozen, strlen(frozen), &meta) && allocations == before);
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
static void test_rejected_slot_preserved_without_blocking_later_batches(void) {
    reset();
    observe(1);
    handoff_and_persist();
    cp_report_t report = {.mono_ms = 1002, .report_seq = 2, .address = {1, 2, 3, 4, 5, 6},
        .raw = CP_RAW_SELECTED, .rssi = -50};
    assert(cp_collect_compact_observe(&s_window, &report));
    handoff_and_persist();
    char before[CP_JOURNAL_MAX_BODY + 1], after[CP_JOURNAL_MAX_BODY + 1];
    read_slot(0, before);
    upload_result = CP_NET_UPLOAD_REJECTED;
    run_uploader = true;
    if (!setjmp(task_yield))
        uploader_task(NULL);
    assert(upload_calls == 1 && s_upload_scheduler.blocked[0]);
    assert(s_journal.slots[0].state == CP_SLOT_PENDING && s_health.pending == 2);
    read_slot(0, after);
    assert(!strcmp(before, after));
    if (!setjmp(task_yield))
        uploader_task(NULL);
    assert(upload_calls == 2 && s_upload_scheduler.blocked[1]);
    assert(s_health.rejected_batches == 2 && s_health.pending == 2);
    if (!setjmp(task_yield))
        uploader_task(NULL);
    assert(upload_calls == 2 && s_health.pending == 2);
    read_slot(0, after);
    assert(!strcmp(before, after));
    assert_released();
}
static void test_backlog_waits_for_first_desired_response(void) {
    reset();
    observe(1);
    handoff_and_persist();
    char frozen[CP_JOURNAL_MAX_BODY + 1];
    read_slot(0, frozen);
    network.policy_response_sequence = 0;
    run_uploader = true;
    if (!setjmp(task_yield))
        uploader_task(NULL);
    assert(!upload_calls && s_health.pending == 1 && !s_health.upload_failures);
    network.policy_response_sequence = 1;
    if (!setjmp(task_yield))
        uploader_task(NULL);
    assert(upload_calls == 1 && s_health.pending == 1);
    assert(upload_length == strlen(frozen) && !memcmp(upload_copy, frozen, upload_length));
    assert_released();
}
static void test_exact_upload_allocation_and_failure_retention(void) {
    reset();observe(1);handoff_and_persist();
    size_t expected=s_journal.slots[0].length;
    upload_allocation_fails=true;run_uploader=true;
    if(!setjmp(task_yield))uploader_task(NULL);
    assert(!upload_calls&&!upload_live&&s_health.pending==1&&s_health.upload_failures==1);
    assert(upload_allocated_bytes==expected+1);
    assert(upload_ready_checks>=1&&upload_finalizations==0);
    upload_allocation_fails=false;now_ms+=60000;
    if(!setjmp(task_yield))uploader_task(NULL);
    assert(upload_calls==1&&!upload_live&&upload_length==expected&&s_health.pending==1);
    assert(upload_allocated_bytes==expected+1);
    assert(upload_ready_checks>=2&&upload_finalizations==1);
    /* A real post-malloc floor failure defers without uploading or changing
     * the frozen slot. The body is gone before the idle finalizer runs. */
    upload_memory_adequate=false;now_ms+=60000;
    if(!setjmp(task_yield))uploader_task(NULL);
    assert(upload_calls==1&&!upload_live&&s_health.pending==1&&upload_finalizations==1);
    /* Imported full-size frozen bodies retain their exact admission ceiling. */
    reset();unsigned char maximum[CP_JOURNAL_MAX_BODY];memset(maximum,'x',sizeof maximum);
    uint16_t slot;memory_owned=store_owned=true;
    assert(cp_journal_append(&s_journal,maximum,sizeof maximum,false,&slot)==CP_JOURNAL_OK);
    memory_owned=store_owned=false;
    size_t length;unsigned char *body=read_upload_body(slot,&length);
    assert(body&&length==sizeof maximum&&upload_allocated_bytes==sizeof maximum+1);
    assert(!memcmp(body,maximum,length)&&body[length]==0);upload_free(body);assert_released();
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
static void run_stream(unsigned count, unsigned step, unsigned window_ms, bool raw) {
    s_policy.raw_enabled = raw;
    s_policy.summary_window_ms = window_ms;
    s_policy.summary_bin_ms = window_ms <= 1000 ? 1000 : window_ms / 2;
    s_policy.flush_max_age_ms = 1000;
    /* Establish the requested synthetic policy before injecting an HTTP hold. */
    bool held_http = http_active;
    http_active = false;
    memory_owned = true;
    assert(reserve_seal_bank(4, cp_collect_bin_count(window_ms, s_policy.summary_bin_ms)));
    memory_owned = false;
    http_active = held_http;
    seal_allocations = seal_releases = 0;
    assert(cp_collect_compact_begin(&s_window, 1000, window_ms, s_policy.summary_bin_ms, 1, 4, raw));
    capture_queue_enabled = run_collector = true;
    stream_remaining = count;
    stream_step_ms = step;
    now_ms = 1000;
    if (!setjmp(task_yield))
        collector_worker(NULL);
    assert(collector_completed && capture_read_count == captured_count);
}
static void test_tls_blocked_collector_keeps_draining(void) {
    reset();
    http_active = true;
    run_stream(2499, 10, 30000, false); /* Almost 25 s: far longer than 64/report rate. */
    assert(captured_count == 2499 && s_health.reports_seen == 2499);
    assert(!s_health.callback_queue_drops && !s_health.collector_rejections);
    assert(s_health.report_queue_highwater == 1 && !s_health.seal_overflows);
    assert(!claims && !allocations && s_sealed.pending);
    assert(s_sealed.window.reports_seen == 2499 && s_sealed.duration == 24991);
    assert(!persist_pending(0) && s_sealed.pending);
    http_active = false;
    now_ms += 12000;
    assert(persist_pending(0));
    assert(s_health.windows_committed == 1 && s_health.seal_wait_max_ms == 12000);
    write_fixtures("tls-blocked-drain");
    assert_released();
}
static void test_tls_spans_multiple_windows_and_overflow_is_exact(void) {
    reset();
    http_active = true;
    run_stream(350, 10, 1000, false);
    /* [1000,2000) has 99 reports. Following two full windows have 100
     * each, final [4000,4501) has 51. Capacity one retains the oldest. */
    assert(captured_count == 350 && !s_health.callback_queue_drops);
    assert(s_sealed.pending && s_sealed.window.window_seq == 1);
    assert(s_sealed.window.reports_seen == 99 && s_sealed.duration == 1000);
    assert(s_health.windows_dropped == 2 && s_health.seal_overflows == 2);
    assert(s_unpersisted_window_reports == 200 && s_health.summary_drops == 2);
    assert(s_final_window_pending && s_final_duration == 501);
    assert(!s_health.aggregation_drops && !s_health.raw_drops && !claims);
    http_active = false;
    assert(persist_pending(0));
    /* The final stopped buffer is retained and evaluated separately; its
     * subsecond duration is explicitly unrepresentable on the wire. */
    assert(!s_final_window_pending && s_health.windows_dropped == 3);
    assert(s_unpersisted_window_reports == 251);
    assert(s_health.windows_committed == 1 && s_next_window == 5);
    write_fixtures("seal-capacity");
    assert_released();
}
static void test_persistence_preemption_preserves_new_active_window(void) {
    reset(); s_policy.raw_enabled = false;
    assert(cp_collect_compact_begin(&s_window, 1000, 30000, 5000, 1, 4, false));
    cp_report_t r = {.mono_ms = 1001, .report_seq = 1, .address = {1,2,3,4,5,6},
        .rssi = -50, .raw = CP_RAW_OFF};
    assert(cp_collect_compact_observe(&s_window, &r));
    close_window(30000);
    assert(next_window());
    persist_preemption_reports = 512;
    assert(persist_pending(0));
    assert(persist_preempted && s_window.window_seq == 2 && s_window.reports_seen == 512);
    assert(s_health.windows_committed == 1 && !s_health.windows_dropped);
    persist_preemption_reports = 0;
    close_window(30000);
    assert(persist_pending(0));
    assert(s_health.windows_committed == 2 && s_health.summaries_committed == 2);
    write_fixtures("persist-preemption");
    assert_released();
}
static void test_ordered_raw_failures_at_every_handoff_state(void) {
    /* Completion while still active, after sealing, and after overflow/drop. */
    for (unsigned stage = 0; stage < 3; ++stage) {
        reset(); observe(2);
        flush_raw_if_idle();
        if (stage == 1)
            close_window(30000);
        if (stage == 2) {
            close_window(30000);
            assert(next_window());
            /* Existing raw belongs to retained window 1. Persist it before
             * its window, then stage a raw handoff for the overflowing 2. */
            assert(persist_pending(0));
            cp_report_t r = {.mono_ms = 31001, .report_seq = 3,
                .address = {1,2,3,4,5,6}, .raw = CP_RAW_SELECTED, .rssi = -50};
            assert(cp_collect_compact_observe(&s_window, &r));
            close_window(30000); /* Retain window 2. */
            assert(next_window());
            r.mono_ms = 61001; r.report_seq = 4;
            assert(cp_collect_compact_observe(&s_window, &r));
            flush_raw_if_idle();
            close_window(30000); /* Window 3 drops but its raw has an owner. */
            assert(s_health.windows_dropped == 1 && s_health.seal_overflows == 1);
        }
        store_fails = true;
        assert(persist_pending(0));
        store_fails = false;
        if (stage == 0) {
            assert(s_active_raw_failures == 2 && !s_health.raw_drops);
            close_window(30000);
            assert(persist_pending(0));
            assert(s_health.raw_drops == 2 && s_health.windows_committed == 1);
        } else if (stage == 1) {
            assert(s_health.raw_drops == 2 && s_health.windows_dropped == 1);
        } else {
            assert(s_health.raw_drops == 2); /* Raw retained in 2 + detached raw from dropped 3. */
            assert(!s_active_raw_failures && !s_raw_handoff.pending);
        }
        assert_released();
    }
}
static void test_stop_retains_retryable_seal_and_old_policy(void) {
    reset(); observe(2); close_window(30000);
    cp_address_core_t *bank = s_sealed.addresses;
    size_t bank_bytes = seal_bytes;
    s_initialized = true;
    request_stop_at(31000);
    http_active = true;
    cp_network_policy_t next = s_policy;
    strcpy(next.core.config_id, "replacement-config");
    assert(cp_pipeline_apply(&next) == ESP_ERR_TIMEOUT);
    assert(s_initialized && !s_stop_failed && s_sealed.pending);
    assert(s_sealed.addresses == bank && seal_bytes == bank_bytes && !seal_releases);
    assert(!strcmp(s_policy.core.config_id, "synthetic-config"));
    assert(!s_health.windows_dropped && !s_health.raw_drops && !allocations);
    service_during_delay = true;
    assert(cp_pipeline_stop() == ESP_OK);
    assert(!s_initialized && !persistence_pending() && s_health.windows_committed == 1);
    assert(!s_sealed.addresses && !seal_live && seal_releases == 1);
    assert(!strcmp(s_policy.core.config_id, "synthetic-config"));
    write_fixtures("stop-retry-old-policy");
    assert_released();
}
static void test_sealed_lease_boundary_and_callback_overflow(void) {
    reset();
    s_lease_deadline = 3000;
    http_active = true;
    run_stream(200, 10, 30000, false);
    assert(s_stop_at == 3000 && s_sealed.duration == 2000);
    assert(s_health.reports_seen == 199 && s_sealed.window.reports_seen == 199);
    assert(!s_health.callback_queue_drops && !claims);
    http_active = false;
    assert(persist_pending(0));
    write_fixtures("lease-exact");
    reset(); http_active = true;
    stream_burst = REPORT_QUEUE + 6;
    run_stream(1, 10, 30000, true);
    assert(captured_count == REPORT_QUEUE && s_health.callback_queue_drops == 6);
    assert(s_sealed.window.reports_seen == REPORT_QUEUE + 6);
    assert(s_sealed.window.aggregation_drops == 6 && s_sealed.window.selected == 4);
    assert(s_sealed.window.intentional == REPORT_QUEUE + 2 && !s_sealed.window.raw_drops);
    http_active = false;
    assert(persist_pending(0));
    /* Subsecond aggregate is truthfully omitted, selected raw remains durable. */
    assert(s_health.windows_dropped == 1 && !s_health.raw_drops);
    assert(s_health.aggregation_drops == 6 && s_health.pending == 2);
    assert_released();
}
static void test_stop_retains_final_behind_busy_seal(void) {
    reset(); http_active = true;
    run_stream(450, 10, 3000, false);
    assert(s_sealed.pending && s_sealed.window.window_seq == 1);
    assert(s_sealed.window.reports_seen == 299 && s_sealed.duration == 3000);
    assert(s_final_window_pending && s_final_duration == 1501);
    assert(s_window.window_seq == 2 && s_window.reports_seen == 151);
    cp_address_core_t *bank = s_sealed.addresses;
    memory_owned = true;
    assert(!reserve_seal_bank(16, 6) && s_sealed.addresses == bank && !seal_allocations);
    memory_owned = false;
    assert(!s_health.windows_dropped && !s_health.seal_overflows && !claims);
    s_initialized = true;
    http_active = false;
    assert(cp_pipeline_stop() == ESP_OK);
    assert(!s_initialized && !persistence_pending());
    assert(!s_sealed.addresses && !seal_live && seal_releases == 1);
    assert(s_health.windows_committed == 2 && !s_health.windows_dropped);
    assert(s_health.summaries_committed == 2 && !s_unpersisted_window_reports);
    assert(s_next_window == 3);
    write_fixtures("stop-kept-final");
    assert_released();
}
static void test_raw_on_tls_blocked_worker_preserves_sample_policy(void) {
    reset(); http_active = true;
    run_stream(2499, 10, 30000, true);
    assert(s_raw_handoff.pending && s_raw_handoff.count == CP_COLLECT_RAW);
    assert(s_sealed.pending && s_sealed.window.selected == CP_COLLECT_RAW);
    assert(s_sealed.window.intentional == 2499 - CP_COLLECT_RAW);
    assert(!s_sealed.window.raw_count && !s_sealed.window.raw_drops);
    assert(!s_health.callback_queue_drops && !claims && !allocations);
    http_active = false;
    assert(persist_pending(0));
    assert(!persistence_pending() && !s_health.raw_drops && !s_health.windows_dropped);
    assert(s_health.windows_committed == 1 && s_health.pending == 4);
    write_fixtures("tls-blocked-raw");
    assert_released();
}
static void test_raw_failure_precedes_frozen_same_window(void) {
    reset(); observe(2); flush_raw_if_idle(); close_window(30000);
    fail_allocation = 1; /* Raw fails; the subsequent summary/window succeed. */
    assert(persist_pending(0));
    assert(!persistence_pending() && s_health.raw_drops == 2);
    assert(s_health.windows_committed == 1 && !s_health.windows_dropped);
    char body[CP_JOURNAL_MAX_BODY + 1];
    read_slot(1, body);
    assert(strstr(body, "\"stream\":\"ble_windows\"") &&
           strstr(body, "\"selected_reports\":2") && strstr(body, "\"drops\":2"));
    write_fixtures("raw-failure-before-window");
    assert_released();
}
static void test_seal_after_body_read_is_persisted_before_tls(void) {
    reset(); observe(1); handoff_and_persist();
    cp_report_t r = {.mono_ms = 1002, .report_seq = 2, .address = {1,2,3,4,5,6},
        .raw = CP_RAW_SELECTED, .rssi = -50};
    assert(cp_collect_compact_observe(&s_window, &r));
    seal_after_upload_read = true;
    run_uploader = true;
    if (!setjmp(task_yield))
        uploader_task(NULL);
    assert(!seal_after_upload_read && !upload_calls_before_persist);
    assert(s_health.windows_committed == 1 && !persistence_pending());
    assert(upload_calls == 1 && upload_allocations == 2 && upload_finalizations == 2);
    assert(!s_health.windows_dropped && !s_health.raw_drops);
    assert_released();
}
static void test_handoff_frozen_retry_and_verified_ack_reclaim(void) {
    reset(); observe(3); flush_raw_if_idle(); assert(persist_pending(0));
    /* Pin the raw handoff's exact original body across bad receipt, retry,
     * and the network layer's verified receipt result. */
    uint16_t slot = cp_upload_scheduler_select(&s_upload_scheduler, s_journal.slots,
                                               s_journal.count, now_ms);
    assert(slot != CP_UPLOAD_NO_SLOT);
    char frozen[CP_JOURNAL_MAX_BODY + 1]; read_slot(slot, frozen);
    unsigned pending = s_health.pending;
    run_uploader = true;
    upload_result = CP_NET_UPLOAD_BAD_ACK;
    if (!setjmp(task_yield)) uploader_task(NULL);
    assert(s_health.pending == pending && s_health.ack_failures == 1);
    assert(s_journal.slots[slot].state == CP_SLOT_PENDING);
    assert(upload_length == strlen(frozen) && !memcmp(upload_copy, frozen, upload_length));
    /* Advance through the stream head's bounded retry backoff. */
    now_ms += 60000;
    upload_result = CP_NET_UPLOAD_RETRY;
    if (!setjmp(task_yield)) uploader_task(NULL);
    assert(s_health.pending == pending && s_journal.slots[slot].state == CP_SLOT_PENDING);
    assert(upload_length == strlen(frozen) && !memcmp(upload_copy, frozen, upload_length));
    now_ms += 60000;
    upload_result = CP_NET_UPLOAD_ACKED;
    if (!setjmp(task_yield)) uploader_task(NULL);
    assert(s_health.pending == pending - 1 && s_journal.slots[slot].state != CP_SLOT_PENDING);
    assert(upload_length == strlen(frozen) && !memcmp(upload_copy, frozen, upload_length));
    assert_released();
}
static void test_collector_startup_oom_never_opens_ingress(void) {
    reset();
    s_accept = false;
    apply_startup_test = capture_queue_enabled = true;
    assert(cp_pipeline_apply(&s_policy) == ESP_ERR_NO_MEM);
    assert(!s_accept && !s_initialized && !s_worker && !s_host);
    assert(!captured_count && !capture_read_count && !s_health.reports_seen);
    assert(!persistence_pending() && !s_stop_failed);
    assert(!s_sealed.addresses && !seal_live && seal_releases == 1);
    assert_released();
}
static esp_err_t apply_with_gate(const cp_network_policy_t *policy) {
    assert(!memory_owned && !http_active && !s_initialized && !persistence_pending());
    memory_owned = true;
    esp_err_t err = cp_pipeline_apply(policy);
    memory_owned = false;
    return err;
}
static void assert_unaccepted_startup(void) {
    assert(!s_accept && !s_capture_started && !captured_count && !capture_read_count);
    assert(!s_report_seq && !s_health.reports_seen && !s_last_ingress_ms);
    assert(!s_health.windows_committed && !s_health.windows_dropped);
    assert(!s_health.summaries_committed && !s_health.summary_drops && !s_health.raw_drops);
    assert(!s_health.callback_queue_drops && !s_health.storage_drops && !persistence_pending());
    assert(startup_host_creates == 1 && startup_collector_creates == 1);
    assert(s_memory_paused && s_memory.scan_paused && s_memory.raw_paused);
    assert(s_memory_policy_sequence == s_policy.request_sequence);
    assert_released();
}
static void test_post_init_memory_admission(void) {
    /* Independent free/largest boundaries: initialization is admitted from
     * 100 KiB, then only completed task creation lowers the actual heap. */
    const struct { uint32_t free, largest; bool accepted; } cases[] = {
        {14064, 7680, false},
        {CP_MEMORY_STOP_FREE - 1, CP_MEMORY_STOP_LARGEST, false},
        {CP_MEMORY_STOP_FREE, CP_MEMORY_STOP_LARGEST - 1, false},
        {CP_MEMORY_STOP_FREE, CP_MEMORY_STOP_LARGEST, true},
        {CP_MEMORY_START_FREE, CP_MEMORY_START_LARGEST, true},
    };
    for (unsigned i = 0; i < sizeof cases / sizeof cases[0]; ++i) {
        reset();
        s_accept = false;
        apply_startup_test = capture_queue_enabled = collector_start_succeeds = true;
        startup_heap = cases[i].free;
        startup_largest = cases[i].largest;
        unsigned next_window_seq = s_next_window;
        assert(apply_with_gate(&s_policy) == (cases[i].accepted ? ESP_OK : ESP_ERR_NO_MEM));
        if (cases[i].accepted) {
            assert(s_accept && s_capture_started && s_initialized && s_worker && s_host);
            assert(!s_memory_paused && !s_stop_failed && !captured_count);
            assert(startup_host_creates == 1 && startup_collector_creates == 1);
            assert(cp_pipeline_stop() == ESP_OK);
        } else {
            assert_unaccepted_startup();
            assert(collector_completed && !s_initialized && !s_worker && !s_host);
            assert(!s_stop_failed && !seal_live && seal_releases == 1);
            assert(host_stops == 1 && host_deinits == 1 && worker_deletes == 2);
            assert(s_next_window == next_window_seq);
        }
        assert_released();
    }
}
static void test_post_init_rejection_retains_failed_cleanup(void) {
    for (unsigned failure = 0; failure < 3; ++failure) {
        reset();
        s_accept = false;
        apply_startup_test = capture_queue_enabled = collector_start_succeeds = true;
        startup_heap = 14064;
        startup_largest = 7680;
        stop_join_times_out = failure == 0;
        host_stop_fails = failure == 1;
        host_deinit_fails = failure == 2;
        cp_address_core_t *bank = s_sealed.addresses;
        assert(apply_with_gate(&s_policy) == (failure == 0 ? ESP_ERR_TIMEOUT : ESP_FAIL));
        assert_unaccepted_startup();
        assert(s_stop_failed && s_initialized && seal_live == 1 && !seal_releases);
        assert(s_sealed.addresses == bank);
        assert((s_worker != NULL) == (failure == 0));
        assert((s_host != NULL) == (failure != 2));
        assert(host_stops == (failure ? 1u : 0u));
        assert(host_deinits == (failure == 2 ? 1u : 0u));
        assert(cp_pipeline_stop() == ESP_ERR_INVALID_STATE);
        assert(s_sealed.addresses == bank && !seal_releases);
    }
    assert_released();
}
static void test_startup_preserves_preexisting_pending_bank(void) {
    reset();
    observe(1);
    close_window(30000);
    assert(s_sealed.pending && !s_initialized);
    s_accept = false;
    cp_address_core_t *bank = s_sealed.addresses;
    cp_address_core_t retained = bank[0];
    uint32_t *bins = s_sealed.bins;
    uint32_t first_bin = bins[0];
    memory_owned = true;
    assert(cp_pipeline_apply(&s_policy) == ESP_ERR_NO_MEM);
    memory_owned = false;
    assert(s_sealed.pending && s_sealed.addresses == bank && s_sealed.bins == bins);
    assert(!memcmp(bank, &retained, sizeof retained) && bins[0] == first_bin);
    assert(!s_accept && !s_initialized && !startup_host_creates && !startup_collector_creates);
    assert(!s_health.windows_dropped && !s_health.summary_drops && !seal_releases);
    assert(persist_pending(0));
    assert(s_health.windows_committed == 1 && s_health.summaries_committed == 1);
    assert_released();
}
static void test_seal_bank_oom_preserves_policy_and_can_retry(void) {
    reset();
    observe(1);
    close_window(30000);
    assert(next_window());
    assert(persist_pending(0));
    /* An odd seal has swapped the bindings; replacement OOM must leave the
     * retained static cores as well as the allocated bins untouched. */
    assert(s_window.addresses == s_collect_cores[1] &&
           s_sealed.addresses == s_collect_cores[0]);
    s_accept = false;
    cp_network_policy_t next = s_policy;
    next.max_addresses = 16;
    strcpy(next.core.config_id, "replacement-config");
    cp_address_core_t *old = s_sealed.addresses;
    cp_address_core_t *old_active = s_window.addresses;
    uint32_t *old_active_bins = s_window.bins, *old_sealed_bins = s_sealed.bins;
    uint32_t *old_owner = s_collect_storage;
    cp_address_core_t old_core = old[0];
    uint32_t old_bin = old_sealed_bins[0];
    seal_allocation_fails = true;
    assert(apply_with_gate(&next) == ESP_ERR_NO_MEM);
    assert(s_sealed.addresses == old && s_sealed.address_capacity == 4);
    assert(s_window.addresses == old_active && s_window.bins == old_active_bins &&
           s_sealed.bins == old_sealed_bins && s_collect_storage == old_owner);
    assert(!memcmp(&old[0], &old_core, sizeof old_core) && old_sealed_bins[0] == old_bin);
    assert(seal_live == 1 && !seal_releases && seal_allocations == 1);
    assert(!strcmp(s_policy.core.config_id, "synthetic-config") && !s_accept && !s_initialized);
    release_seal_bank();
    assert(apply_with_gate(&next) == ESP_ERR_NO_MEM);
    assert(!s_sealed.addresses && !seal_live && !s_initialized && !s_accept);
    assert(!strcmp(s_policy.core.config_id, "synthetic-config"));
    seal_allocation_fails = false;
    apply_startup_test = capture_queue_enabled = collector_start_succeeds = true;
    assert(apply_with_gate(&next) == ESP_OK);
    assert(s_initialized && s_accept && seal_live == 1);
    assert(s_sealed.address_capacity == 16 && seal_bytes == 768);
    assert(!strcmp(s_policy.core.config_id, "replacement-config"));
    assert(cp_pipeline_stop() == ESP_OK && !s_sealed.addresses && !seal_live);
    assert_released();
}
static void test_seal_bank_policy_resize_and_exact_boundaries(void) {
    reset();
    release_seal_bank();
    s_accept = false;
    apply_startup_test = capture_queue_enabled = collector_start_succeeds = true;
    const unsigned capacities[] = {16, 64, 128, 16};
    unsigned expected_committed = 0;
    for (unsigned k = 0; k < sizeof capacities / sizeof capacities[0]; ++k) {
        cp_network_policy_t next = s_policy;
        next.max_addresses = capacities[k];
        next.raw_enabled = false;
        assert(apply_with_gate(&next) == ESP_OK);
        assert(s_sealed.address_capacity == capacities[k] && seal_live == 1);
        assert(seal_bytes == 2 * capacities[k] * 6 * sizeof(uint32_t));
        assert(s_window.addresses == s_collect_cores[0] &&
               s_sealed.addresses == s_collect_cores[1]);
        assert(s_window.bins == s_collect_storage &&
               s_sealed.bins == s_collect_storage + capacities[k] * 6);
        for (unsigned i = 0; i <= capacities[k]; ++i) {
            cp_report_t report = {.mono_ms = s_window.start_ms + 1 + i, .report_seq = i + 1,
                .address = {2,0,0,0,0,(uint8_t)i}, .rssi = -50, .raw = CP_RAW_OFF};
            assert(cp_collect_compact_observe(&s_window, &report));
        }
        close_window(30000);
        assert(s_sealed.window.address_count == capacities[k]);
        assert(s_sealed.window.address_capacity == capacities[k]);
        assert(s_sealed.window.summary_drops == 1 && s_sealed.window.address_overflow);
        assert(s_sealed.window.cores != s_window.addresses);
        assert(s_sealed.window.raw == s_sealed.raw);
        /* The compact bank is a snapshot, not an alias of the next collector. */
        assert(next_window());
        assert(s_sealed.window.cores[capacities[k] - 1].address[5] == capacities[k] - 1);
        assert(cp_pipeline_stop() == ESP_OK && !seal_live && !s_sealed.addresses);
        assert(!persistence_pending() && !s_health.seal_overflows && !s_health.windows_dropped);
        /* Reconfiguration retains the already frozen old-policy bytes. Reset
         * only the synthetic Flash between trials so the next full window fits. */
        unsigned committed = s_health.summaries_committed;
        expected_committed += capacities[k];
        assert(committed == expected_committed);
        if (k + 1 < sizeof capacities / sizeof capacities[0]) {
            memset(flash_bytes, 0xff, sizeof flash_bytes);
            cp_flash_t flash = {NULL, sizeof flash_bytes, test_flash_read, test_flash_write,
                                test_flash_erase};
            assert(cp_journal_open(&s_journal, flash) == CP_JOURNAL_OK);
            cp_upload_scheduler_init(&s_upload_scheduler);
            memset(s_stream_pending, 0, sizeof s_stream_pending);
            update_store_health();
        }
    }
    assert_released();
}
static void test_seal_bank_stop_failures_keep_ownership(void) {
    for (unsigned failure = 0; failure < 3; ++failure) {
        reset();
        cp_address_core_t *bank = s_sealed.addresses;
        s_initialized = true;
        s_worker = failure == 0 ? &worker_task : NULL;
        stop_join_times_out = failure == 0;
        apply_startup_test = true;
        s_host = failure == 1 ? &host_task_handle : NULL;
        host_stop_fails = failure == 1;
        host_deinit_fails = failure == 2;
        assert(cp_pipeline_stop() != ESP_OK);
        assert(s_stop_failed && s_initialized && s_sealed.addresses == bank);
        assert(seal_live == 1 && !seal_releases);
        assert(cp_pipeline_stop() == ESP_ERR_INVALID_STATE && s_sealed.addresses == bank);
        memory_owned = true;
        assert(!reserve_seal_bank(16, 6) && !seal_allocations);
        memory_owned = false;
    }
    assert_released();
}
static void test_seal_bank_is_included_in_start_budget(void) {
    reset();
    release_seal_bank();
    s_accept = false;
    cp_network_policy_t next = s_policy;
    next.max_addresses = 64;
    internal_heap = CP_MEMORY_START_FREE + 1024;
    seal_reduces_heap = true;
    assert(apply_with_gate(&next) == ESP_ERR_NO_MEM);
    assert(seal_allocations == 1 && !seal_live && !s_sealed.addresses);
    assert(!s_initialized && !s_accept && s_memory.scan_paused);
    assert(!s_health.windows_dropped && !s_health.raw_drops);
    assert_released();
}
static void test_compact_policy_matrix_and_bank_swap(void) {
    const unsigned capacities[] = {16, 32, 64};
    const unsigned bin_counts[] = {1, 2, 6, 12, 16};
    for (unsigned ci = 0; ci < sizeof capacities / sizeof capacities[0]; ++ci)
        for (unsigned bi = 0; bi < sizeof bin_counts / sizeof bin_counts[0]; ++bi)
            for (unsigned raw = 0; raw < 2; ++raw) {
                reset();
                const unsigned capacity = capacities[ci], bins = bin_counts[bi];
                s_policy.max_addresses = capacity;
                s_policy.summary_window_ms = bins * 5000;
                s_policy.summary_bin_ms = 5000;
                s_policy.raw_enabled = raw;
                memory_owned = true;
                assert(reserve_seal_bank(capacity, bins));
                memory_owned = false;
                assert(seal_bytes == 2 * capacity * bins * sizeof(uint32_t));
                assert(sizeof s_collect_cores == 16384);
                assert(cp_collect_compact_begin(&s_window, 1000, bins * 5000, 5000,
                                                1, capacity, raw));
                cp_address_core_t *active = s_window.addresses;
                uint32_t *active_bins = s_window.bins;
                unsigned allocated = seal_allocations;
                for (unsigned b = 0; b < bins; ++b)
                    for (unsigned a = 0; a < capacity; ++a) {
                        cp_report_t report = {.mono_ms = 1000 + b * 5000 + a,
                            .report_seq = b * capacity + a + 1, .address = {2,0,0,0,0,(uint8_t)a},
                            .rssi = -50, .raw = raw ? (b == 0 && a < CP_COLLECT_RAW ?
                                CP_RAW_SELECTED : CP_RAW_INTENTIONAL) : CP_RAW_OFF};
                        assert(cp_collect_compact_observe(&s_window, &report));
                    }
                close_window(bins * 5000);
                assert(s_sealed.window.cores == active && s_sealed.window.bins == active_bins);
                assert(s_window.addresses != active && s_window.bins != active_bins);
                assert(s_sealed.window.address_count == capacity &&
                    s_sealed.window.reports_seen == capacity * bins &&
                    s_sealed.window.bin_count == bins);
                assert(next_window());
                for (unsigned a = 0; a < capacity; ++a) {
                    assert(s_sealed.window.cores[a].reports == bins);
                    for (unsigned b = 0; b < bins; ++b)
                        assert(s_sealed.window.bins[a * bins + b] == 1);
                }
                assert(seal_allocations == allocated); /* Observe/seal/reset never allocates. */
                assert(persist_pending(0));
                assert(s_health.windows_committed == 1 && s_health.summaries_committed == capacity);
                assert(!s_health.windows_dropped && !s_health.raw_drops && !s_health.summary_drops);
                assert(!s_health.seal_overflows && !s_health.callback_queue_drops);
                if (!raw && (bins == 2 || bins == 6 || bins == 12)) {
                    char prefix[64];
                    snprintf(prefix, sizeof prefix, "refresh-n%u-w%u-b5000", capacity, bins * 5000);
                    write_fixtures(prefix);
                }
                /* Same-size reuse must preserve swapped bindings and never
                 * allocate or alias the just-persisted bank to the next one. */
                memory_owned = true;
                assert(reserve_seal_bank(capacity, bins));
                memory_owned = false;
                assert(seal_allocations == allocated && s_sealed.addresses == active &&
                       s_sealed.bins == active_bins && s_window.addresses != active);
                assert_released();
            }
}
static void test_128_address_trial_policies(void) {
    const unsigned windows[] = {60000, 120000};
    for (unsigned trial = 0; trial < sizeof windows / sizeof windows[0]; ++trial) {
        reset();
        const unsigned window = windows[trial], bin_ms = window / 3;
        s_policy.max_addresses = 128;
        s_policy.summary_window_ms = window;
        s_policy.summary_bin_ms = bin_ms;
        s_policy.max_body_bytes = 4096;
        s_policy.raw_enabled = false;
        memory_owned = true;
        assert(reserve_seal_bank(128, 3));
        memory_owned = false;
        assert(sizeof s_collect_cores == 16384 && seal_bytes == 3072);
        assert(cp_collect_compact_begin(&s_window, 1000, window, bin_ms, 1, 128, false));
        unsigned allocated = seal_allocations;
        for (unsigned b = 0; b < 3; ++b)
            for (unsigned a = 0; a < 128; ++a) {
                cp_report_t report = {.mono_ms = 1001 + b * bin_ms + a,
                    .report_seq = b * 128 + a + 1, .address = {2,0,0,0,0,(uint8_t)a},
                    .rssi = -50, .raw = CP_RAW_OFF};
                assert(cp_collect_compact_observe(&s_window, &report));
            }
        close_window(window);
        assert(next_window());
        assert(s_sealed.window.address_count == 128 && s_sealed.window.reports_seen == 384);
        assert(s_sealed.window.cores[127].reports == 3 && s_sealed.window.bins[383] == 1);
        assert(s_sealed.window.cores != s_window.addresses && s_sealed.window.bins != s_window.bins);
        assert(seal_allocations == allocated);
        assert(persist_pending(0));
        assert(s_health.windows_committed == 1 && s_health.summaries_committed == 128);
        assert(!s_health.windows_dropped && !s_health.raw_drops && !s_health.summary_drops &&
            !s_health.seal_overflows && !s_health.callback_queue_drops);
        unsigned batches = 0;
        for (unsigned slot = 0; slot < s_journal.count; ++slot)
            if (s_journal.slots[slot].state == CP_SLOT_PENDING) {
                ++batches;
                assert(s_journal.slots[slot].length <= 4096);
            }
        char prefix[64];
        snprintf(prefix, sizeof prefix, "refresh-n128-w%u-b%u", window, bin_ms);
        write_fixtures(prefix);
        printf("128-address trial: %u ms / %u ms bins, 4096B bodies, %u persisted batches\n",
            window, bin_ms, batches);
        assert_released();
    }
}
static void test_full_journal_start_waits_for_resume_before_radio(void) {
    reset();
    s_accept=false;
    s_journal.count=100; /* Admission-only model: no Flash IO is reached. */
    s_policy.critical_pct=95;
    s_policy.raw_pause_pct=85;
    s_policy.resume_pct=70;
    s_policy.overload_pause_scan=true;
    s_free_slots=0;
    assert(cp_pipeline_apply(&s_policy)==ESP_ERR_NO_MEM);
    assert(s_pressure_paused && !s_accept && !s_initialized);
    s_free_slots=9; /* Reserve cleared, but an immediate pressure stop remains. */
    assert(cp_pipeline_apply(&s_policy)==ESP_ERR_NO_MEM);
    s_free_slots=29;
    assert(cp_pipeline_apply(&s_policy)==ESP_ERR_NO_MEM);
    s_memory.init_fault=true;
    s_free_slots=30; /* Exact resume boundary passes the storage admission. */
    assert(cp_pipeline_apply(&s_policy)==ESP_ERR_INVALID_STATE);
    assert(!s_accept && !s_initialized && !captured_count);
    assert_released();
}
int main(int argc, char **argv) {
    assert(argc == 1 || argc == 2);
    fixture_directory = argc == 2 ? argv[1] : NULL;
    cJSON_Hooks hooks = {.malloc_fn = checked_malloc, .free_fn = checked_free};
    cJSON_InitHooks(&hooks);
    printf("Pipeline handoff RAM: sealed=%zu raw=%zu flags=%zu window=%zu report=%zu\n",
        sizeof s_sealed, sizeof s_raw_handoff, sizeof s_persist_busy +
        sizeof s_active_window_seq + sizeof s_active_raw_failures + sizeof s_final_window_pending +
        sizeof s_final_duration + sizeof s_collector_stack_free + sizeof s_final_sealed_ms, sizeof s_window, sizeof(cp_report_t));
    printf("Compact bank pair payload: static_cores=%zu heap16x6=%zu heap64x6=%zu heap64x16=%zu view=%zu\n",
        sizeof s_collect_cores, 2 * 16 * 6 * sizeof(uint32_t),
        2 * 64 * 6 * sizeof(uint32_t), 2 * 64 * 16 * sizeof(uint32_t), sizeof(cp_codec_window_view_t));
    test_compact_policy_matrix_and_bank_swap();
    test_128_address_trial_policies();
    test_full_journal_start_waits_for_resume_before_radio();
    test_seal_bank_oom_preserves_policy_and_can_retry();
    test_seal_bank_policy_resize_and_exact_boundaries();
    test_seal_bank_stop_failures_keep_ownership();
    test_seal_bank_is_included_in_start_budget();
    test_collector_startup_oom_never_opens_ingress();
    test_post_init_memory_admission();
    test_post_init_rejection_retains_failed_cleanup();
    test_startup_preserves_preexisting_pending_bank();
    test_handoff_frozen_retry_and_verified_ack_reclaim();
    test_stop_retains_final_behind_busy_seal();
    test_raw_on_tls_blocked_worker_preserves_sample_policy();
    test_raw_failure_precedes_frozen_same_window();
    test_seal_after_body_read_is_persisted_before_tls();
    test_tls_blocked_collector_keeps_draining();
    test_tls_spans_multiple_windows_and_overflow_is_exact();
    test_persistence_preemption_preserves_new_active_window();
    test_ordered_raw_failures_at_every_handoff_state();
    test_stop_retains_retryable_seal_and_old_policy();
    test_sealed_lease_boundary_and_callback_overflow();
    test_window_and_status_share_claim();
    test_timeout_losses_and_status_retry();
    test_raw_deferral_keeps_bounded_accounting();
    test_invalid_ingress_loss_preserves_raw_and_releases();
    test_allocation_and_store_failures_release();
    test_metadata_failure_and_upload_preserve_frozen_bytes();
    test_rejected_slot_preserved_without_blocking_later_batches();
    test_backlog_waits_for_first_desired_response();
    test_exact_upload_allocation_and_failure_retention();
    test_apply_refusal_does_not_reenter_claim();
    test_stop_budget_and_failed_ownership();
    test_stop_boundary_and_inflight_ingress();
    test_sub_bin_partial_windows();
    test_full_vehicle_summary_window();
    test_final_drain_after_timeout();
    assert_released();
    release_seal_bank();
    assert(!seal_live);
    cJSON_InitHooks(NULL);
    puts("Pipeline memory serialization, allocation failures, durable retry and stop: PASS");
    return 0;
}
