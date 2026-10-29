/* Allocation budgets and byte compatibility use the pinned production cJSON.
 * Counts are requested host bytes, not a physical ESP heap measurement. */
#include "cJSON.h"
#include "cp_codec.h"
#include <assert.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef union { max_align_t alignment; size_t bytes; } allocation_t;
static size_t live_bytes, peak_bytes, live_count, largest_request;
static unsigned bodies, items_seen;
static const char *expected_body;
static bool require_single_body = true;

static void *tracked_malloc(size_t bytes) {
    allocation_t *a = malloc(sizeof *a + bytes);
    if (!a) return NULL;
    a->bytes = bytes;
    live_bytes += bytes;
    ++live_count;
    if (live_bytes > peak_bytes) peak_bytes = live_bytes;
    if (bytes > largest_request) largest_request = bytes;
    return a + 1;
}
static void tracked_free(void *pointer) {
    if (!pointer) return;
    allocation_t *a = (allocation_t *)pointer - 1;
    assert(live_count && live_bytes >= a->bytes);
    --live_count;
    live_bytes -= a->bytes;
    free(a);
}
static void uuid(char out[37]) {
    memcpy(out, "00000000-0000-4000-8000-000000000001", 37);
}
static bool sink(void *context, const char *body, size_t length, const char *stream,
                 unsigned count, bool control) {
    (void)stream;
    (void)control;
    const unsigned *limit = context;
    assert(length == strlen(body) && length <= *limit);
    if (require_single_body) {
        /* The sink may itself need memory for Flash/accounting. None of the
         * hundreds of construction nodes or keys may still be retained. */
        assert(live_count == 1 && live_bytes <= (size_t)*limit + 5u);
    }
    if (expected_body) assert(!strcmp(body, expected_body));
    ++bodies;
    items_seen += count;
    return true;
}
static cp_codec_t context(unsigned *limit, uint32_t *sequence) {
    return (cp_codec_t){
        .node_id = "node", .boot_id = "boot", .placement_id = "place",
        .config_id = "config", .dataset = "demo", .firmware_version = "test",
        .max_items = 64, .max_body_bytes = *limit, .summary_sequence = sequence,
        .uuid = uuid, .sink = sink, .sink_context = limit
    };
}
static void reset(void) {
    assert(!live_bytes && !live_count);
    peak_bytes = largest_request = bodies = items_seen = 0;
}
static bool emit_dynamic_keys(unsigned limit) {
    uint32_t sequence = 0;
    cp_codec_t c = context(&limit, &sequence);
    cJSON *items = cp_codec_begin_items(&c, 1);
    cJSON *item = cp_codec_object(&c, items, NULL);
    char known[] = "seq", unknown[] = "mutable_key", value[] = "copy\nvalue";
    cp_codec_number(&c, item, known, 7);
    cp_codec_string(&c, item, unknown, value);
    memset(known, 'x', sizeof known - 1);
    memset(unknown, 'x', sizeof unknown - 1);
    memset(value, 'x', sizeof value - 1);
    cp_codec_number(&c, item, "duration_ms", 123);
    bool ok = cp_codec_emit_items(&c, "address_summaries", items, false);
    assert(c.failed_batches == (ok ? 0u : 1u));
    assert(c.failed_items == (ok ? 0u : 1u));
    assert(!live_bytes && !live_count);
    return ok;
}
static void exact_body_and_limit(void) {
    expected_body = "{\"protocol\":\"campuspulse/2\",\"node_id\":\"node\","
        "\"boot_id\":\"boot\",\"placement_id\":\"place\",\"capture_config_id\":\"config\","
        "\"dataset\":\"demo\",\"firmware_version\":\"test\","
        "\"batch_id\":\"00000000-0000-4000-8000-000000000001\","
        "\"stream\":\"address_summaries\",\"items\":[{\"seq\":7,"
        "\"mutable_key\":\"copy\\nvalue\",\"duration_ms\":123}]}";
    reset();
    assert(emit_dynamic_keys(8192));
    assert(bodies == 1);
    unsigned exact = (unsigned)strlen(expected_body);
    reset();
    assert(emit_dynamic_keys(exact));
    assert(bodies == 1);
    if (require_single_body) assert(largest_request <= (size_t)exact + 5u);
    reset();
    assert(!emit_dynamic_keys(exact - 1));
    assert(!bodies);
    expected_body = NULL;
}
static void saturated_window(unsigned limit) {
    reset();
    uint32_t sequence = 0;
    cp_codec_t c = context(&limit, &sequence);
    char long_id[65];
    memset(long_id, 'a', sizeof long_id - 1);
    long_id[sizeof long_id - 1] = 0;
    c.config_id = c.placement_id = long_id;
    cp_collect_t w;
    assert(cp_collect_begin(&w, 1000, 30000, 2000, 1, 64, false));
    for (unsigned i = 0; i < 64; ++i) {
        cp_report_t r = {.mono_ms = 1001, .report_seq = i + 1,
            .address = {2, 0, 0, 0, 0, (uint8_t)i}, .address_type = 3, .rssi = -100};
        assert(cp_collect_observe(&w, &r));
        cp_address_summary_t *a = &w.addresses[i];
        a->reports = a->adv = a->samples = 60000000;
        a->rssi_sum = -1;
        a->rssi_min = -127;
        a->rssi_max = 126;
        a->last_ms = 29999;
        a->vehicle_evidence = (cp_vehicle_evidence_t){
            .parsed_reports = 30000000, .malformed_reports = 30000000,
            .name_brand_mask = CP_VEHICLE_NAME_MASK_ALL,
            .exclusion_mask = CP_VEHICLE_EXCLUSION_MASK_ALL,
            .ecosystem_mask = CP_VEHICLE_ECOSYSTEM_MASK_ALL};
        for (unsigned bin = 0; bin < 15; ++bin) a->bins[bin] = 4000000;
    }
    w.reports_seen = w.reports_aggregated = w.adv = w.rssi_samples = 3840000000u;
    assert(cp_codec_window(&c, &w, 30000));
    assert(c.summaries_committed == 64 && c.windows_committed == 1 && !c.failed_items);
    assert(items_seen == 65 && bodies < (limit == 4096 ? 23u : 12u));
    if (require_single_body) {
        assert(largest_request <= (size_t)limit + 5u);
        assert(peak_bytes < (limit == 4096 ? 10000u : 14u * 1024u));
    }
    printf("Bounded codec: body limit %u, requested host peak %zu B, largest request %zu B\n",
           limit, peak_bytes, largest_request);
    assert(!live_bytes && !live_count);
}
static void compact_window(unsigned capacity, unsigned bin_count, unsigned limit) {
    reset();
    uint32_t sequence = 0;
    cp_codec_t c = context(&limit, &sequence);
    cp_address_core_t *cores = calloc(capacity, sizeof *cores);
    uint32_t *bins = calloc(capacity * bin_count, sizeof *bins);
    assert(cores && bins);
    cp_collect_compact_t w = {.addresses = cores, .bins = bins,
        .storage_capacity = capacity, .bin_count = bin_count};
    assert(cp_collect_compact_begin(&w, 1000, bin_count * 5000u, 5000, 1, capacity, false));
    for (unsigned i = 0; i < capacity; ++i) {
        cp_report_t r = {.mono_ms = 1001, .report_seq = i + 1,
            .address = {2, 0, 0, 0, 0, (uint8_t)i}, .address_type = 3, .rssi = -100};
        assert(cp_collect_compact_observe(&w, &r));
    }
    cp_codec_window_view_t view = cp_codec_window_from_compact(&w);
    assert(cp_codec_encode_window_view(&c, &view, w.window_ms));
    assert(c.summaries_committed == capacity && c.windows_committed == 1 && !c.failed_items);
    assert(items_seen == capacity + 1 && bodies < capacity / 2);
    if (require_single_body) {
        assert(largest_request <= (size_t)limit + 5u);
        assert(peak_bytes < (limit == 4096 ? 10000u : 14u * 1024u));
    }
    assert(!live_bytes && !live_count);
    printf("Compact codec: %u addresses / %u bins / %u byte body, requested host JSON peak %zu B\n",
           capacity, bin_count, limit, peak_bytes);
    free(bins);
    free(cores);
}
int main(void) {
    cJSON_Hooks hooks = {.malloc_fn = tracked_malloc, .free_fn = tracked_free};
    cJSON_InitHooks(&hooks);
#ifdef CP_CODEC_MEMORY_BASELINE
    require_single_body = false;
#endif
    exact_body_and_limit();
    saturated_window(4096);
    saturated_window(8192);
    compact_window(64, 1, 8192);
    compact_window(64, 6, 8192);
    compact_window(64, 16, 8192);
    compact_window(128, 3, 4096);
    compact_window(128, 16, 4096);
    cJSON_InitHooks(NULL);
    puts("Codec exact bytes, dynamic-key ownership, body boundary and live allocation budgets: PASS");
    return 0;
}
