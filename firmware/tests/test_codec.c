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
    const unsigned durations[] = {1000, 5000, 5001};
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
    cJSON_InitHooks(NULL);
    printf("Codec OOM checks: %zu window/raw/summary allocation sites, %zu status sites; valid "
           "sinks, exact loss accounting, zero leaks, aged clocks: PASS\n",
           batches, health);
    return 0;
}
