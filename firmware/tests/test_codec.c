/* Host-only fault injection against the production codec and IDF cJSON. */
#include "cJSON.h"
#include "cp_codec.h"
#include <assert.h>
#include <limits.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef union {
    max_align_t alignment;
    size_t size;
} allocation_t;
static size_t live_allocations, allocation_calls, fail_at;
static size_t live_json_bytes, peak_json_bytes, largest_body_bytes;
static bool inside_sink;
static unsigned sink_items[4], sink_batches[4], uuid_counter;
static double expected_uncertainty = 23;
static bool expect_known = true, expect_null_uncertainty;
static unsigned expected_unacked_slots;
static const char *expected_pause, *expected_scan, *expected_raw;
static void *checked_malloc(size_t bytes) {
    if (!inside_sink && ++allocation_calls == fail_at)
        return NULL;
    allocation_t *p = malloc(sizeof(*p) + bytes);
    if (!p)
        return NULL;
    p->size = inside_sink ? 0 : bytes;
    live_json_bytes += p->size;
    if (live_json_bytes > peak_json_bytes)
        peak_json_bytes = live_json_bytes;
    live_allocations++;
    return p + 1;
}
static void checked_free(void *pointer) {
    if (!pointer)
        return;
    assert(live_allocations);
    live_allocations--;
    allocation_t *p = (allocation_t *)pointer - 1;
    assert(live_json_bytes >= p->size);
    live_json_bytes -= p->size;
    free(p);
}
static const cJSON *field(const cJSON *o, const char *key) {
    const cJSON *v = cJSON_GetObjectItemCaseSensitive(o, key);
    assert(v);
    return v;
}
static void required(const cJSON *o, const char *const *keys, size_t count) {
    assert(cJSON_IsObject(o));
    for (size_t i = 0; i < count; i++)
        (void)field(o, keys[i]);
    assert((size_t)cJSON_GetArraySize(o) == count);
}
#define REQUIRED(o, ...)                                                                           \
    do {                                                                                           \
        const char *const keys[] = {__VA_ARGS__};                                                  \
        required(o, keys, sizeof keys / sizeof keys[0]);                                           \
    } while (0)
static void check_time(const cJSON *o) {
    const cJSON *t = field(o, "time");
    REQUIRED(t, "mono_ms", "clock_epoch", "utc_ms", "uncertainty_ms");
    assert(cJSON_IsNumber(field(t, "mono_ms")) && cJSON_IsNumber(field(t, "clock_epoch")));
    if (expect_known) {
        assert(cJSON_IsNumber(field(t, "utc_ms")));
        if (expect_null_uncertainty)
            assert(cJSON_IsNull(field(t, "uncertainty_ms")));
        else
            assert(field(t, "uncertainty_ms")->valuedouble >= 20);
    } else {
        assert(cJSON_IsNull(field(t, "utc_ms")));
        assert(cJSON_IsNull(field(t, "uncertainty_ms")));
    }
}
static void check_rssi(const cJSON *o) {
    const cJSON *r = field(o, "rssi");
    REQUIRED(r, "samples", "min_dbm", "max_dbm", "mean_dbm");
    assert(cJSON_IsNumber(field(r, "samples")));
}
static bool sink(void *ctx, const char *body, size_t bytes, const char *stream, unsigned count,
                 bool control) {
    if (ctx)
        assert(bytes <= *(const unsigned *)ctx);
    assert(bytes == strlen(body));
    if (bytes > largest_body_bytes)
        largest_body_bytes = bytes;
    inside_sink = true;
    cJSON *j = cJSON_Parse(body);
    assert(j);
    REQUIRED(j, "protocol", "node_id", "boot_id", "placement_id", "capture_config_id", "dataset",
             "firmware_version", "batch_id", "stream", "items");
    assert(!strcmp(field(j, "protocol")->valuestring, "campuspulse/2"));
    assert(!strcmp(field(j, "stream")->valuestring, stream));
    const cJSON *items = field(j, "items");
    assert(cJSON_IsArray(items) && (unsigned)cJSON_GetArraySize(items) == count);
    unsigned index = !strcmp(stream, "ble_windows")         ? 0
                     : !strcmp(stream, "address_summaries") ? 1
                     : !strcmp(stream, "ble_reports")       ? 2
                                                            : 3;
    assert(control == (index == 0 || index == 3));
    sink_items[index] += count;
    sink_batches[index]++;
    const cJSON *item = NULL;
    cJSON_ArrayForEach(item, items) {
        check_time(item);
        assert(cJSON_IsNumber(field(item, "seq")));
        if (index == 0) {
            REQUIRED(item, "seq", "time", "duration_ms", "scan_enabled_ms", "reports_seen",
                     "reports_aggregated", "aggregation_drops", "adv_reports",
                     "scan_response_reports", "visible_identifiers", "unique_table_capacity",
                     "unique_table_overflow", "rssi", "raw_capture", "quality_flags");
            check_rssi(item);
            assert(field(item, "reports_seen")->valuedouble ==
                   field(item, "reports_aggregated")->valuedouble +
                       field(item, "aggregation_drops")->valuedouble);
        } else if (index == 1) {
            REQUIRED(item, "seq", "time", "window_seq", "duration_ms", "bin_ms", "address",
                     "address_type", "reports", "adv_reports", "scan_response_reports",
                     "first_offset_ms", "last_offset_ms", "rssi", "bins", "vehicle_evidence");
            const cJSON *vehicle = field(item, "vehicle_evidence");
            REQUIRED(vehicle, "schema_version", "parsed_reports", "malformed_reports",
                     "name_brand_mask", "exclusion_mask", "ecosystem_mask");
            assert(!strcmp(field(vehicle, "schema_version")->valuestring, CP_VEHICLE_SCHEMA_VERSION));
            assert(field(vehicle, "parsed_reports")->valuedouble + field(vehicle, "malformed_reports")->valuedouble ==
                   field(item, "reports")->valuedouble);
            assert(!strstr(body, "payload_hex") && !strstr(body, "display_text"));
            check_rssi(item);
            double sum = 0;
            const cJSON *b = NULL;
            cJSON_ArrayForEach(b, field(item, "bins")) {
                assert(cJSON_IsNumber(b));
                sum += b->valuedouble;
            }
            assert(sum == field(item, "reports")->valuedouble);
        } else if (index == 2) {
            REQUIRED(item, "seq", "time", "window_seq", "identity", "rssi_dbm", "report_type",
                     "report_type_code", "format", "payload_length", "payload_hex");
            REQUIRED(field(item, "identity"), "scheme", "address", "address_type");
            assert(strlen(field(item, "payload_hex")->valuestring) ==
                   (size_t)field(item, "payload_length")->valuedouble * 2);
        } else {
            REQUIRED(item, "seq", "time", "uptime_ms", "scan_state", "wifi_state",
                     "free_heap_bytes", "queue_pending", "queue_capacity", "storage_free_bytes",
                     "raw_capture_state", "loss_totals", "buffer_health");
            REQUIRED(field(item, "queue_pending"), "ble_windows", "address_summaries",
                     "ble_reports", "node_status");
            REQUIRED(field(item, "loss_totals"), "aggregation_drops", "raw_queue_drops",
                     "storage_drops", "windows_dropped", "upload_failures", "ack_failures",
                     "raw_pressure_skips", "address_summaries_dropped",
                     "address_table_overflow_reports", "accounting_overrun_reports",
                     "unpersisted_window_reports", "status_samples_coalesced");
            assert(field(field(item, "loss_totals"), "address_summaries_dropped")->valuedouble ==
                   2);
            assert(
                field(field(item, "loss_totals"), "address_table_overflow_reports")->valuedouble ==
                7);
            if (expected_unacked_slots)
                assert(field(field(item, "buffer_health"), "unacked_bytes")->valuedouble ==
                       expected_unacked_slots * 12288u);
            if (expected_pause) {
                assert(!strcmp(field(field(item, "buffer_health"), "pause_reason")->valuestring, expected_pause));
                assert(!strcmp(field(item, "scan_state")->valuestring, expected_scan));
                assert(!strcmp(field(item, "raw_capture_state")->valuestring, expected_raw));
            }
        }
        if (index != 2 && expect_known && !expect_null_uncertainty)
            assert(field(field(item, "time"), "uncertainty_ms")->valuedouble ==
                   expected_uncertainty);
    }
    cJSON_Delete(j);
    inside_sink = false;
    return true;
}
static void uuid(char out[37]) {
    snprintf(out, 37, "11111111-1111-4111-8111-%012u", ++uuid_counter);
}
static cp_codec_t context(uint32_t *seq) {
    return (cp_codec_t){.node_id = "cp_020000000001",
                        .boot_id = "11111111-1111-4111-8111-111111111111",
                        .placement_id = "fixture-placement-v2",
                        .config_id = "fixture-config-v2",
                        .dataset = "demo",
                        .firmware_version = "campuspulse-passport-v2",
                        .max_items = 16,
                        .max_body_bytes = 8192,
                        .clock_known = true,
                        .clock_mono_ms = 1000,
                        .clock_utc_ms = 1792800000000ULL,
                        .clock_epoch = 1,
                        .uncertainty_ms = 20,
                        .summary_sequence = seq,
                        .uuid = uuid,
                        .sink = sink};
}
static cp_collect_t window(void) {
    cp_collect_t w;
    assert(cp_collect_begin(&w, 1000, 30000, 5000, 1, 64, true));
    for (unsigned n = 0; n < 12; n++) {
        cp_report_t r = {.mono_ms = 1001 + n * 2000,
                         .report_seq = n + 1,
                         .address = {2, 0, 0, 0, 0, (uint8_t)(n % 3 + 1)},
                         .address_type = 1,
                         .rssi = -60,
                         .payload_length = 3,
                         .payload = {2, 1, 6},
                         .raw = n < 4 ? CP_RAW_SELECTED : CP_RAW_INTENTIONAL};
        assert(cp_collect_observe(&w, &r));
    }
    return w;
}
static cp_codec_status_t status(void) {
    return (cp_codec_status_t){.mono_ms = 31000,
                               .collecting = true,
                               .connected = true,
                               .raw_enabled = true,
                               .free_heap = 65536,
                               .queue_pending = {1, 3, 1, 0},
                               .slots = 341,
                               .free_slots = 336,
                               .address_summaries_dropped = 2,
                               .address_table_overflow_reports = 7,
                               .accounting_overrun_reports = 3,
                               .unpersisted_window_reports = 19,
                               .warn_pct = 60,
                               .raw_pause_pct = 80,
                               .critical_pct = 95};
}
static void reset(size_t fail) {
    assert(!live_allocations);
    assert(!live_json_bytes);
    peak_json_bytes = largest_body_bytes = 0;
    allocation_calls = 0;
    fail_at = fail;
    inside_sink = false;
    memset(sink_items, 0, sizeof sink_items);
    memset(sink_batches, 0, sizeof sink_batches);
}
static size_t run(bool health, size_t failure, unsigned max_items) {
    reset(failure);
    uint32_t seq = 0;
    cp_codec_t c = context(&seq);
    c.max_items = max_items;
    if (health) {
        cp_codec_status_t s = status();
        (void)cp_codec_status(&c, &s, 1);
        assert(sink_items[3] + c.status_dropped == 1);
    } else {
        cp_collect_t w = window();
        (void)cp_codec_window(&c, &w, 30000);
        assert(w.raw_count == 0);
        assert(w.raw_drops == c.raw_dropped);
        assert(sink_items[0] + c.windows_dropped == 1);
        assert(sink_items[1] + c.summaries_dropped == 3);
        assert(sink_items[2] + c.raw_dropped == 4);
        assert(seq == 3);
    }
    assert(c.failed_items ==
           c.windows_dropped + c.summaries_dropped + c.raw_dropped + c.status_dropped);
    assert(c.windows_committed == sink_items[0] && c.summaries_committed == sink_items[1] &&
           c.raw_committed == sink_items[2]);
    if (failure)
        assert(c.failed_batches >= 1 && c.failed_items >= 1);
    else
        assert(c.failed_batches == 0 && c.failed_items == 0);
    assert(live_allocations == 0);
    return allocation_calls;
}
static void clocks(void) {
    uint32_t seq = 0;
    reset(0);
    cp_codec_t c = context(&seq);
    cp_codec_status_t s = status();
    c.clock_known = false;
    expect_known = false;
    assert(cp_codec_status(&c, &s, 1));
    c.clock_known = true;
    expect_known = true;
    c.uncertainty_ms = UINT32_MAX;
    expect_null_uncertainty = true;
    assert(cp_codec_status(&c, &s, 2));
    c.uncertainty_ms = UINT32_MAX - 1;
    s.mono_ms = 21000;
    assert(cp_codec_status(&c, &s, 3));
    c.uncertainty_ms = 20;
    expect_null_uncertainty = false;
    s.mono_ms = 1;
    expected_uncertainty = 21;
    assert(cp_codec_status(&c, &s, 4));
    c.clock_utc_ms = 1;
    expect_known = false;
    assert(cp_codec_status(&c, &s, 5));
    assert(!live_allocations);
    expect_known = true;
    expected_uncertainty = 23;
}
static void packed_summaries(void) {
    for (unsigned budget = 4096; budget <= 8192; budget *= 2) {
        reset(0);
        uint32_t seq = 0;
        cp_codec_t c = context(&seq);
        c.max_body_bytes = budget;
        c.sink_context = &budget;
        char long_id[65];
        memset(long_id, 'a', sizeof long_id - 1);
        long_id[sizeof long_id - 1] = 0;
        c.config_id = c.placement_id = long_id;
        cp_collect_t w;
        assert(cp_collect_begin(&w, 1000, 30000, 2000, 1, 64, false));
        for (unsigned i = 0; i < 64; i++) {
            cp_report_t r = {.mono_ms = 1001,
                             .report_seq = i + 1,
                             .address = {2, 0, 0, 0, 0, (uint8_t)i},
                             .address_type = 3,
                             .rssi = -100};
            assert(cp_collect_observe(&w, &r));
            cp_address_summary_t *a = &w.addresses[i];
            a->reports = a->adv = a->samples = 60000000;
            a->rssi_sum = -1; // Exercise a long fractional mean.
            a->rssi_min = -127;
            a->rssi_max = 126;
            a->last_ms = 29999;
            a->vehicle_evidence = (cp_vehicle_evidence_t){
                .parsed_reports = 30000000, .malformed_reports = 30000000,
                .name_brand_mask = CP_VEHICLE_NAME_MASK_ALL,
                .exclusion_mask = CP_VEHICLE_EXCLUSION_MASK_ALL,
                .ecosystem_mask = CP_VEHICLE_ECOSYSTEM_MASK_ALL};
            for (unsigned bin = 0; bin < 15; bin++)
                a->bins[bin] = 4000000;
        }
        w.reports_seen = w.reports_aggregated = w.adv = w.rssi_samples = 3840000000u;
        assert(cp_codec_window(&c, &w, 30000));
        assert(c.summaries_committed == 64 && c.failed_items == 0);
        assert(sink_batches[1] == (budget == 4096 ? 22u : 11u));
        assert(peak_json_bytes < 40000); /* Host cJSON nodes are larger than C3. */
        printf("Full 64-address packing: body limit %u, %u batches, largest body %zu, host JSON peak %zu bytes\n",
               budget, sink_batches[1], largest_body_bytes, peak_json_bytes);
        assert(live_allocations == 0);
    }
}
static void invalid_vehicle_evidence(void) {
    for (unsigned variant = 0; variant < 4; ++variant) {
        reset(0);
        uint32_t seq = 0;
        cp_codec_t c = context(&seq);
        cp_collect_t w = window();
        cp_vehicle_evidence_t *e = &w.addresses[0].vehicle_evidence;
        if (variant == 0) e->parsed_reports++;
        if (variant == 1) e->name_brand_mask = 1u << 20;
        if (variant == 2) e->exclusion_mask = 1u << 11;
        if (variant == 3) e->ecosystem_mask = 1u << 2;
        assert(!cp_codec_window(&c, &w, 30000));
        assert(sink_items[1] == 0 && c.summaries_dropped == 3);
        assert(c.windows_dropped == 1 && c.raw_committed == 4 && !live_allocations);
    }
}
static void short_windows(void) {
    for (unsigned duration = 0; duration <= 999; duration += 999) {
        reset(0);
        uint32_t seq = 0;
        cp_codec_t c = context(&seq);
        cp_collect_t w = window();
        assert(cp_collect_losses(&w, 3, 1, 1, 1));
        assert(!cp_codec_window(&c, &w, duration));
        assert(w.raw_count == 0 && c.raw_committed == 4 && c.raw_dropped == 0);
        assert(c.windows_dropped == 1 && c.summaries_dropped == 3);
        assert(c.unpersisted_window_reports == 15 && w.aggregation_drops == 3);
        assert(seq == 0 && sink_items[0] == 0 && sink_items[1] == 0);
        assert(live_allocations == 0);
    }
}
static void invalid_partial_boundaries(void) {
    const unsigned durations[] = {1000, 1970, 5000, 5001};
    for (unsigned i = 0; i < sizeof durations / sizeof durations[0]; i++) {
        reset(0);
        uint32_t seq = 0;
        cp_codec_t c = context(&seq);
        cp_collect_t w;
        assert(cp_collect_begin(&w, 1000, 30000, 5000, 1, 64, true));
        cp_report_t report = {.mono_ms = 1000 + durations[i], .report_seq = 1,
            .address = {2, 0, 0, 0, 0, 1}, .rssi = -50, .raw = CP_RAW_SELECTED};
        assert(cp_collect_observe(&w, &report));
        assert(!cp_codec_window(&c, &w, durations[i]));
        assert(c.raw_committed == 1 && !c.raw_dropped && !w.raw_count);
        assert(c.windows_dropped == 1 && c.summaries_dropped == 1);
        assert(c.unpersisted_window_reports == 1 && !seq);
        assert(!sink_items[0] && !sink_items[1] && sink_items[2] == 1);
        assert(!live_allocations);

        /* Millisecond ingress at the stop instant belongs to a window ending
         * one millisecond later. A valid exclusive end must preserve it. */
        reset(0);
        seq = 0;
        c = context(&seq);
        assert(cp_collect_begin(&w, 1000, 30000, 5000, 1, 64, true));
        assert(cp_collect_observe(&w, &report));
        expected_uncertainty = 21; /* One ceil-rounded 10-second drift interval. */
        assert(cp_codec_window(&c, &w, durations[i] + 1));
        expected_uncertainty = 23;
        assert(c.raw_committed == 1 && c.summaries_committed == 1 && c.windows_committed == 1);
        assert(!c.raw_dropped && !c.summaries_dropped && !c.windows_dropped);
        assert(!c.unpersisted_window_reports && seq == 1);
        assert(sink_items[0] == 1 && sink_items[1] == 1 && sink_items[2] == 1);
        assert(!live_allocations);
    }
}
static void recovered_unknown_metadata(void) {
    reset(0);
    uint32_t seq = 0;
    cp_codec_t c = context(&seq);
    cp_codec_status_t s = status();
    s.free_slots = s.slots - 7;
    s.unclassified_pending_slots = 2;
    expected_unacked_slots = 7;
    assert(cp_codec_status(&c, &s, 1));
    expected_unacked_slots = 0;
    s.unclassified_pending_slots = 3; // Pending bytes cannot exceed occupied slots.
    assert(!cp_codec_status(&c, &s, 2));
    assert(live_allocations == 0);
}
static void memory_pause_status(void) {
    reset(0);
    uint32_t seq = 0;
    cp_codec_t c = context(&seq);
    cp_codec_status_t s = status();
    s.raw_enabled = true;
    s.memory_raw_paused = true;
    expected_pause = "memory_raw_pressure";
    expected_scan = "running";
    expected_raw = "paused";
    assert(cp_codec_status(&c, &s, 1));
    s.memory_paused = true;
    s.collecting = false;
    expected_pause = "memory_pressure";
    expected_scan = "paused";
    assert(cp_codec_status(&c, &s, 2));
    s.raw_enabled = false;
    expected_raw = "off";
    assert(cp_codec_status(&c, &s, 3));
    assert(sink_items[0] == 0 && sink_items[1] == 0 && sink_items[2] == 0);
    assert(!live_allocations);
    expected_pause = expected_scan = expected_raw = NULL;
}
/* Exact transcript comparison includes batch identities, ordering and failure
 * attempts. Keep test capture storage separate from the production allocator. */
static char view_transcript[131072];
static size_t view_offset, view_length;
static bool view_compare, view_reject_raw, view_saw_aggregate;
static unsigned view_calls;
static bool view_sink(void *ctx, const char *body, size_t length, const char *stream,
                      unsigned count, bool control) {
    (void)ctx;
    (void)count;
    (void)control;
    assert(length == strlen(body));
    if (!strcmp(stream, "ble_reports"))
        assert(!view_saw_aggregate);
    else
        view_saw_aggregate = true;
    assert(view_offset + length + 1 <= sizeof view_transcript);
    if (view_compare) {
        assert(view_offset + length + 1 <= view_length);
        assert(!memcmp(view_transcript + view_offset, body, length + 1));
    } else {
        memcpy(view_transcript + view_offset, body, length + 1);
    }
    view_offset += length + 1;
    ++view_calls;
    return !view_reject_raw || strcmp(stream, "ble_reports");
}
static void assert_codec_losses_equal(const cp_codec_t *a, const cp_codec_t *b) {
#define SAME(field) assert(a->field == b->field)
    SAME(windows_committed); SAME(summaries_committed); SAME(raw_committed);
    SAME(failed_batches); SAME(failed_items); SAME(summaries_dropped);
    SAME(windows_dropped); SAME(raw_dropped); SAME(status_dropped);
    SAME(unpersisted_window_reports); SAME(build_failed); SAME(build_items);
#undef SAME
}
static uint64_t record_hash(const void *data, size_t length) {
    const unsigned char *bytes = data;
    uint64_t hash = 14695981039346656037ULL;
    for (size_t i = 0; i < length; ++i)
        hash = (hash ^ bytes[i]) * 1099511628211ULL;
    return hash;
}
static void window_views(void) {
    _Static_assert(sizeof(cp_codec_window_view_t) <= 160, "window view must stay small");
    for (unsigned capacity = 16; capacity <= 64; capacity *= 4) {
        for (unsigned variant = 0; variant < 6; ++variant) {
            cp_collect_t w;
            assert(cp_collect_begin(&w, 1000, 30000, 2000, 9, capacity, true));
            for (unsigned i = 0; i < capacity; ++i) {
                cp_report_t report = {.mono_ms = 1001 + i, .report_seq = i + 1,
                    .address = {2, 0, 0, 0, 0, (uint8_t)i}, .address_type = 1,
                    .rssi = -60, .raw = i < CP_COLLECT_RAW ? CP_RAW_SELECTED : CP_RAW_INTENTIONAL};
                assert(cp_collect_observe(&w, &report));
            }
            w.summary_drops = 3;
            w.raw_drops = 7;
            if (variant == 3)
                w.addresses[0].last_ms = 30000; /* Reject only after raw. */
            if (variant == 4)
                w.raw[0].payload_length = 32; /* Entire raw batch is dropped. */
            const cp_collect_t original = w;
            uint64_t original_hash = record_hash(&original, sizeof original);
            const cp_codec_window_view_t view = cp_codec_window_from_collect(&original);
            const cp_codec_window_view_t saved_view = view;
#define SCALAR(field) assert(view.field == original.field)
            SCALAR(start_ms); SCALAR(window_ms); SCALAR(bin_ms); SCALAR(window_seq);
            SCALAR(address_capacity); SCALAR(reports_seen); SCALAR(reports_aggregated);
            SCALAR(aggregation_drops); SCALAR(adv); SCALAR(scan_responses);
            SCALAR(rssi_samples); SCALAR(rssi_min); SCALAR(rssi_max); SCALAR(rssi_sum);
            SCALAR(address_overflow); SCALAR(raw_enabled); SCALAR(summary_drops);
            SCALAR(selected); SCALAR(intentional); SCALAR(pressure); SCALAR(raw_drops);
            SCALAR(address_count); SCALAR(raw_count);
#undef SCALAR
            assert(view.addresses == original.addresses && view.raw == original.raw);
            uint32_t wrapper_seq = 10, view_seq = 10;
            cp_codec_t wrapper = context(&wrapper_seq), reader = context(&view_seq);
            wrapper.sink = reader.sink = view_sink;
            /* Existing lifetime losses must not be counted a second time. */
            wrapper.raw_dropped = reader.raw_dropped = 19;
            uint32_t duration = variant == 2 ? 999 : 30000;
            view_reject_raw = variant == 1;
            view_compare = view_saw_aggregate = false;
            view_offset = view_calls = uuid_counter = 0;
            reset(variant == 5 ? 1 : 0); /* Fail raw allocation before aggregate work. */
            bool wrapper_ok = cp_codec_window(&wrapper, &w, duration);
            unsigned wrapper_calls = view_calls;
            view_length = view_offset;
            view_compare = true;
            view_saw_aggregate = false;
            view_offset = view_calls = uuid_counter = 0;
            reset(variant == 5 ? 1 : 0);
            bool view_ok = cp_codec_encode_window_view(&reader, &view, duration);
            assert(wrapper_ok == view_ok && view_seq == wrapper_seq);
            assert(view_offset == view_length && view_calls == wrapper_calls);
            assert_codec_losses_equal(&wrapper, &reader);
            assert(!memcmp(&view, &saved_view, sizeof view));
            assert(record_hash(&original, sizeof original) == original_hash);
            assert(!memcmp(w.addresses, original.addresses, sizeof w.addresses));
            assert(!memcmp(w.raw, original.raw, sizeof w.raw));
            assert(w.raw_count == 0 && original.raw_count == CP_COLLECT_RAW);
            assert(w.raw_drops == original.raw_drops + (reader.raw_dropped - 19));
            if (variant == 1 || variant >= 4)
                assert(reader.raw_dropped == 23 && reader.windows_committed == 1);
            if (variant == 2 || variant == 3)
                assert(!view_ok && reader.raw_committed == CP_COLLECT_RAW &&
                       reader.windows_dropped == 1 && reader.summaries_dropped == capacity);
            assert(!live_allocations);
        }
    }
    view_compare = false;
}
static void invalid_window_views(void) {
    cp_collect_t w = window();
    const cp_collect_t original = w;
    for (unsigned variant = 0; variant < 9; ++variant) {
        cp_codec_window_view_t view = cp_codec_window_from_collect(&w);
        uint32_t seq = 0, duration = 30000;
        cp_codec_t c = context(&seq);
        c.sink = view_sink;
        if (variant == 0) view.addresses = NULL;
        if (variant == 1) view.raw = NULL;
        if (variant == 2) view.address_count = CP_COLLECT_ADDRESSES + 1;
        if (variant == 3) view.raw_count = CP_COLLECT_RAW + 1;
        if (variant == 4) view.bin_ms = 0;
        if (variant == 5) duration = view.window_ms + 1;
        if (variant == 6) view.bin_ms = 1;
        if (variant == 7) { view.window_ms = UINT32_MAX; duration = UINT32_MAX; }
        if (variant == 8) c.summary_sequence = NULL;
        view_calls = 0;
        reset(0);
        assert(!cp_codec_encode_window_view(&c, &view, duration));
        assert(!view_calls && !allocation_calls && !c.failed_items && !seq);
        assert(!memcmp(&w, &original, sizeof w));
    }
    uint32_t seq = 0;
    cp_codec_t c = context(&seq);
    w.raw_count = CP_COLLECT_RAW + 1;
    assert(!cp_codec_window(&c, &w, 30000));
    assert(w.raw_count == CP_COLLECT_RAW + 1 && w.raw_drops == original.raw_drops);
    assert(!cp_codec_encode_window_view(NULL, NULL, 0));
    const cp_codec_window_view_t empty = cp_codec_window_from_collect(NULL);
    assert(!empty.addresses && !empty.raw && !empty.address_count && !empty.raw_count);
    /* Empty borrowed arrays are valid and must never be dereferenced. */
    cp_codec_window_view_t no_records = cp_codec_window_from_collect(&original);
    no_records.addresses = NULL; no_records.raw = NULL;
    no_records.address_count = no_records.raw_count = 0;
    c.sink = view_sink;
    view_offset = 0;
    view_reject_raw = false;
    assert(cp_codec_encode_window_view(&c, &no_records, 30000));
    assert(c.windows_committed == 1 && !c.raw_dropped);
}
static void compact_window_views(void) {
    const unsigned bin_counts[] = {1, 6, 16};
    for (unsigned b = 0; b < sizeof bin_counts / sizeof bin_counts[0]; ++b) {
        unsigned bin_count = bin_counts[b];
        /* Exact heap allocations make ASan catch even a one-bin overread. */
        cp_address_core_t *cores = calloc(CP_COLLECT_ADDRESSES, sizeof *cores);
        uint32_t *bins = calloc(CP_COLLECT_ADDRESSES * bin_count, sizeof *bins);
        assert(cores && bins);
        for (unsigned variant = 0; variant < 7; ++variant) {
            cp_collect_t legacy;
            unsigned window_ms = bin_count * 5000u;
            assert(cp_collect_begin(&legacy, 1000, window_ms, 5000, 9, 64, true));
            cp_collect_compact_t compact = {.addresses = cores, .bins = bins,
                .storage_capacity = CP_COLLECT_ADDRESSES, .bin_count = bin_count};
            assert(cp_collect_compact_begin(&compact, 1000, window_ms, 5000, 9, 64, true));
            for (unsigned i = 0; i < CP_COLLECT_ADDRESSES; ++i) {
                /* Put observations in every bin, including the final one. */
                for (unsigned k = 0; k < bin_count; ++k) {
                    cp_report_t report = {.mono_ms = 1001 + k * 5000u + i,
                        .report_seq = i * bin_count + k + 1,
                        .address = {2, 0, 0, 0, 0, (uint8_t)i}, .address_type = 1,
                        .rssi = -60, .payload_length = 3, .payload = {2, 1, 6},
                        .raw = i == 0 && k < CP_COLLECT_RAW ? CP_RAW_SELECTED : CP_RAW_INTENTIONAL};
                    assert(cp_collect_observe(&legacy, &report));
                    assert(cp_collect_compact_observe(&compact, &report));
                }
            }
            legacy.summary_drops = compact.summary_drops = 3;
            legacy.raw_drops = compact.raw_drops = 7;
            if (variant == 3) legacy.addresses[0].last_ms = cores[0].last_ms = window_ms;
            if (variant == 4) legacy.raw[0].payload_length = compact.raw[0].payload_length = 32;
            if (variant == 6) {
                legacy.addresses[0].vehicle_evidence.parsed_reports++;
                cores[0].vehicle_evidence.parsed_reports++;
            }
            assert(!memcmp(&legacy.state, &compact.state, sizeof legacy.state));
            assert(!memcmp(legacy.raw, compact.raw, sizeof legacy.raw));
            for (unsigned i = 0; i < CP_COLLECT_ADDRESSES; ++i) {
                assert(!memcmp(&cores[i], &legacy.addresses[i].core, sizeof *cores));
                assert(!memcmp(bins + i * bin_count, legacy.addresses[i].bins,
                               bin_count * sizeof *bins));
            }
            const cp_codec_window_view_t view = cp_codec_window_from_compact(&compact);
            assert(!view.addresses && view.cores == cores && view.bins == bins &&
                   view.bin_count == bin_count && view.raw == compact.raw);
            const cp_collect_compact_t saved = compact;
            const cp_codec_window_view_t saved_view = view;
            uint64_t cores_hash = record_hash(cores, CP_COLLECT_ADDRESSES * sizeof *cores);
            uint64_t bins_hash = record_hash(bins, CP_COLLECT_ADDRESSES * bin_count * sizeof *bins);
            uint32_t legacy_seq = 10, compact_seq = 10;
            cp_codec_t writer = context(&legacy_seq), reader = context(&compact_seq);
            writer.sink = reader.sink = view_sink;
            writer.raw_dropped = reader.raw_dropped = 19;
            uint32_t duration = variant == 2 ? 999 : window_ms;
            view_reject_raw = variant == 1;
            view_compare = view_saw_aggregate = false;
            view_offset = view_calls = uuid_counter = 0;
            reset(variant == 5 ? 1 : 0);
            bool legacy_ok = cp_codec_window(&writer, &legacy, duration);
            unsigned legacy_calls = view_calls;
            view_length = view_offset;
            view_compare = true;
            view_saw_aggregate = false;
            view_offset = view_calls = uuid_counter = 0;
            reset(variant == 5 ? 1 : 0);
            bool compact_ok = cp_codec_encode_window_view(&reader, &view, duration);
            assert(legacy_ok == compact_ok && legacy_seq == compact_seq);
            assert(view_calls == legacy_calls && view_offset == view_length);
            assert_codec_losses_equal(&writer, &reader);
            assert(!memcmp(&compact, &saved, sizeof compact));
            assert(!memcmp(&view, &saved_view, sizeof view));
            assert(record_hash(cores, CP_COLLECT_ADDRESSES * sizeof *cores) == cores_hash);
            assert(record_hash(bins, CP_COLLECT_ADDRESSES * bin_count * sizeof *bins) == bins_hash);
            assert(!live_allocations);
        }
        /* Malformed storage descriptions fail before raw or allocation work. */
        cp_collect_compact_t compact = {.start_ms = 1000, .window_ms = bin_count * 5000u,
            .bin_ms = 5000, .address_capacity = 64, .address_count = 64,
            .addresses = cores, .bins = bins, .bin_count = bin_count};
        for (unsigned variant = 0; variant < 6; ++variant) {
            cp_codec_window_view_t view = cp_codec_window_from_compact(&compact);
            cp_address_summary_t dummy = {0};
            if (variant == 0) view.cores = NULL;
            if (variant == 1) view.bins = NULL;
            if (variant == 2) view.bin_count--;
            if (variant == 3) view.bin_count = CP_COLLECT_BINS + 1;
            if (variant == 4) view.addresses = &dummy;
            if (variant == 5) view.raw_count = 1, view.raw = NULL;
            uint32_t seq = 0;
            cp_codec_t reader = context(&seq);
            reader.sink = view_sink;
            view_calls = 0;
            reset(0);
            assert(!cp_codec_encode_window_view(&reader, &view, compact.window_ms));
            assert(!view_calls && !allocation_calls && !reader.failed_items && !seq);
        }
        free(bins);
        free(cores);
    }
    const cp_codec_window_view_t empty = cp_codec_window_from_compact(NULL);
    assert(!empty.addresses && !empty.cores && !empty.bins && !empty.bin_count && !empty.raw);
    view_compare = false;
}
int main(void) {
    cJSON_Hooks hooks = {.malloc_fn = checked_malloc, .free_fn = checked_free};
    cJSON_InitHooks(&hooks);
    size_t batches = run(false, 0, 16), health = run(true, 0, 16);
    for (size_t n = 1; n <= batches; n++)
        (void)run(false, n, 16);
    for (size_t n = 1; n <= health; n++)
        (void)run(true, n, 16);
    (void)run(false, 0, 1);
    clocks();
    packed_summaries();
    invalid_vehicle_evidence();
    short_windows();
    invalid_partial_boundaries();
    recovered_unknown_metadata();
    memory_pause_status();
    window_views();
    invalid_window_views();
    compact_window_views();
    cJSON_InitHooks(NULL);
    printf("Codec OOM checks: %zu window/raw/summary allocation sites, %zu status sites; valid "
           "sinks, exact loss accounting, zero leaks, aged clocks, read-only legacy/compact "
           "64-address views at 1/6/16 bins: PASS\n",
           batches, health);
    return 0;
}
