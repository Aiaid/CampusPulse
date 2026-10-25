#include "cJSON.h"
#include "cp_codec.h"
#include "cp_collect.h"
#include "cp_journal.h"
#include "cp_pipeline.h"
#include "cp_upload_scheduler.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
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
#include <string.h>

#define REPORT_QUEUE 64
#define LOSS_BUCKETS 8
#define READY_BIT 1u
#define FAILED_BIT 2u
static const char *TAG = "cp_pipeline";
static cp_journal_t s_journal;
static cp_collect_t s_window;
static cp_network_policy_t s_policy;
static cp_pipeline_snapshot_t s_health;
static SemaphoreHandle_t s_store_lock, s_worker_done, s_host_done;
static EventGroupHandle_t s_radio_events;
static QueueHandle_t s_reports;
static TaskHandle_t s_worker, s_host, s_uploader;
static char s_node[16], s_boot[37];
static uint64_t s_origin, s_stop_at, s_lease_deadline;
static uint32_t s_report_seq, s_summary_seq, s_status_seq, s_next_window = 1, s_first_window;
static uint32_t s_stream_pending[4], s_free_slots, s_loss_overruns, s_raw_queue_drops,
    s_raw_pressure_skips;
static uint32_t s_address_overflow_reports;
static uint32_t s_unpersisted_window_reports, s_status_dropped;
static uint64_t s_raw_paused_ms;
static bool s_pressure_paused, s_raw_paused;
static cp_upload_scheduler_t s_upload_scheduler;
static uint8_t s_own_address;
static bool s_stop, s_accept, s_initialized;
static portMUX_TYPE s_capture_mux = portMUX_INITIALIZER_UNLOCKED;
typedef struct {
    uint32_t window, selected, drops, selected_drops, intentional, pressure;
} loss_bucket_t;
static loss_bucket_t s_losses[LOSS_BUCKETS];
static unsigned char s_upload_body[CP_JOURNAL_MAX_BODY + 1];
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
        ok = cp_journal_append(&s_journal, body, length, control, &slot) == CP_JOURNAL_OK;
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
static void persist_status(void) {
    if (s_status_seq == UINT32_MAX)
        return;
    cp_network_snapshot_t net;
    cp_network_snapshot(&net);
    cp_codec_t c = codec_context();
    cp_codec_status_t status = {.mono_ms = mono_ms(),
                                .collecting = __atomic_load_n(&s_accept, __ATOMIC_ACQUIRE),
                                .connected = net.network == CP_NETWORK_READY,
                                .raw_enabled = s_policy.raw_enabled,
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
                                .raw_paused_ms = s_raw_paused_ms,
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
        return;
    }
    status.free_slots = load(&s_free_slots);
    uint32_t classified = 0;
    for (unsigned i = 0; i < 4; i++)
        classified += status.queue_pending[i] = load(&s_stream_pending[i]);
    unsigned pending = load(&s_health.pending);
    status.unclassified_pending_slots = pending >= classified ? pending - classified : 0;
    xSemaphoreGive(s_store_lock);
    if (!cp_codec_status(&c, &status, ++s_status_seq))
        bump(&s_status_dropped);
}
static void close_window(uint32_t duration) {
    loss_bucket_t lost = {0};
    portENTER_CRITICAL(&s_capture_mux);
    loss_bucket_t *b = &s_losses[s_window.window_seq % LOSS_BUCKETS];
    if (b->window == s_window.window_seq) {
        lost = *b;
        memset(b, 0, sizeof *b);
    }
    portEXIT_CRITICAL(&s_capture_mux);
    __atomic_add_fetch(&s_raw_queue_drops, lost.selected_drops, __ATOMIC_RELAXED);
    if (!cp_collect_losses(&s_window, lost.drops, lost.selected_drops, lost.intentional,
                           lost.pressure)) {
        bump(&s_health.windows_dropped);
        __atomic_add_fetch(&s_unpersisted_window_reports, s_window.reports_seen, __ATOMIC_RELAXED);
        __atomic_add_fetch(&s_health.summary_drops, s_window.address_count, __ATOMIC_RELAXED);
        cp_codec_t c = codec_context();
        (void)cp_codec_flush_raw(&c, &s_window);
        persist_status();
        return;
    }
    cp_codec_t c = codec_context();
    if (!cp_codec_window(&c, &s_window, duration))
        bump(&s_health.windows_dropped);
    __atomic_add_fetch(&s_health.windows_committed, c.windows_committed, __ATOMIC_RELAXED);
    __atomic_add_fetch(&s_health.summaries_committed, c.summaries_committed, __ATOMIC_RELAXED);
    __atomic_add_fetch(&s_health.aggregation_drops, s_window.aggregation_drops, __ATOMIC_RELAXED);
    __atomic_add_fetch(&s_address_overflow_reports, s_window.summary_drops, __ATOMIC_RELAXED);
    __atomic_add_fetch(&s_health.summary_drops, c.summaries_dropped, __ATOMIC_RELAXED);
    __atomic_add_fetch(&s_health.raw_drops, s_window.raw_drops, __ATOMIC_RELAXED);
    __atomic_add_fetch(&s_raw_pressure_skips, s_window.pressure, __ATOMIC_RELAXED);
    __atomic_add_fetch(&s_unpersisted_window_reports, c.unpersisted_window_reports,
                       __ATOMIC_RELAXED);
    persist_status();
}
static bool next_window(void) {
    if (s_window.window_seq == UINT32_MAX)
        return false;
    return cp_collect_begin(&s_window, s_window.start_ms + s_policy.summary_window_ms,
                            s_policy.summary_window_ms, s_policy.summary_bin_ms,
                            s_window.window_seq + 1, s_policy.max_addresses, s_policy.raw_enabled);
}
static void request_stop_at(uint64_t at) {
    portENTER_CRITICAL(&s_capture_mux);
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
static void collector_worker(void *arg) {
    (void)arg;
    cp_report_t report;
    uint64_t previous_tick = mono_ms();
    for (;;) {
        bool got = xQueueReceive(s_reports, &report, pdMS_TO_TICKS(100)) == pdTRUE;
        if (got) {
            while (report.mono_ms >= s_window.start_ms + s_window.window_ms) {
                close_window(s_window.window_ms);
                if (!next_window()) {
                    request_stop();
                    break;
                }
            }
            if (!cp_collect_observe(&s_window, &report))
                bump(&s_health.aggregation_drops);
        }
        uint64_t tick = mono_ms();
        uint64_t expiry = lease_deadline();
        if (expiry && tick >= expiry && !__atomic_load_n(&s_stop, __ATOMIC_ACQUIRE))
            request_stop_at(expiry);
        unsigned used = (s_journal.count - load(&s_free_slots)) * 100 / s_journal.count;
        if (used >= s_policy.raw_pause_pct)
            __atomic_store_n(&s_raw_paused, true, __ATOMIC_RELEASE);
        else if (used <= s_policy.resume_pct)
            __atomic_store_n(&s_raw_paused, false, __ATOMIC_RELEASE);
        if (s_policy.raw_enabled && __atomic_load_n(&s_raw_paused, __ATOMIC_ACQUIRE))
            s_raw_paused_ms += tick - previous_tick;
        previous_tick = tick;
        bool stop = __atomic_load_n(&s_stop, __ATOMIC_ACQUIRE);
        if (!stop && s_window.raw_count &&
            mono_ms() - s_window.raw[0].mono_ms >= s_policy.flush_max_age_ms) {
            cp_codec_t c = codec_context();
            (void)cp_codec_flush_raw(&c, &s_window);
        }
        if (!got) {
            uint64_t now = mono_ms();
            if (stop) {
                portENTER_CRITICAL(&s_capture_mux);
                uint64_t end = s_stop_at;
                portEXIT_CRITICAL(&s_capture_mux);
                while (end >= s_window.start_ms + s_window.window_ms) {
                    close_window(s_window.window_ms);
                    if (!next_window())
                        break;
                }
                if (end >= s_window.start_ms && end - s_window.start_ms < s_window.window_ms &&
                    (end > s_window.start_ms || s_window.reports_seen || s_window.raw_count))
                    close_window((uint32_t)(end - s_window.start_ms));
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
    if (s_report_seq == UINT32_MAX) {
        portEXIT_CRITICAL(&s_capture_mux);
        request_stop();
        return 0;
    }
    r.report_seq = ++s_report_seq;
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
    else if (__atomic_load_n(&s_raw_paused, __ATOMIC_ACQUIRE))
        r.raw = CP_RAW_PRESSURE;
    else {
        r.raw = CP_RAW_SELECTED;
        b->selected++;
    }
    portEXIT_CRITICAL(&s_capture_mux);
    if (xQueueSend(s_reports, &r, 0) != pdTRUE) {
        portENTER_CRITICAL(&s_capture_mux);
        b->drops++;
        if (r.raw == CP_RAW_SELECTED)
            b->selected_drops++;
        else if (r.raw == CP_RAW_INTENTIONAL)
            b->intentional++;
        else if (r.raw == CP_RAW_PRESSURE)
            b->pressure++;
        portEXIT_CRITICAL(&s_capture_mux);
    }
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
        s_first_window = s_next_window;
        if (!cp_collect_begin(&s_window, s_origin, s_policy.summary_window_ms,
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
        __atomic_store_n(&s_accept, true, __ATOMIC_RELEASE);
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
static bool batch_metadata(const char *body, cp_network_batch_t *out) {
    cJSON *j = cJSON_Parse(body);
    if (!j)
        return false;
    memset(out, 0, sizeof *out);
    struct {
        const char *key;
        char *out;
        size_t n;
    } fields[] = {{"node_id", out->node_id, sizeof out->node_id},
                  {"boot_id", out->boot_id, sizeof out->boot_id},
                  {"batch_id", out->batch_id, sizeof out->batch_id},
                  {"stream", out->stream, sizeof out->stream}};
    bool ok = true;
    for (unsigned i = 0; i < 4; i++) {
        cJSON *v = cJSON_GetObjectItemCaseSensitive(j, fields[i].key);
        if (!cJSON_IsString(v) || strlen(v->valuestring) >= fields[i].n) {
            ok = false;
            break;
        }
        strcpy(fields[i].out, v->valuestring);
    }
    out->accepted_count =
        (uint32_t)cJSON_GetArraySize(cJSON_GetObjectItemCaseSensitive(j, "items"));
    ok = ok && out->accepted_count > 0 && stream_index(out->stream) >= 0 &&
         cp_network_sha256(body, strlen(body), out->body_sha256);
    cJSON_Delete(j);
    return ok;
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
static void uploader_task(void *arg) {
    (void)arg;
    for (;;) {
        cp_network_snapshot_t net;
        cp_network_snapshot(&net);
        if (net.network != CP_NETWORK_READY || net.auth != CP_AUTH_VALID) {
            vTaskDelay(pdMS_TO_TICKS(1000));
            continue;
        }
        uint16_t selected = CP_UPLOAD_NO_SLOT;
        size_t length = 0;
        if (xSemaphoreTake(s_store_lock, pdMS_TO_TICKS(100)) == pdTRUE) {
            selected = cp_upload_scheduler_select(&s_upload_scheduler, s_journal.slots,
                                                  s_journal.count, mono_ms());
            if (selected != CP_UPLOAD_NO_SLOT) {
                cp_journal_result_t read = cp_journal_read(&s_journal, selected, s_upload_body,
                                                           CP_JOURNAL_MAX_BODY, &length);
                if (read != CP_JOURNAL_OK) {
                    upload_read_failed(selected, read);
                    selected = CP_UPLOAD_NO_SLOT;
                    update_store_health();
                }
            }
            xSemaphoreGive(s_store_lock);
        }
        if (selected == CP_UPLOAD_NO_SLOT) {
            vTaskDelay(pdMS_TO_TICKS(1000));
            continue;
        }
        s_upload_body[length] = 0;
        cp_network_batch_t meta;
        cp_network_ack_t ack;
        if (!batch_metadata((const char *)s_upload_body, &meta)) {
            /* cJSON allocation failure is indistinguishable here from malformed
             * metadata. Keep the slot retryable, including its discovery lane. */
            if (xSemaphoreTake(s_store_lock, pdMS_TO_TICKS(5000)) == pdTRUE) {
                cp_upload_scheduler_retry(&s_upload_scheduler, selected, mono_ms(), esp_random());
                xSemaphoreGive(s_store_lock);
            }
            bump(&s_health.upload_failures);
            vTaskDelay(pdMS_TO_TICKS(1000));
            continue;
        }
        bool discovered = false;
        if (xSemaphoreTake(s_store_lock, pdMS_TO_TICKS(5000)) != pdTRUE) {
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
            vTaskDelay(pdMS_TO_TICKS(10));
            continue;
        }
        cp_net_upload_result_t result =
            cp_network_upload_frozen(s_upload_body, length, &meta, &ack);
        if (xSemaphoreTake(s_store_lock, pdMS_TO_TICKS(5000)) != pdTRUE) {
            bump(&s_health.ack_failures);
            vTaskDelay(pdMS_TO_TICKS(1000));
            continue;
        }
        if (result == CP_NET_UPLOAD_ACKED) {
            if (cp_journal_ack(&s_journal, selected) == CP_JOURNAL_OK) {
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
        vTaskDelay(pdMS_TO_TICKS(10));
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
            cp_journal_result_t read =
                cp_journal_read(&s_journal, (uint16_t)i, s_upload_body, CP_JOURNAL_MAX_BODY, &n);
            if (read == CP_JOURNAL_OK) {
                s_upload_body[n] = 0;
                cp_network_batch_t meta;
                if (batch_metadata((const char *)s_upload_body, &meta)) {
                    unsigned index = (unsigned)stream_index(meta.stream);
                    if (cp_upload_scheduler_bind(&s_upload_scheduler, (uint16_t)i, index))
                        bump(&s_stream_pending[index]);
                } else {
                    /* Unknown metadata stays discoverable after transient OOM. */
                    cp_upload_scheduler_retry(&s_upload_scheduler, (uint16_t)i, mono_ms(),
                                              esp_random());
                    bump(&s_health.upload_failures);
                }
            } else {
                upload_read_failed((uint16_t)i, read);
            }
        }
    update_store_health();
    if (xTaskCreate(uploader_task, "cp_upload", 8192, NULL, 3, &s_uploader) != pdPASS) {
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
    if (!s_initialized)
        return ESP_OK;
    request_stop();
    (void)ble_gap_disc_cancel();
    if (s_worker) {
        if (xSemaphoreTake(s_worker_done, pdMS_TO_TICKS(10000)) != pdTRUE)
            return ESP_ERR_TIMEOUT;
        vTaskDelete(s_worker);
        s_worker = NULL;
    }
    if (s_host) {
        if (nimble_port_stop() != 0)
            return ESP_FAIL;
        if (xSemaphoreTake(s_host_done, pdMS_TO_TICKS(5000)) != pdTRUE)
            return ESP_ERR_TIMEOUT;
        vTaskDelete(s_host);
        s_host = NULL;
    }
    esp_err_t err = nimble_port_deinit();
    if (err == ESP_OK)
        s_initialized = false;
    return err;
}
esp_err_t cp_pipeline_apply(const cp_network_policy_t *p) {
    if (!s_health.storage_ready || !p || p->max_addresses > CP_COLLECT_ADDRESSES ||
        !p->max_addresses || !p->summary_bin_ms ||
        (p->summary_window_ms + p->summary_bin_ms - 1) / p->summary_bin_ms > CP_COLLECT_BINS ||
        p->max_raw_per_window > CP_COLLECT_RAW || p->max_body_bytes < 4096 ||
        p->max_body_bytes > CP_JOURNAL_MAX_BODY || (p->raw_enabled && !p->sample_every_n))
        return ESP_ERR_NOT_SUPPORTED;
    ESP_LOGW(TAG, "DIAG heap@apply-entry free=%lu largest=%lu min=%lu",
             (unsigned long)esp_get_free_heap_size(),
             (unsigned long)heap_caps_get_largest_free_block(MALLOC_CAP_8BIT),
             (unsigned long)esp_get_minimum_free_heap_size());
    esp_err_t err = cp_pipeline_stop();
    if (err != ESP_OK)
        return err;
    ESP_LOGW(TAG, "DIAG heap@after-stop free=%lu largest=%lu min=%lu",
             (unsigned long)esp_get_free_heap_size(),
             (unsigned long)heap_caps_get_largest_free_block(MALLOC_CAP_8BIT),
             (unsigned long)esp_get_minimum_free_heap_size());
    if (load(&s_free_slots) <= CP_JOURNAL_CONTROL_RESERVE)
        return ESP_ERR_NO_MEM;
    if (__atomic_load_n(&s_pressure_paused, __ATOMIC_ACQUIRE) &&
        (s_journal.count - load(&s_free_slots)) * 100 / s_journal.count > p->resume_pct)
        return ESP_ERR_NO_MEM;
    __atomic_store_n(&s_pressure_paused, false, __ATOMIC_RELEASE);
    __atomic_store_n(&s_raw_paused, false, __ATOMIC_RELEASE);
    s_policy = *p;
    cp_pipeline_renew_lease(p->fetched_mono_ms + p->lease_ms);
    memset(s_losses, 0, sizeof s_losses);
    s_stop_at = 0;
    __atomic_store_n(&s_stop, false, __ATOMIC_RELEASE);
    xEventGroupClearBits(s_radio_events, READY_BIT | FAILED_BIT);
    while (xSemaphoreTake(s_host_done, 0) == pdTRUE) {
    }
    while (xSemaphoreTake(s_worker_done, 0) == pdTRUE) {
    }
    ESP_LOGW(TAG, "DIAG heap@before-nimble-init free=%lu largest=%lu min=%lu",
             (unsigned long)esp_get_free_heap_size(),
             (unsigned long)heap_caps_get_largest_free_block(MALLOC_CAP_8BIT),
             (unsigned long)esp_get_minimum_free_heap_size());
    err = nimble_port_init();
    if (err != ESP_OK)
        return err;
    s_initialized = true;
    ble_svc_gap_init();
    ble_svc_gatt_init();
    ble_hs_cfg.sync_cb = radio_sync;
    ble_hs_cfg.reset_cb = radio_reset;
    if (xTaskCreate(host_task, "cp_nimble", 4096, NULL, configMAX_PRIORITIES - 4, &s_host) !=
        pdPASS) {
        (void)cp_pipeline_stop();
        return ESP_ERR_NO_MEM;
    }
    EventBits_t bits = xEventGroupWaitBits(s_radio_events, READY_BIT | FAILED_BIT, pdFALSE, pdFALSE,
                                           pdMS_TO_TICKS(10000));
    if (!(bits & READY_BIT) || (bits & FAILED_BIT)) {
        (void)cp_pipeline_stop();
        return ESP_FAIL;
    }
    if (xTaskCreate(collector_worker, "cp_collect", 8192, NULL, 4, &s_worker) != pdPASS) {
        (void)cp_pipeline_stop();
        return ESP_ERR_NO_MEM;
    }
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
#undef COPY
    out->free_slots = load(&s_free_slots);
    out->last_error = s_health.last_error;
    out->capacity_slots = s_journal.count;
    out->pressure_paused = __atomic_load_n(&s_pressure_paused, __ATOMIC_ACQUIRE);
    out->raw_paused = __atomic_load_n(&s_raw_paused, __ATOMIC_ACQUIRE);
}
