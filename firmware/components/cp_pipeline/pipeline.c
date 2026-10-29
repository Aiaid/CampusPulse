#include "cp_codec.h"
#include "cp_collect.h"
#include "cp_journal.h"
#include "cp_memory_guard.h"
#include "cp_pipeline.h"
#include "cp_upload_scheduler.h"
#include "cp_frozen_json.h"
#include "domain_debug.h"
#include "cp_perf.h"
#include "esp_bt.h"
#include "esp_log.h"
#include "esp_heap_caps.h"
#include "esp_partition.h"
#include "esp_random.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "host/ble_gap.h"
#include "host/ble_hs.h"
#include "host/util/util.h"
#include "nimble/nimble_port.h"
#include "services/gap/ble_svc_gap.h"
#include "services/gatt/ble_svc_gatt.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define REPORT_QUEUE 64
#define LOSS_BUCKETS 8
#define READY_BIT 1u
#define FAILED_BIT 2u
/* Only uploader/body admission may wait for the shared allocation gate.
 * The collector publishes fixed RAM handoffs without waiting for this gate. */
#define MEMORY_WORK_WAIT_MS 15000u
#define COLLECTOR_STOP_WAIT_MS 25000u
/* The supervisor samples every 500 ms. A backlog must leave observable idle
 * time between TLS clients, and a paused radio needs the existing healthy-heap
 * interval to become restartable. These bounded gaps leave control requests
 * eligible and never change the frozen batch or relax memory/lease admission. */
#define UPLOAD_CONTROL_YIELD_MS 1000u
#define UPLOAD_RECOVERY_YIELD_MS (CP_MEMORY_HEALTHY_MS + UPLOAD_CONTROL_YIELD_MS)
static const char *TAG = "cp_pipeline";
static cp_journal_t s_journal;
static cp_collect_compact_t s_window;
/* Keep long-lived cores out of the runtime heap. With 64 addresses and six
 * bins, an 11 KiB combined allocation fragmented the C3 heap despite enough
 * total free memory for TLS. Static typed cores leave only policy-sized bins
 * to allocate (3 KiB at 64 x 6 or 128 x 3; 768 B at 16 x 6). The 128-address
 * ceiling reserves 16 KiB of static cores, including at smaller policy sizes.
 * Device validation, not these sizes alone, establishes whether the remaining
 * largest block and complete upload working set are sufficient. */
static cp_address_core_t s_collect_cores[2][CP_COLLECT_ADDRESSES];
static uint32_t *s_collect_storage;
/* Single producer (collector), single persistence owner (uploader or stop).
 * Publication is release/acquire; no allocator, Flash or network wait on ingress.
 * A busy slot is immutable until the persistence owner releases it. */
static struct {
    cp_codec_window_view_t window;
    cp_report_t raw[CP_COLLECT_RAW];
    cp_address_core_t *addresses;
    uint32_t *bins;
    unsigned address_capacity, bin_count;
    uint64_t sealed_ms;
    uint32_t duration;
    bool valid, pending;
} s_sealed;
static struct {
    cp_report_t reports[CP_COLLECT_RAW];
    unsigned count;
    uint32_t window_seq;
    bool pending;
} s_raw_handoff;
static bool s_persist_busy, s_final_window_pending;
static uint32_t s_final_duration, s_collector_stack_free;
static uint64_t s_final_sealed_ms;
/* Protected by capture mux. Completion belongs to the active window until its
 * seal, then to the sealed window, or directly to health if that window dropped. */
static uint32_t s_active_window_seq, s_active_raw_failures;
static cp_network_policy_t s_policy;
static cp_pipeline_snapshot_t s_health;
static SemaphoreHandle_t s_store_lock, s_worker_done, s_host_done;
static EventGroupHandle_t s_radio_events;
static QueueHandle_t s_reports;
static TaskHandle_t s_worker, s_host, s_uploader;
static char s_node[16], s_boot[37];
static uint64_t s_origin, s_stop_at, s_lease_deadline, s_last_ingress_ms;
static uint32_t s_report_seq, s_summary_seq, s_status_seq, s_next_window = 1, s_first_window;
static uint32_t s_stream_pending[4], s_free_slots, s_loss_overruns, s_raw_queue_drops,
    s_raw_pressure_skips;
static uint32_t s_address_overflow_reports;
static uint32_t s_unpersisted_window_reports, s_status_dropped;
static uint64_t s_raw_paused_ms;
static bool s_pressure_paused, s_raw_paused;
static bool s_memory_paused, s_memory_raw_paused, s_policy_owned, s_stop_failed;
/* The guard is supervisor-owned; callbacks/workers only read atomic mirrors. */
static cp_memory_guard_t s_memory;
static uint64_t s_memory_policy_sequence, s_latest_policy_response, s_idle_status_at, s_idle_pause_tick;
static uint32_t s_resource_exhaustions_seen;
static cp_upload_scheduler_t s_upload_scheduler;
static uint8_t s_own_address;
static bool s_stop, s_accept, s_initialized, s_capture_started;
static portMUX_TYPE s_capture_mux = portMUX_INITIALIZER_UNLOCKED;
typedef struct {
    uint32_t window, selected, drops, selected_drops, intentional, pressure;
} loss_bucket_t;
static loss_bucket_t s_losses[LOSS_BUCKETS];
#ifndef CP_PIPELINE_UPLOAD_ALLOC
#define CP_PIPELINE_UPLOAD_ALLOC malloc
#define CP_PIPELINE_UPLOAD_FREE free
#endif
#ifndef CP_PIPELINE_SEAL_ALLOC
#define CP_PIPELINE_SEAL_ALLOC malloc
#define CP_PIPELINE_SEAL_FREE free
#endif
static uint64_t mono_ms(void) { return (uint64_t)esp_timer_get_time() / 1000; }
static void bump(uint32_t *p) { __atomic_add_fetch(p, 1u, __ATOMIC_RELAXED); }
static uint32_t load(const uint32_t *p) { return __atomic_load_n(p, __ATOMIC_RELAXED); }
static int stream_index(const char *stream) {
    const char *names[] = {"ble_windows", "address_summaries", "ble_reports", "node_status"};
    for (int i = 0; i < 4; i++)
        if (!strcmp(stream, names[i]))
            return i;
    return -1;
}
static bool flash_read(void *ctx, size_t o, void *out, size_t n) {
    return esp_partition_read(ctx, o, out, n) == ESP_OK;
}
static bool flash_write(void *ctx, size_t o, const void *in, size_t n) {
    return esp_partition_write(ctx, o, in, n) == ESP_OK;
}
static bool flash_erase(void *ctx, size_t o, size_t n) {
    return esp_partition_erase_range(ctx, o, n) == ESP_OK;
}
static void uuid(char out[37]) {
    uint8_t b[16];
    esp_fill_random(b, sizeof b);
    b[6] = (b[6] & 15) | 64;
    b[8] = (b[8] & 63) | 128;
    snprintf(out, 37, "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x", b[0],
             b[1], b[2], b[3], b[4], b[5], b[6], b[7], b[8], b[9], b[10], b[11], b[12], b[13],
             b[14], b[15]);
}
static void update_store_health(void) {
    __atomic_store_n(&s_free_slots, cp_journal_free_slots(&s_journal), __ATOMIC_RELAXED);
    __atomic_store_n(&s_health.pending, cp_journal_pending(&s_journal), __ATOMIC_RELAXED);
    __atomic_store_n(&s_health.quarantined_slots, s_journal.corrupt_slots, __ATOMIC_RELAXED);
}
static bool store_body(void *context, const char *body, size_t length, const char *stream,
                       unsigned count, bool control) {
    (void)context;
    (void)count;
    bool ok = false;
    if (xSemaphoreTake(s_store_lock, pdMS_TO_TICKS(5000)) == pdTRUE) {
        uint16_t slot;
        CP_PERF_START(append_started);
        ok = cp_journal_append(&s_journal, body, length, control, &slot) == CP_JOURNAL_OK;
        CP_PERF_END(CP_PERF_JOURNAL_APPEND, length, append_started);
        if (ok) {
            int i = stream_index(stream);
            (void)cp_upload_scheduler_bind(&s_upload_scheduler, slot, (unsigned)i);
            if (i >= 0)
                bump(&s_stream_pending[i]);
        }
        update_store_health();
        xSemaphoreGive(s_store_lock);
    }
    if (!ok)
        __atomic_add_fetch(&s_health.storage_drops, count, __ATOMIC_RELAXED);
    return ok;
}
static cp_codec_t codec_context(void) {
    cp_network_snapshot_t clock;
    cp_network_snapshot(&clock);
    cp_codec_t c = {.node_id = s_node,
                    .boot_id = s_boot,
                    .placement_id = s_policy.placement_id,
                    .config_id = s_policy.core.config_id,
                    .dataset = s_policy.dataset,
                    .firmware_version = CP_NETWORK_FIRMWARE,
                    .max_items = s_policy.max_items,
                    .max_body_bytes = s_policy.max_body_bytes,
                    .clock_known = clock.clock_trusted,
                    .clock_mono_ms = clock.clock_mono_ms,
                    .clock_utc_ms = clock.clock_utc_ms,
                    .clock_epoch = clock.clock_epoch,
                    .uncertainty_ms = clock.clock_uncertainty_ms,
                    .summary_sequence = &s_summary_seq,
                    .uuid = uuid,
                    .sink = store_body};
    return c;
}
/* Caller owns the network memory gate. Keep this separate from the idle
 * wrapper so closing a window never recursively acquires the HTTP mutex. */
static uint64_t raw_paused_ms(void) {
    portENTER_CRITICAL(&s_capture_mux);
    uint64_t value = s_raw_paused_ms;
    portEXIT_CRITICAL(&s_capture_mux);
    return value;
}
static void add_raw_paused_ms(uint64_t elapsed) {
    portENTER_CRITICAL(&s_capture_mux);
    s_raw_paused_ms += elapsed;
    portEXIT_CRITICAL(&s_capture_mux);
}
static bool persist_status_locked(void) {
    if (s_status_seq == UINT32_MAX)
        return false;
    cp_network_snapshot_t net;
    cp_network_snapshot(&net);
    cp_codec_t c = codec_context();
    cp_codec_status_t status = {.mono_ms = mono_ms(),
                                .collecting = __atomic_load_n(&s_accept, __ATOMIC_ACQUIRE),
                                .connected = net.network == CP_NETWORK_READY,
                                .raw_enabled = s_policy.raw_enabled,
                                .raw_paused = __atomic_load_n(&s_raw_paused, __ATOMIC_ACQUIRE),
                                .memory_paused = __atomic_load_n(&s_memory_paused, __ATOMIC_ACQUIRE),
                                .memory_raw_paused = __atomic_load_n(&s_memory_raw_paused, __ATOMIC_ACQUIRE),
                                .free_heap = esp_get_free_heap_size(),
                                .slots = s_journal.count,
                                .free_slots = load(&s_free_slots),
                                .aggregation_drops = load(&s_health.aggregation_drops),
                                .raw_queue_drops = load(&s_raw_queue_drops),
                                .storage_drops = load(&s_health.storage_drops),
                                .windows_dropped = load(&s_health.windows_dropped),
                                .upload_failures = load(&s_health.upload_failures),
                                .ack_failures = load(&s_health.ack_failures),
                                .raw_pressure_skips = load(&s_raw_pressure_skips),
                                .raw_paused_ms = raw_paused_ms(),
                                .address_summaries_dropped = load(&s_health.summary_drops),
                                .address_table_overflow_reports = load(&s_address_overflow_reports),
                                .accounting_overrun_reports = load(&s_loss_overruns),
                                .unpersisted_window_reports = load(&s_unpersisted_window_reports),
                                .status_samples_coalesced = load(&s_status_dropped),
                                .warn_pct = s_policy.warn_pct,
                                .raw_pause_pct = s_policy.raw_pause_pct,
                                .critical_pct = s_policy.critical_pct};
    if (xSemaphoreTake(s_store_lock, pdMS_TO_TICKS(100)) != pdTRUE) {
        bump(&s_status_dropped);
        return false;
    }
    status.free_slots = load(&s_free_slots);
    uint32_t classified = 0;
    for (unsigned i = 0; i < 4; i++)
        classified += status.queue_pending[i] = load(&s_stream_pending[i]);
    unsigned pending = load(&s_health.pending);
    status.unclassified_pending_slots = pending >= classified ? pending - classified : 0;
    xSemaphoreGive(s_store_lock);
    if (!cp_codec_status(&c, &status, ++s_status_seq)) {
        bump(&s_status_dropped);
        return false;
    }
    return true;
}
static bool persist_status(void) {
    if (!cp_network_begin_memory_work(0)) {
        bump(&s_status_dropped);
        return false;
    }
    bool ok = persist_status_locked();
    cp_network_end_memory_work();
    return ok;
}
static bool persistence_pending(void) {
    return __atomic_load_n(&s_sealed.pending, __ATOMIC_ACQUIRE) ||
        __atomic_load_n(&s_raw_handoff.pending, __ATOMIC_ACQUIRE) ||
        __atomic_load_n(&s_final_window_pending, __ATOMIC_ACQUIRE) ||
        __atomic_load_n(&s_persist_busy, __ATOMIC_ACQUIRE);
}
/* Supervisor only, with ingress stopped and all previous handoffs drained.
 * Allocation belongs to apply's existing HTTP/radio-transition memory claim;
 * never allocate, resize or release a bank from the collector or persister. */
static bool reserve_seal_bank(unsigned capacity, unsigned bin_count) {
    if (s_initialized || persistence_pending() || !cp_collect_bank_bytes(capacity, bin_count))
        return false;
    if (s_collect_storage && s_sealed.address_capacity == capacity &&
        s_sealed.bin_count == bin_count)
        return true;
    /* One bin allocation keeps replacement transactional: an OOM retains the
     * old bins and both core bindings, including banks swapped by a prior seal.
     * No clearing or rebinding occurs until the replacement has succeeded. */
    size_t bytes = 2 * capacity * bin_count * sizeof(uint32_t);
    uint32_t *storage = CP_PIPELINE_SEAL_ALLOC(bytes);
    if (!storage)
        return false;
    CP_PIPELINE_SEAL_FREE(s_collect_storage);
    s_collect_storage = storage;
    s_window.addresses = s_collect_cores[0];
    s_window.bins = storage;
    s_window.storage_capacity = capacity;
    s_window.bin_count = bin_count;
    s_sealed.addresses = s_collect_cores[1];
    s_sealed.bins = storage + capacity * bin_count;
    s_sealed.address_capacity = capacity;
    s_sealed.bin_count = bin_count;
    s_sealed.window.cores = NULL;
    s_sealed.window.bins = NULL;
    return true;
}
static void release_seal_bank(void) {
    CP_PIPELINE_SEAL_FREE(s_collect_storage);
    s_collect_storage = NULL;
    s_window.addresses = NULL;
    s_window.bins = NULL;
    s_window.storage_capacity = s_window.bin_count = 0;
    s_sealed.addresses = NULL;
    s_sealed.bins = NULL;
    s_sealed.address_capacity = s_sealed.bin_count = 0;
    s_sealed.window.cores = NULL;
    s_sealed.window.bins = NULL;
}
static void flush_raw_if_idle(void) {
    if (!s_window.raw_count || __atomic_load_n(&s_raw_handoff.pending, __ATOMIC_ACQUIRE))
        return;
    s_raw_handoff.count = s_window.raw_count;
    s_raw_handoff.window_seq = s_window.window_seq;
    memcpy(s_raw_handoff.reports, s_window.raw, s_window.raw_count * sizeof(cp_report_t));
    s_window.raw_count = 0;
    __atomic_store_n(&s_raw_handoff.pending, true, __ATOMIC_RELEASE);
}
static void account_window_health(const cp_codec_window_view_t *w) {
    __atomic_add_fetch(&s_health.aggregation_drops, w->aggregation_drops, __ATOMIC_RELAXED);
    __atomic_add_fetch(&s_address_overflow_reports, w->summary_drops, __ATOMIC_RELAXED);
    __atomic_add_fetch(&s_health.raw_drops, w->raw_drops, __ATOMIC_RELAXED);
    __atomic_add_fetch(&s_raw_pressure_skips, w->pressure, __ATOMIC_RELAXED);
}
static void drop_window_view(cp_codec_window_view_t *w) {
    bump(&s_health.windows_dropped);
    __atomic_add_fetch(&s_unpersisted_window_reports, w->reports_seen, __ATOMIC_RELAXED);
    __atomic_add_fetch(&s_health.summary_drops, w->address_count, __ATOMIC_RELAXED);
    w->raw_drops += w->raw_count;
    w->raw_count = 0;
    account_window_health(w);
}
static void drop_window(cp_collect_compact_t *w) {
    cp_codec_window_view_t view = cp_codec_window_from_compact(w);
    drop_window_view(&view);
    w->raw_count = view.raw_count;
    w->raw_drops = view.raw_drops;
}
static void close_window(uint32_t duration) {
    CP_PERF_START(window_started);
    loss_bucket_t lost = {0};
    portENTER_CRITICAL(&s_capture_mux);
    loss_bucket_t *b = &s_losses[s_window.window_seq % LOSS_BUCKETS];
    if (b->window == s_window.window_seq) {
        lost = *b;
        memset(b, 0, sizeof *b);
    }
    portEXIT_CRITICAL(&s_capture_mux);
    __atomic_add_fetch(&s_raw_queue_drops, lost.selected_drops, __ATOMIC_RELAXED);
    bool valid = cp_collect_compact_losses(&s_window, lost.drops, lost.selected_drops,
                                   lost.intentional, lost.pressure);
    if (!valid) {
        __atomic_add_fetch(&s_unpersisted_window_reports, lost.drops, __ATOMIC_RELAXED);
        __atomic_add_fetch(&s_health.aggregation_drops, lost.drops, __ATOMIC_RELAXED);
        __atomic_add_fetch(&s_health.raw_drops, lost.selected_drops, __ATOMIC_RELAXED);
        __atomic_add_fetch(&s_raw_pressure_skips, lost.pressure, __ATOMIC_RELAXED);
    }
    cp_domain_debug_refresh_compact(&s_window, mono_ms(), true, duration);
    /* Swap the typed core/bin banks in constant time under the ingress lock.
     * Only the four-report raw tail is copied; no allocator or full-bank copy
     * runs in the collector. Policy replacement waits for complete drain. */
    uint64_t sealed_ms = mono_ms();
    portENTER_CRITICAL(&s_capture_mux);
    s_window.raw_drops += s_active_raw_failures;
    s_active_raw_failures = 0;
    s_active_window_seq = 0;
    bool full = __atomic_load_n(&s_sealed.pending, __ATOMIC_ACQUIRE) ||
        !s_sealed.addresses || s_window.address_count > s_sealed.address_capacity ||
        s_window.bin_count != s_sealed.bin_count;
    if (!full) {
        s_sealed.window = cp_codec_window_from_compact(&s_window);
        cp_address_core_t *spare_addresses = s_sealed.addresses;
        uint32_t *spare_bins = s_sealed.bins;
        s_sealed.addresses = s_window.addresses;
        s_sealed.bins = s_window.bins;
        s_window.addresses = spare_addresses;
        s_window.bins = spare_bins;
        memcpy(s_sealed.raw, s_window.raw, s_window.raw_count * sizeof *s_sealed.raw);
        s_sealed.window.raw = s_sealed.raw;
        s_sealed.duration = duration;
        s_sealed.valid = valid;
        s_sealed.sealed_ms = sealed_ms;
        __atomic_store_n(&s_sealed.pending, true, __ATOMIC_RELEASE);
        __atomic_store_n(&s_health.sealed_highwater, 1u, __ATOMIC_RELAXED);
    }
    portEXIT_CRITICAL(&s_capture_mux);
    if (full) {
        bump(&s_health.seal_overflows);
        drop_window(&s_window);
        bump(&s_status_dropped);
    }
    CP_PERF_END(CP_PERF_WINDOW_CLOSE, 0, window_started);
}
/* Call only with the memory gate and persistence ownership. Process an older
 * sealed window before raw from a later window; raw from the same window must
 * complete first so its failures appear in that window's exact accounting. */
static void persist_raw_locked(void) {
    cp_codec_t c = codec_context();
    (void)cp_codec_flush_raw_reports(&c, s_raw_handoff.reports,
                                    s_raw_handoff.count, s_raw_handoff.window_seq);
    if (c.raw_dropped) {
        portENTER_CRITICAL(&s_capture_mux);
        if (__atomic_load_n(&s_sealed.pending, __ATOMIC_ACQUIRE) &&
            s_sealed.window.window_seq == s_raw_handoff.window_seq)
            s_sealed.window.raw_drops += c.raw_dropped;
        else if (s_active_window_seq == s_raw_handoff.window_seq)
            s_active_raw_failures += c.raw_dropped;
        else
            __atomic_add_fetch(&s_health.raw_drops, c.raw_dropped, __ATOMIC_RELAXED);
        portEXIT_CRITICAL(&s_capture_mux);
    }
    __atomic_store_n(&s_raw_handoff.pending, false, __ATOMIC_RELEASE);
}
static void persist_window_locked(void) {
    cp_codec_window_view_t *w = &s_sealed.window;
    uint64_t started = mono_ms();
    uint64_t wait = started >= s_sealed.sealed_ms ? started - s_sealed.sealed_ms : 0;
    if (wait > load(&s_health.seal_wait_max_ms))
        __atomic_store_n(&s_health.seal_wait_max_ms,
                         wait > UINT32_MAX ? UINT32_MAX : (uint32_t)wait, __ATOMIC_RELAXED);
    cp_codec_t c = codec_context();
    if (!s_sealed.valid) {
        (void)cp_codec_flush_raw_reports(&c, w->raw, w->raw_count, w->window_seq);
        w->raw_drops += c.raw_dropped;
        w->raw_count = 0;
        drop_window_view(w);
    } else {
        if (!cp_codec_encode_window_view(&c, w, s_sealed.duration))
            bump(&s_health.windows_dropped);
        w->raw_drops += c.raw_dropped;
        w->raw_count = 0;
        __atomic_add_fetch(&s_health.windows_committed, c.windows_committed, __ATOMIC_RELAXED);
        __atomic_add_fetch(&s_health.summaries_committed, c.summaries_committed, __ATOMIC_RELAXED);
        __atomic_add_fetch(&s_health.summary_drops, c.summaries_dropped, __ATOMIC_RELAXED);
        __atomic_add_fetch(&s_unpersisted_window_reports, c.unpersisted_window_reports,
                           __ATOMIC_RELAXED);
        account_window_health(w);
    }
    __atomic_store_n(&s_sealed.pending, false, __ATOMIC_RELEASE);
    (void)persist_status_locked();
    uint64_t elapsed = mono_ms() - started;
    if (elapsed > load(&s_health.persist_max_ms))
        __atomic_store_n(&s_health.persist_max_ms,
                         elapsed > UINT32_MAX ? UINT32_MAX : (uint32_t)elapsed, __ATOMIC_RELAXED);
    ESP_LOGI(TAG,"collector_quality callbacks_dropped=%lu observer_rejected=%lu queue_highwater=%lu reports_seen=%lu sealed_highwater=%lu seal_overflows=%lu seal_wait_max_ms=%lu persist_max_ms=%lu collector_stack_free=%lu",
        (unsigned long)load(&s_health.callback_queue_drops),
        (unsigned long)load(&s_health.collector_rejections),
        (unsigned long)load(&s_health.report_queue_highwater),
        (unsigned long)load(&s_health.reports_seen),
        (unsigned long)load(&s_health.sealed_highwater),
        (unsigned long)load(&s_health.seal_overflows),
        (unsigned long)load(&s_health.seal_wait_max_ms),
        (unsigned long)load(&s_health.persist_max_ms),
        (unsigned long)load(&s_collector_stack_free));
}
static bool persist_pending(uint32_t wait_ms) {
    bool expected = false;
    if (!__atomic_compare_exchange_n(&s_persist_busy, &expected, true, false,
                                    __ATOMIC_ACQ_REL, __ATOMIC_ACQUIRE))
        return false;
    if (!cp_network_begin_memory_work(wait_ms)) {
        __atomic_store_n(&s_persist_busy, false, __ATOMIC_RELEASE);
        return false; /* Retain immutable RAM handoffs for retry, no fake loss. */
    }
    for (unsigned jobs = 0; jobs < 2; ++jobs) {
        /* If shutdown retained its final window in the stopped collector's
         * original storage, publish it only after the older seal was drained. */
        if (!__atomic_load_n(&s_sealed.pending, __ATOMIC_ACQUIRE) &&
            __atomic_load_n(&s_final_window_pending, __ATOMIC_ACQUIRE)) {
            close_window(s_final_duration);
            s_sealed.sealed_ms = s_final_sealed_ms;
            __atomic_store_n(&s_final_window_pending, false, __ATOMIC_RELEASE);
        }
        /* Atomic pair: collector can publish raw and then its same-window seal
         * while preempting this task. Separate loads could incorrectly observe
         * old raw=false and new window=true, freezing incomplete loss counts. */
        portENTER_CRITICAL(&s_capture_mux);
        bool raw = __atomic_load_n(&s_raw_handoff.pending, __ATOMIC_ACQUIRE);
        bool window = __atomic_load_n(&s_sealed.pending, __ATOMIC_ACQUIRE);
        portEXIT_CRITICAL(&s_capture_mux);
        if (raw && (!window || s_raw_handoff.window_seq <= s_sealed.window.window_seq))
            persist_raw_locked();
        else if (window)
            persist_window_locked();
        else
            break;
    }
    cp_network_end_memory_work();
    __atomic_store_n(&s_persist_busy, false, __ATOMIC_RELEASE);
    return true;
}
static bool next_window(void) {
    if (s_window.window_seq == UINT32_MAX)
        return false;
    bool ok = cp_collect_compact_begin(&s_window, s_window.start_ms + s_policy.summary_window_ms,
                            s_policy.summary_window_ms, s_policy.summary_bin_ms,
                            s_window.window_seq + 1, s_policy.max_addresses, s_policy.raw_enabled);
    if (ok) {
        portENTER_CRITICAL(&s_capture_mux);
        s_active_window_seq = s_window.window_seq;
        portEXIT_CRITICAL(&s_capture_mux);
    }
    return ok;
}
static void request_stop_at(uint64_t at) {
    portENTER_CRITICAL(&s_capture_mux);
    /* Window ends are exclusive, while the callback clock has millisecond
     * resolution. Include reports already admitted in this same millisecond.
     * The lease gate rejects ingress at/after expiry before it is admitted. */
    if (s_last_ingress_ms >= at)
        at = s_last_ingress_ms + 1;
    if (!s_stop_at || at < s_stop_at)
        s_stop_at = at;
    __atomic_store_n(&s_accept, false, __ATOMIC_RELEASE);
    __atomic_store_n(&s_stop, true, __ATOMIC_RELEASE);
    portEXIT_CRITICAL(&s_capture_mux);
}
static void request_stop(void) { request_stop_at(mono_ms()); }
void cp_pipeline_renew_lease(uint64_t deadline) {
    portENTER_CRITICAL(&s_capture_mux);
    s_lease_deadline = deadline;
    portEXIT_CRITICAL(&s_capture_mux);
}
static uint64_t lease_deadline(void) {
    portENTER_CRITICAL(&s_capture_mux);
    uint64_t result = s_lease_deadline;
    portEXIT_CRITICAL(&s_capture_mux);
    return result;
}
static void consume_report(const cp_report_t *report) {
    while (report->mono_ms >= s_window.start_ms + s_window.window_ms) {
        close_window(s_window.window_ms);
        if (!next_window()) {
            request_stop();
            break;
        }
    }
    uint32_t seen_before = s_window.reports_seen;
    if (!cp_collect_compact_observe(&s_window, report)) {
        bump(&s_health.aggregation_drops);
        bump(&s_health.collector_rejections);
    }
    cp_domain_debug_observe_compact(&s_window, report, s_window.reports_seen != seen_before);
}
static void collector_worker(void *arg) {
    (void)arg;
    cp_report_t report;
    uint64_t previous_tick = mono_ms(), stack_sample_at = previous_tick;
    bool storage_raw_paused = false;
    for (;;) {
        bool got = xQueueReceive(s_reports, &report, pdMS_TO_TICKS(100)) == pdTRUE;
        /* Host sync starts scanning before final RAM admission. No report can
         * enter yet, and that unaccepted interval must not create empty windows
         * or a short final window when startup is rejected. */
        if (!__atomic_load_n(&s_capture_started, __ATOMIC_ACQUIRE)) {
            if (__atomic_load_n(&s_stop, __ATOMIC_ACQUIRE))
                break;
            continue;
        }
        if (got)
            consume_report(&report);
        uint64_t tick = mono_ms();
        if (tick - stack_sample_at >= 1000) {
            __atomic_store_n(&s_collector_stack_free,
                             (uint32_t)uxTaskGetStackHighWaterMark(NULL), __ATOMIC_RELAXED);
            stack_sample_at = tick;
        }
        cp_domain_debug_refresh_compact(&s_window, tick, false, s_window.window_ms);
        uint64_t expiry = lease_deadline();
        if (expiry && tick >= expiry && !__atomic_load_n(&s_stop, __ATOMIC_ACQUIRE))
            request_stop_at(expiry);
        unsigned used = (s_journal.count - load(&s_free_slots)) * 100 / s_journal.count;
        if (used >= s_policy.raw_pause_pct)
            storage_raw_paused = true;
        else if (used <= s_policy.resume_pct)
            storage_raw_paused = false;
        __atomic_store_n(&s_raw_paused, storage_raw_paused ||
            __atomic_load_n(&s_memory_raw_paused, __ATOMIC_ACQUIRE), __ATOMIC_RELEASE);
        if (s_policy.raw_enabled && __atomic_load_n(&s_raw_paused, __ATOMIC_ACQUIRE))
            add_raw_paused_ms(tick - previous_tick);
        previous_tick = tick;
        bool stop = __atomic_load_n(&s_stop, __ATOMIC_ACQUIRE);
        if (!stop && s_window.raw_count &&
            mono_ms() - s_window.raw[0].mono_ms >= s_policy.flush_max_age_ms) {
            flush_raw_if_idle();
        }
        if (!got) {
            uint64_t now = mono_ms();
            if (stop) {
                /* The timed receive may have returned empty just before the
                 * last callback queued and stop closed admission. Recheck only
                 * after observing stop; no callback can now enqueue behind us. */
                while (xQueueReceive(s_reports, &report, 0) == pdTRUE)
                    consume_report(&report);
                portENTER_CRITICAL(&s_capture_mux);
                uint64_t end = s_stop_at;
                portEXIT_CRITICAL(&s_capture_mux);
                while (end > s_window.start_ms + s_window.window_ms) {
                    close_window(s_window.window_ms);
                    if (!next_window())
                        break;
                }
                if (end >= s_window.start_ms && end - s_window.start_ms <= s_window.window_ms &&
                    (end > s_window.start_ms || s_window.reports_seen || s_window.raw_count)) {
                    uint32_t duration = (uint32_t)(end - s_window.start_ms);
                    if (__atomic_load_n(&s_sealed.pending, __ATOMIC_ACQUIRE)) {
                        /* Admission is closed and queue fully drained. Retain
                         * the final aggregate in place; no live producer needs
                         * this buffer and shutdown must not drop it for space. */
                        s_final_duration = duration;
                        s_final_sealed_ms = mono_ms();
                        __atomic_store_n(&s_final_window_pending, true, __ATOMIC_RELEASE);
                    } else {
                        close_window(duration);
                    }
                }
                break;
            }
            while (now >= s_window.start_ms + s_window.window_ms) {
                close_window(s_window.window_ms);
                if (!next_window()) {
                    request_stop();
                    break;
                }
            }
        }
        unsigned free = load(&s_free_slots);
        if (!stop && s_journal.count &&
            ((s_journal.count - free) * 100 / s_journal.count >= s_policy.critical_pct ||
             (s_policy.overload_pause_scan &&
              (s_journal.count - free) * 100 / s_journal.count >= s_policy.raw_pause_pct))) {
            __atomic_store_n(&s_pressure_paused, true, __ATOMIC_RELEASE);
            request_stop();
        }
    }
    __atomic_store_n(&s_collector_stack_free,
                     (uint32_t)uxTaskGetStackHighWaterMark(NULL), __ATOMIC_RELAXED);
    if (__atomic_load_n(&s_capture_started, __ATOMIC_ACQUIRE))
        s_next_window = s_window.window_seq == UINT32_MAX ? UINT32_MAX : s_window.window_seq + 1;
    xSemaphoreGive(s_worker_done);
    for (;;)
        vTaskSuspend(NULL);
}
static int discovery(struct ble_gap_event *event, void *arg) {
    (void)arg;
    if (event->type == BLE_GAP_EVENT_DISC_COMPLETE) {
        if (!__atomic_load_n(&s_stop, __ATOMIC_ACQUIRE))
            request_stop();
        return 0;
    }
    if (event->type != BLE_GAP_EVENT_DISC || !__atomic_load_n(&s_accept, __ATOMIC_ACQUIRE))
        return 0;
    const struct ble_gap_disc_desc *d = &event->disc;
    cp_report_t r = {.mono_ms = mono_ms(), .rssi = d->rssi, .report_type = d->event_type};
    uint64_t expiry = lease_deadline();
    if (expiry && r.mono_ms >= expiry) {
        request_stop_at(expiry);
        return 0;
    }
    for (unsigned i = 0; i < 6; i++)
        r.address[i] = d->addr.val[5 - i];
    r.address_type = d->addr.type <= 3 ? d->addr.type : 4;
    r.payload_length = d->length_data > 31 ? 31 : d->length_data;
    memcpy(r.payload, d->data, r.payload_length);
    uint64_t relative = r.mono_ms - s_origin;
    uint64_t index = relative / s_policy.summary_window_ms;
    if (index > UINT32_MAX - s_first_window) {
        request_stop();
        return 0;
    }
    uint32_t window = s_first_window + (uint32_t)index;
    portENTER_CRITICAL(&s_capture_mux);
    /* The optimistic check above can race with a supervisor stop. Admission,
     * its loss accounting and the nonblocking queue send share the stop lock,
     * so the collector cannot drain an empty queue before an in-flight callback
     * appends a report outside the sealed interval. */
    if (!__atomic_load_n(&s_accept, __ATOMIC_ACQUIRE)) {
        portEXIT_CRITICAL(&s_capture_mux);
        return 0;
    }
    if (s_report_seq == UINT32_MAX) {
        portEXIT_CRITICAL(&s_capture_mux);
        request_stop();
        return 0;
    }
    r.report_seq = ++s_report_seq;
    if (r.mono_ms > s_last_ingress_ms)
        s_last_ingress_ms = r.mono_ms;
    bump(&s_health.reports_seen);
    loss_bucket_t *b = &s_losses[window % LOSS_BUCKETS];
    if (b->window && b->window != window) {
        bump(&s_loss_overruns);
        bump(&s_health.aggregation_drops);
        portEXIT_CRITICAL(&s_capture_mux);
        /* Finite accounting storage is exhausted. Preserve previous buckets,
         * report the unattributable loss separately and stop new ingress. */
        request_stop_at(r.mono_ms);
        return 0;
    }
    if (!b->window)
        b->window = window;
    if (!s_policy.raw_enabled)
        r.raw = CP_RAW_OFF;
    else if (r.report_seq % s_policy.sample_every_n || b->selected >= s_policy.max_raw_per_window)
        r.raw = CP_RAW_INTENTIONAL;
    else if (__atomic_load_n(&s_raw_paused, __ATOMIC_ACQUIRE) ||
             __atomic_load_n(&s_memory_raw_paused, __ATOMIC_ACQUIRE))
        r.raw = CP_RAW_PRESSURE;
    else {
        r.raw = CP_RAW_SELECTED;
        b->selected++;
    }
    if (xQueueSend(s_reports, &r, 0) != pdTRUE) {
        bump(&s_health.callback_queue_drops);
        b->drops++;
        if (r.raw == CP_RAW_SELECTED)
            b->selected_drops++;
        else if (r.raw == CP_RAW_INTENTIONAL)
            b->intentional++;
        else if (r.raw == CP_RAW_PRESSURE)
            b->pressure++;
    } else {
        uint32_t depth=(uint32_t)uxQueueMessagesWaiting(s_reports);
        if(depth>load(&s_health.report_queue_highwater))
            __atomic_store_n(&s_health.report_queue_highwater,depth,__ATOMIC_RELAXED);
    }
    portEXIT_CRITICAL(&s_capture_mux);
    return 0;
}
static void radio_reset(int reason) {
    s_health.last_error = reason;
    request_stop();
    xEventGroupSetBits(s_radio_events, FAILED_BIT);
}
static void radio_sync(void) {
    int rc = ble_hs_util_ensure_addr(0);
    if (!rc)
        rc = ble_hs_id_infer_auto(0, &s_own_address);
    if (!rc) {
        s_origin = mono_ms();
        s_last_ingress_ms = 0;
        s_first_window = s_next_window;
        if (!cp_collect_compact_begin(&s_window, s_origin, s_policy.summary_window_ms,
                              s_policy.summary_bin_ms, s_first_window, s_policy.max_addresses,
                              s_policy.raw_enabled))
            rc = BLE_HS_EINVAL;
    }
    if (!rc) {
        struct ble_gap_disc_params p = {0};
        p.passive = !s_policy.scan_active;
        p.itvl = (uint16_t)(s_policy.scan_interval_ms * 1600 / 1000);
        p.window = (uint16_t)(s_policy.scan_window_ms * 1600 / 1000);
        p.filter_duplicates = s_policy.filter_duplicates;
        rc = ble_gap_disc(s_own_address, BLE_HS_FOREVER, &p, discovery, NULL);
    }
    if (rc) {
        s_health.last_error = rc;
        xEventGroupSetBits(s_radio_events, FAILED_BIT);
    } else {
        /* Host ready is not collector ready. Keep admission closed until the
         * consumer task exists, including the task-allocation failure path. */
        xEventGroupSetBits(s_radio_events, READY_BIT);
    }
}
static void host_task(void *arg) {
    (void)arg;
    nimble_port_run();
    xSemaphoreGive(s_host_done);
    for (;;)
        vTaskSuspend(NULL);
}
static bool batch_metadata(const char *body, size_t length, cp_network_batch_t *out) {
    return cp_frozen_metadata(body,length,out) && stream_index(out->stream)>=0;
}
/* Call only under s_store_lock: local read failures never discard a valid
 * frozen body. Only definitive corrupt/invalid slots become blocked. */
static void upload_read_failed(uint16_t slot, cp_journal_result_t error) {
    if (error == CP_JOURNAL_CORRUPT || error == CP_JOURNAL_INVALID) {
        unsigned stream = s_upload_scheduler.stream[slot];
        if (s_journal.slots[slot].state != CP_SLOT_PENDING && stream < CP_UPLOAD_STREAM_COUNT &&
            load(&s_stream_pending[stream]))
            __atomic_sub_fetch(&s_stream_pending[stream], 1u, __ATOMIC_RELAXED);
        cp_upload_scheduler_block(&s_upload_scheduler, slot);
        bump(&s_health.rejected_batches);
    } else {
        cp_upload_scheduler_retry(&s_upload_scheduler, slot, mono_ms(), esp_random());
        bump(&s_health.upload_failures);
    }
    s_health.last_error = ESP_FAIL;
}
/* Allocate the exact immutable slot length under the memory gate, before the
 * store lock. An admitted idle client may survive; the actual post-malloc heap
 * check closes it before Flash IO if the active-attempt floor is not met. */
static unsigned char *read_upload_body(uint16_t slot, size_t *length) {
    unsigned char *body = NULL;
    *length = 0;
    size_t reserve=CP_JOURNAL_MAX_BODY+1;
    /* Length is advisory until the protected recheck below; the single uploader
     * owns this pending slot and only producers append other slots. */
    if(slot<s_journal.count && s_journal.slots[slot].length<=CP_JOURNAL_MAX_BODY)
        reserve=(size_t)s_journal.slots[slot].length+1;
    if (!cp_network_begin_upload_memory_work(MEMORY_WORK_WAIT_MS,reserve)) {
        bump(&s_health.upload_failures);
        return NULL;
    }
    if(reserve>=2&&reserve<=CP_JOURNAL_MAX_BODY+1)
        body=CP_PIPELINE_UPLOAD_ALLOC(reserve);
    bool ready=cp_network_upload_memory_ready(body!=NULL);
    if (xSemaphoreTake(s_store_lock, pdMS_TO_TICKS(5000)) == pdTRUE) {
        size_t capacity=slot<s_journal.count?s_journal.slots[slot].length:0;
        if (body&&ready&&capacity+1==reserve) {
            CP_PERF_START(read_started);
            cp_journal_result_t read = cp_journal_read(&s_journal, slot, body, capacity, length);
            CP_PERF_END(CP_PERF_JOURNAL_READ, read == CP_JOURNAL_OK ? *length : 0, read_started);
            if (read == CP_JOURNAL_OK)
                body[*length] = 0;
            else {
                CP_PIPELINE_UPLOAD_FREE(body);
                body = NULL;
                upload_read_failed(slot, read);
                update_store_health();
            }
        } else {
            CP_PIPELINE_UPLOAD_FREE(body);body=NULL;
            cp_upload_scheduler_retry(&s_upload_scheduler, slot, mono_ms(), esp_random());
            bump(&s_health.upload_failures);
        }
        xSemaphoreGive(s_store_lock);
    } else {
        CP_PIPELINE_UPLOAD_FREE(body);body=NULL;
        bump(&s_health.upload_failures);
    }
    if(!body)(void)cp_network_upload_memory_ready(false);
    cp_network_end_memory_work();
    return body;
}
/* The network idle floor is meaningful only after the caller's body is gone. */
static void release_upload_body(unsigned char *body) {
    CP_PIPELINE_UPLOAD_FREE(body);
    cp_network_finalize_upload_body();
}
static void uploader_task(void *arg) {
    (void)arg;
    for (;;) {
        if (persistence_pending()) {
            if (!persist_pending(0)) {
                vTaskDelay(pdMS_TO_TICKS(100));
                continue;
            }
            if (persistence_pending())
                continue;
        }
        cp_network_snapshot_t net;
        cp_network_snapshot(&net);
        /* First desired response precedes replay of an old journal. Contact
         * authentication alone must not let backlog postpone radio policy. */
        if (net.network != CP_NETWORK_READY || net.auth != CP_AUTH_VALID ||
            !net.policy_response_sequence) {
            vTaskDelay(pdMS_TO_TICKS(1000));
            continue;
        }
        uint16_t selected = CP_UPLOAD_NO_SLOT;
        size_t length = 0;
        if (xSemaphoreTake(s_store_lock, pdMS_TO_TICKS(100)) == pdTRUE) {
            selected = cp_upload_scheduler_select(&s_upload_scheduler, s_journal.slots,
                                                  s_journal.count, mono_ms());
            xSemaphoreGive(s_store_lock);
        }
        if (selected == CP_UPLOAD_NO_SLOT) {
            vTaskDelay(pdMS_TO_TICKS(1000));
            continue;
        }
        unsigned char *upload_body = read_upload_body(selected, &length);
        if (!upload_body) {
            vTaskDelay(pdMS_TO_TICKS(1000));
            continue;
        }
        cp_network_batch_t meta;
        cp_network_ack_t ack;
        if (!batch_metadata((const char *)upload_body, length, &meta)) {
            /* Unsupported or invalid metadata remains frozen and retryable;
             * parsing never turns a journal record into a local success. */
            if (xSemaphoreTake(s_store_lock, pdMS_TO_TICKS(5000)) == pdTRUE) {
                cp_upload_scheduler_retry(&s_upload_scheduler, selected, mono_ms(), esp_random());
                xSemaphoreGive(s_store_lock);
            }
            bump(&s_health.upload_failures);
            release_upload_body(upload_body);
            vTaskDelay(pdMS_TO_TICKS(1000));
            continue;
        }
        bool discovered = false;
        if (xSemaphoreTake(s_store_lock, pdMS_TO_TICKS(5000)) != pdTRUE) {
            release_upload_body(upload_body);
            vTaskDelay(pdMS_TO_TICKS(1000));
            continue;
        }
        unsigned stream = (unsigned)stream_index(meta.stream);
        unsigned old_stream = s_upload_scheduler.stream[selected];
        if (old_stream != stream) {
            if (old_stream < CP_UPLOAD_STREAM_COUNT && load(&s_stream_pending[old_stream]))
                __atomic_sub_fetch(&s_stream_pending[old_stream], 1u, __ATOMIC_RELAXED);
            if (cp_upload_scheduler_bind(&s_upload_scheduler, selected, stream))
                bump(&s_stream_pending[stream]);
            discovered = true;
        }
        xSemaphoreGive(s_store_lock);
        if (discovered) {
            /* Re-enter selection after binding: a discovered newer record must
             * not bypass its actual stream's older delayed head. */
            release_upload_body(upload_body);
            vTaskDelay(pdMS_TO_TICKS(10));
            continue;
        }
        /* Reading/admitting a body may have waited behind another request.
         * Give a seal that arrived meanwhile its persistence turn before
         * starting another potentially 12-second network operation. */
        if (persistence_pending()) {
            release_upload_body(upload_body);
            continue;
        }
        cp_net_upload_result_t result =
            cp_network_upload_frozen(upload_body, length, &meta, &ack);
        release_upload_body(upload_body);
        /* Numeric, content-free proof of exact receipt validation by stream.
         * Stream order: windows, address summaries, raw reports, status. */
        ESP_LOGI(TAG,"upload_stream=%u upload_result=%u batch_items=%lu confirmed_items=%lu upload_body_bytes=%lu current_boot=%u http=%d",
            stream+1u,(unsigned)result,(unsigned long)meta.accepted_count,
            (unsigned long)(result==CP_NET_UPLOAD_ACKED?meta.accepted_count:0),(unsigned long)length,
            (unsigned)!strcmp(meta.boot_id,s_boot),ack.http_status);
        if (xSemaphoreTake(s_store_lock, pdMS_TO_TICKS(5000)) != pdTRUE) {
            bump(&s_health.ack_failures);
            vTaskDelay(pdMS_TO_TICKS(1000));
            continue;
        }
        if (result == CP_NET_UPLOAD_ACKED) {
            CP_PERF_START(ack_started);
            cp_journal_result_t acked = cp_journal_ack(&s_journal, selected);
            CP_PERF_END(CP_PERF_JOURNAL_ACK, 0, ack_started);
            if (acked == CP_JOURNAL_OK) {
                if (load(&s_stream_pending[stream]))
                    __atomic_sub_fetch(&s_stream_pending[stream], 1u, __ATOMIC_RELAXED);
                cp_upload_scheduler_confirmed(&s_upload_scheduler, selected);
            } else {
                bump(&s_health.ack_failures);
                cp_upload_scheduler_retry(&s_upload_scheduler, selected, mono_ms(), esp_random());
            }
            update_store_health();
        } else if (result == CP_NET_UPLOAD_REJECTED || result == CP_NET_UPLOAD_POLICY) {
            cp_upload_scheduler_block(&s_upload_scheduler, selected);
            bump(&s_health.rejected_batches);
        } else {
            if (result == CP_NET_UPLOAD_BAD_ACK)
                bump(&s_health.ack_failures);
            else
                bump(&s_health.upload_failures);
            cp_upload_scheduler_retry(&s_upload_scheduler, selected, mono_ms(), esp_random());
        }
        xSemaphoreGive(s_store_lock);
        vTaskDelay(pdMS_TO_TICKS(__atomic_load_n(&s_memory_paused, __ATOMIC_ACQUIRE)
            ? UPLOAD_RECOVERY_YIELD_MS : UPLOAD_CONTROL_YIELD_MS));
    }
}
static void cleanup_storage_startup(void) {
    if (s_radio_events)
        vEventGroupDelete(s_radio_events);
    if (s_host_done)
        vSemaphoreDelete(s_host_done);
    if (s_worker_done)
        vSemaphoreDelete(s_worker_done);
    if (s_reports)
        vQueueDelete(s_reports);
    if (s_store_lock)
        vSemaphoreDelete(s_store_lock);
    s_radio_events = NULL;
    s_host_done = NULL;
    s_worker_done = NULL;
    s_reports = NULL;
    s_store_lock = NULL;
    s_health.storage_ready = false;
    s_health.last_error = ESP_ERR_NO_MEM;
}
esp_err_t cp_pipeline_init(const char *node, const char *boot) {
    if (s_uploader)
        return ESP_OK;
    if (!node || strlen(node) >= sizeof s_node || !boot || strlen(boot) >= sizeof s_boot)
        return ESP_ERR_INVALID_ARG;
    strcpy(s_node, node);
    strcpy(s_boot, boot);
    const esp_partition_t *p = esp_partition_find_first(ESP_PARTITION_TYPE_DATA, 0x40, "cpqueue");
    if (!p)
        p = esp_partition_find_first(ESP_PARTITION_TYPE_DATA, 0x40, "blelog");
    if (!p || p->address != 0x360000 || p->size != 0x400000) {
        s_health.last_error = ESP_ERR_NOT_FOUND;
        return ESP_ERR_NOT_FOUND;
    }
    cp_flash_t flash = {(void *)p, p->size, flash_read, flash_write, flash_erase};
    if (cp_journal_open(&s_journal, flash) != CP_JOURNAL_OK) {
        s_health.last_error = ESP_FAIL;
        return ESP_FAIL;
    }
    s_health.storage_ready = false;
    cp_upload_scheduler_init(&s_upload_scheduler);
    memset(s_stream_pending, 0, sizeof(s_stream_pending));
    s_store_lock = xSemaphoreCreateMutex();
    s_reports = xQueueCreate(REPORT_QUEUE, sizeof(cp_report_t));
    s_worker_done = xSemaphoreCreateBinary();
    s_host_done = xSemaphoreCreateBinary();
    s_radio_events = xEventGroupCreate();
    if (!s_store_lock || !s_reports || !s_worker_done || !s_host_done || !s_radio_events) {
        cleanup_storage_startup();
        return ESP_ERR_NO_MEM;
    }
    update_store_health();
    for (unsigned i = 0; i < s_journal.count; i++)
        if (s_journal.slots[i].state == CP_SLOT_PENDING) {
            size_t n;
            unsigned char *upload_body = read_upload_body((uint16_t)i, &n);
            if (upload_body) {
                cp_network_batch_t meta;
                if (batch_metadata((const char *)upload_body, n, &meta)) {
                    unsigned index = (unsigned)stream_index(meta.stream);
                    if (cp_upload_scheduler_bind(&s_upload_scheduler, (uint16_t)i, index))
                        bump(&s_stream_pending[index]);
                } else {
                    /* Unknown metadata stays discoverable after transient OOM. */
                    cp_upload_scheduler_retry(&s_upload_scheduler, (uint16_t)i, mono_ms(),
                                              esp_random());
                    bump(&s_health.upload_failures);
                }
                release_upload_body(upload_body);
            }
        }
    update_store_health();
    if (xTaskCreate(uploader_task, "cp_upload", 6144, NULL, 3, &s_uploader) != pdPASS) {
        s_uploader = NULL;
        cleanup_storage_startup();
        return ESP_ERR_NO_MEM;
    }
    s_health.storage_ready = true;
    s_health.last_error = ESP_OK;
    ESP_LOGI(TAG, "Journal ready: pending=%lu quarantined=%lu",
             (unsigned long)load(&s_health.pending), (unsigned long)s_journal.corrupt_slots);
    return ESP_OK;
}
esp_err_t cp_pipeline_stop(void) {
    /* A failed stop leaves ownership uncertain. Re-entering SDK teardown from
     * the 500 ms supervisor loop is unsafe; retain diagnostics until reboot. */
    if (s_stop_failed)
        return ESP_ERR_INVALID_STATE;
    if (!s_initialized)
        return ESP_OK;
    request_stop();
    (void)ble_gap_disc_cancel();
    if (s_worker) {
        if (xSemaphoreTake(s_worker_done, pdMS_TO_TICKS(COLLECTOR_STOP_WAIT_MS)) != pdTRUE) {
            s_stop_failed = true;
            return ESP_ERR_TIMEOUT;
        }
        vTaskDelete(s_worker);
        s_worker = NULL;
    }
    /* Runtime calls stop before claiming the radio-transition memory gate.
     * Once the collector is joined, no producer can add work behind this drain.
     * A timeout retains ownership/data and is retryable; it is not a lost window
     * or uncertain SDK teardown, and apply cannot replace the old policy. */
    uint64_t drain_started = mono_ms();
    while (persistence_pending()) {
        if (mono_ms() - drain_started >= COLLECTOR_STOP_WAIT_MS)
            return ESP_ERR_TIMEOUT;
        if (!persist_pending(0))
            vTaskDelay(pdMS_TO_TICKS(10));
    }
    if (s_host) {
        if (nimble_port_stop() != 0) {
            s_stop_failed = true;
            return ESP_FAIL;
        }
        if (xSemaphoreTake(s_host_done, pdMS_TO_TICKS(5000)) != pdTRUE) {
            s_stop_failed = true;
            return ESP_ERR_TIMEOUT;
        }
        vTaskDelete(s_host);
        s_host = NULL;
    }
    esp_err_t err = nimble_port_deinit();
    if (err == ESP_OK) {
        s_initialized = false;
        s_idle_pause_tick = mono_ms();
        release_seal_bank();
    }
    s_stop_failed = err != ESP_OK;
    return err;
}
static void publish_memory_guard(void) {
    __atomic_store_n(&s_memory_paused, s_memory.scan_paused, __ATOMIC_RELEASE);
    __atomic_store_n(&s_memory_raw_paused, s_memory.raw_paused, __ATOMIC_RELEASE);
}
esp_err_t cp_pipeline_maintain(void) {
    if (!s_health.storage_ready)
        return ESP_OK;
    if (s_stop_failed)
        return ESP_ERR_INVALID_STATE;
    cp_network_snapshot_t net;
    cp_network_snapshot(&net);
    uint64_t now = mono_ms();
    s_latest_policy_response = net.policy_response_sequence;
    const uint32_t caps = MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT;
    bool collecting = __atomic_load_n(&s_accept, __ATOMIC_ACQUIRE);
    bool was_paused = s_memory.scan_paused;
    cp_memory_guard_observe(&s_memory, now, heap_caps_get_free_size(caps),
                            heap_caps_get_largest_free_block(caps), net.http_in_flight,
                            collecting);
    /* Consume failures only after the client has released TLS allocations. A
     * historical diagnostic must not stop a later successfully resumed scan. */
    if (!net.http_in_flight && net.resource_exhaustions != s_resource_exhaustions_seen) {
        s_resource_exhaustions_seen = net.resource_exhaustions;
        if (collecting)
            cp_memory_guard_pause(&s_memory, now);
    }
    if (!was_paused && s_memory.scan_paused) {
        s_memory_policy_sequence = net.policy_response_sequence;
        ESP_LOGW(TAG, "Collection paused for memory: internal_free=%u internal_largest=%u",
                 (unsigned)heap_caps_get_free_size(caps),
                 (unsigned)heap_caps_get_largest_free_block(caps));
    }
    publish_memory_guard();
    bool stopped = false;
    if (s_initialized && (s_memory.scan_paused || __atomic_load_n(&s_stop, __ATOMIC_ACQUIRE))) {
        esp_err_t err = cp_pipeline_stop();
        if (err != ESP_OK) {
            s_health.last_error = err;
            return err;
        }
        stopped = true;
        now = mono_ms();
    }
    if (!s_initialized && s_policy_owned) {
        if (s_idle_pause_tick && now >= s_idle_pause_tick && s_policy.raw_enabled &&
            (s_memory.scan_paused || __atomic_load_n(&s_pressure_paused, __ATOMIC_ACQUIRE)))
            add_raw_paused_ms(now - s_idle_pause_tick);
        s_idle_pause_tick = now;
        if (!net.http_in_flight && (stopped || !s_idle_status_at ||
                                    now - s_idle_status_at >= 30000)) {
            if (persist_status())
                s_idle_status_at = now;
        }
    }
    return ESP_OK;
}
static esp_err_t apply_failed(unsigned phase, esp_err_t error) {
    s_health.last_error = error;
    ESP_LOGE(TAG, "phase=%u err=%d controller=%u internal_free=%u internal_largest=%u free_slots=%u",
             phase, (int)error, (unsigned)esp_bt_controller_get_status(),
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT),
             (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT),
             (unsigned)load(&s_free_slots));
    return error;
}
esp_err_t cp_pipeline_apply(const cp_network_policy_t *p) {
    if (!s_health.storage_ready || !p || p->max_addresses > CP_COLLECT_ADDRESSES ||
        !p->max_addresses || !p->summary_bin_ms ||
        (p->summary_window_ms + p->summary_bin_ms - 1) / p->summary_bin_ms > CP_COLLECT_BINS ||
        p->max_raw_per_window > CP_COLLECT_RAW || p->max_body_bytes < 4096 ||
        p->max_body_bytes > CP_JOURNAL_MAX_BODY || (p->raw_enabled && !p->sample_every_n))
        return apply_failed(101,ESP_ERR_NOT_SUPPORTED);
    esp_err_t err = cp_pipeline_stop();
    if (err != ESP_OK)
        return apply_failed(102,err);
    unsigned free_slots=load(&s_free_slots);
    unsigned used=(s_journal.count-free_slots)*100u/s_journal.count;
    /* Do not briefly start above the same policy threshold that makes the
     * consumer stop immediately. A sub-second start/stop cannot be represented
     * by the >=1 s window protocol. Latch pressure before reserve admission so
     * a full journal must recover to the existing resume watermark first. */
    if (used>=p->critical_pct ||
        (p->overload_pause_scan && used>=p->raw_pause_pct))
        __atomic_store_n(&s_pressure_paused,true,__ATOMIC_RELEASE);
    if (free_slots <= CP_JOURNAL_CONTROL_RESERVE)
        return apply_failed(103,ESP_ERR_NO_MEM);
    if (__atomic_load_n(&s_pressure_paused, __ATOMIC_ACQUIRE) &&
        used > p->resume_pct)
        return apply_failed(104,ESP_ERR_NO_MEM);
    if (s_memory.init_fault)
        return apply_failed(109, ESP_ERR_INVALID_STATE);
    uint64_t now = mono_ms();
    if (now < p->fetched_mono_ms || now - p->fetched_mono_ms >= p->lease_ms)
        return apply_failed(110, ESP_ERR_INVALID_STATE);
    cp_network_snapshot_t net;
    cp_network_snapshot(&net);
    const uint32_t caps = MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT;
    bool was_paused = s_memory.scan_paused;
    bool admitted = cp_memory_guard_start_allowed(&s_memory, now, heap_caps_get_free_size(caps),
        heap_caps_get_largest_free_block(caps), net.http_in_flight);
    if (!was_paused && s_memory.scan_paused)
        s_memory_policy_sequence = p->request_sequence;
    publish_memory_guard();
    if (!admitted || (s_memory.scan_paused && p->request_sequence <= s_memory_policy_sequence)) {
        s_policy = *p;
        s_policy_owned = true;
        s_idle_pause_tick = now;
        if (!net.http_in_flight && (!s_idle_status_at || now - s_idle_status_at >= 30000)) {
            /* The supervisor owns the radio-transition memory claim during
             * apply. Coalesce this sample; maintain retries after it releases
             * that claim, without allocating on a rejected memory budget. */
            bump(&s_status_dropped);
        }
        return apply_failed(111, ESP_ERR_NO_MEM);
    }
    if (!reserve_seal_bank(p->max_addresses,
            cp_collect_bin_count(p->summary_window_ms, p->summary_bin_ms)))
        return apply_failed(113, ESP_ERR_NO_MEM);
    /* Include the resident bank in the unchanged radio-start budget. The
     * caller still owns the gate, so TLS cannot race this post-allocation check. */
    if (!cp_memory_guard_start_allowed(&s_memory, now, heap_caps_get_free_size(caps),
            heap_caps_get_largest_free_block(caps), net.http_in_flight)) {
        release_seal_bank();
        s_memory_policy_sequence = p->request_sequence;
        publish_memory_guard();
        return apply_failed(111, ESP_ERR_NO_MEM);
    }
    s_policy = *p;
    s_policy_owned = true;
    __atomic_store_n(&s_pressure_paused, false, __ATOMIC_RELEASE);
    __atomic_store_n(&s_raw_paused, false, __ATOMIC_RELEASE);
    s_health.last_error=ESP_OK;
    cp_pipeline_renew_lease(p->fetched_mono_ms + p->lease_ms);
    memset(s_losses, 0, sizeof s_losses);
    s_stop_at = 0;
    __atomic_store_n(&s_capture_started, false, __ATOMIC_RELEASE);
    __atomic_store_n(&s_stop, false, __ATOMIC_RELEASE);
    xEventGroupClearBits(s_radio_events, READY_BIT | FAILED_BIT);
    while (xSemaphoreTake(s_host_done, 0) == pdTRUE) {
    }
    while (xSemaphoreTake(s_worker_done, 0) == pdTRUE) {
    }
    /* Keep these numeric diagnostics on the supervisor task. A failed SDK
     * initialization may already have rolled back the controller while still
     * retaining partial host allocations; controller state alone is insufficient. */
    unsigned controller_before = (unsigned)esp_bt_controller_get_status();
    unsigned internal_before = (unsigned)heap_caps_get_free_size(caps);
    unsigned largest_before = (unsigned)heap_caps_get_largest_free_block(caps);
    err = nimble_port_init();
    ESP_LOGI(TAG, "ble_init err=%d controller_before=%u controller_after=%u "
                 "internal_before=%u internal_after=%u largest_before=%u largest_after=%u "
                 "internal_min=%u stack_free=%u",
             (int)err, controller_before, (unsigned)esp_bt_controller_get_status(),
             internal_before, (unsigned)heap_caps_get_free_size(caps), largest_before,
             (unsigned)heap_caps_get_largest_free_block(caps),
             (unsigned)heap_caps_get_minimum_free_size(caps),
             (unsigned)uxTaskGetStackHighWaterMark(NULL));
    if (err != ESP_OK) {
        /* ESP-IDF can retain partial host state even after controller rollback.
         * Do not deinit that incomplete state or retry it in this boot. */
        cp_memory_guard_init_failed(&s_memory);
        release_seal_bank();
        return apply_failed(105,err);
    }
    s_initialized = true;
    ble_svc_gap_init();
    ble_svc_gatt_init();
    ble_hs_cfg.sync_cb = radio_sync;
    ble_hs_cfg.reset_cb = radio_reset;
    if (xTaskCreate(host_task, "cp_nimble", 4096, NULL, configMAX_PRIORITIES - 4, &s_host) !=
        pdPASS) {
        cp_memory_guard_pause(&s_memory, mono_ms());
        s_memory_policy_sequence = p->request_sequence;
        publish_memory_guard();
        (void)cp_pipeline_stop();
        return apply_failed(106,ESP_ERR_NO_MEM);
    }
    EventBits_t bits = xEventGroupWaitBits(s_radio_events, READY_BIT | FAILED_BIT, pdFALSE, pdFALSE,
                                           pdMS_TO_TICKS(10000));
    if (!(bits & READY_BIT) || (bits & FAILED_BIT)) {
        (void)cp_pipeline_stop();
        return apply_failed(107,s_health.last_error?s_health.last_error:ESP_FAIL);
    }
    portENTER_CRITICAL(&s_capture_mux);
    s_active_window_seq = s_window.window_seq;
    portEXIT_CRITICAL(&s_capture_mux);
    if (xTaskCreate(collector_worker, "cp_collect", 3072, NULL, 4, &s_worker) != pdPASS) {
        cp_memory_guard_pause(&s_memory, mono_ms());
        s_memory_policy_sequence = p->request_sequence;
        publish_memory_guard();
        (void)cp_pipeline_stop();
        return apply_failed(108,ESP_ERR_NO_MEM);
    }
    /* All resident BLE/host/collector allocations now exist. The pre-init
     * START budget includes their headroom; the remaining actual heap must
     * meet STOP floors before opening ingress, without a brief accepted tail. */
    if (heap_caps_get_free_size(caps) < CP_MEMORY_STOP_FREE ||
        heap_caps_get_largest_free_block(caps) < CP_MEMORY_STOP_LARGEST) {
        cp_memory_guard_pause(&s_memory, mono_ms());
        s_memory_policy_sequence = p->request_sequence;
        publish_memory_guard();
        err = cp_pipeline_stop();
        return apply_failed(114, err == ESP_OK ? ESP_ERR_NO_MEM : err);
    }
    portENTER_CRITICAL(&s_capture_mux);
    bool can_accept = !__atomic_load_n(&s_stop, __ATOMIC_ACQUIRE);
    if (can_accept) {
        __atomic_store_n(&s_capture_started, true, __ATOMIC_RELEASE);
        __atomic_store_n(&s_accept, true, __ATOMIC_RELEASE);
    }
    portEXIT_CRITICAL(&s_capture_mux);
    if (!can_accept) {
        (void)cp_pipeline_stop();
        return apply_failed(112, ESP_ERR_INVALID_STATE);
    }
    cp_memory_guard_started(&s_memory);
    publish_memory_guard();
    s_idle_pause_tick = s_idle_status_at = 0;
    return ESP_OK;
}
void cp_pipeline_snapshot(cp_pipeline_snapshot_t *out) {
    if (!out)
        return;
    out->storage_ready = s_health.storage_ready;
    out->collecting = __atomic_load_n(&s_accept, __ATOMIC_ACQUIRE);
#define COPY(field) out->field = load(&s_health.field)
    COPY(pending);
    COPY(quarantined_slots);
    COPY(aggregation_drops);
    COPY(summary_drops);
    COPY(raw_drops);
    COPY(storage_drops);
    COPY(windows_dropped);
    COPY(upload_failures);
    COPY(ack_failures);
    COPY(rejected_batches);
    COPY(reports_seen);
    COPY(windows_committed);
    COPY(summaries_committed);
    COPY(sealed_highwater);
    COPY(seal_overflows);
    COPY(seal_wait_max_ms);
    COPY(persist_max_ms);
#undef COPY
    out->sealed_pending = __atomic_load_n(&s_sealed.pending, __ATOMIC_ACQUIRE);
    out->final_window_pending = __atomic_load_n(&s_final_window_pending, __ATOMIC_ACQUIRE);
    out->free_slots = load(&s_free_slots);
    out->last_error = s_health.last_error;
    out->capacity_slots = s_journal.count;
    out->callback_queue_drops = load(&s_health.callback_queue_drops);
    out->collector_rejections = load(&s_health.collector_rejections);
    out->report_queue_highwater = load(&s_health.report_queue_highwater);
    out->pressure_paused = __atomic_load_n(&s_pressure_paused, __ATOMIC_ACQUIRE);
    out->raw_paused = __atomic_load_n(&s_raw_paused, __ATOMIC_ACQUIRE);
    out->memory_paused = __atomic_load_n(&s_memory_paused, __ATOMIC_ACQUIRE);
    out->memory_raw_paused = __atomic_load_n(&s_memory_raw_paused, __ATOMIC_ACQUIRE);
    out->memory_restart_ready = s_memory.restart_ready &&
        s_latest_policy_response > s_memory_policy_sequence;
    out->radio_restart_required = s_memory.init_fault;
    out->stop_failed = s_stop_failed;
}
