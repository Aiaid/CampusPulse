/* Offline synthetic inputs, actual production collector/codec/cJSON. No IO or
 * credentials. Requested host JSON allocations are not ESP32 heap measurements. */
#include "cJSON.h"
#include "cp_codec.h"
#include <assert.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef union { max_align_t alignment; size_t bytes; } allocation_t;
static size_t live, peak, largest;
static unsigned ids, bodies, stream_items[4], stream_batches[4];
static unsigned max_summary_items;
static size_t stream_bytes[4], body_sizes[256];
static unsigned case_addresses, case_seconds, case_hz, case_bin_seconds, body_limit = 8192;
static bool case_raw, emit_bodies, clock_known = true;
static void *allocate(size_t bytes) {
    allocation_t *a = malloc(sizeof *a + bytes);
    assert(a);
    a->bytes = bytes;
    live += bytes;
    if (live > peak) peak = live;
    if (bytes > largest) largest = bytes;
    return a + 1;
}
static void release(void *pointer) {
    if (!pointer) return;
    allocation_t *a = (allocation_t *)pointer - 1;
    assert(live >= a->bytes);
    live -= a->bytes;
    free(a);
}
static void uuid(char out[37]) {
    snprintf(out, 37, "22222222-2222-4222-8222-%012u", ++ids);
}
static bool sink(void *context, const char *body, size_t length, const char *stream,
                 unsigned count, bool control) {
    (void)context;
    (void)control;
    const char *names[] = {"ble_windows", "address_summaries", "ble_reports", "node_status"};
    unsigned index = 0;
    while (index < 4 && strcmp(stream, names[index])) ++index;
    assert(index < 4 && bodies < 256 && length == strlen(body) && length <= body_limit);
    /* Production codec must release the construction tree before durable IO. */
    assert(live <= body_limit + 5);
    if (emit_bodies) {
        fprintf(stderr, "{\"addresses\":%u,\"window_seconds\":%u,\"hz\":%u,\"raw\":%s,\"body\":",
            case_addresses, case_seconds, case_hz, case_raw ? "true" : "false");
        assert(fwrite(body, 1, length, stderr) == length);
        fputs("}\n", stderr);
    }
    body_sizes[bodies++] = length;
    stream_items[index] += count;
    if (index == 1 && count > max_summary_items) max_summary_items = count;
    stream_batches[index]++;
    stream_bytes[index] += length;
    return true;
}
static void run(unsigned addresses, unsigned seconds, unsigned bin_seconds, unsigned hz, bool raw) {
    assert(!live);
    peak = largest = bodies = ids = 0;
    max_summary_items = 0;
    case_addresses = addresses; case_seconds = seconds; case_hz = hz; case_raw = raw;
    case_bin_seconds = bin_seconds;
    memset(stream_items, 0, sizeof stream_items);
    memset(stream_batches, 0, sizeof stream_batches);
    memset(stream_bytes, 0, sizeof stream_bytes);
    cp_address_core_t cores[CP_COLLECT_ADDRESSES];
    uint32_t bins[CP_COLLECT_ADDRESSES * CP_COLLECT_BINS];
    cp_collect_compact_t w = {.addresses = cores, .bins = bins,
        .storage_capacity = CP_COLLECT_ADDRESSES, .bin_count = seconds / bin_seconds};
    const uint64_t start = 86400000;
    assert(cp_collect_compact_begin(&w, start, seconds * 1000, bin_seconds * 1000, 1000, addresses, raw));
    unsigned reports = 0;
    for (unsigned tick = 0; tick < seconds * hz; ++tick) {
        for (unsigned address = 0; address < addresses; ++address) {
            ++reports;
            cp_report_t r = {.mono_ms = start + tick * 1000 / hz,
                .report_seq = 1000000 + reports,
                .address = {2, 0, 0, 0, 0, (uint8_t)address}, .address_type = 1,
                .rssi = -65, .payload_length = 31,
                .raw = raw ? (reports <= 4 ? CP_RAW_SELECTED : CP_RAW_INTENTIONAL) : CP_RAW_OFF};
            /* Valid AD: flags, then a zero terminator. No live data or identity. */
            r.payload[0] = 2; r.payload[1] = 1; r.payload[2] = 6;
            assert(cp_collect_compact_observe(&w, &r));
        }
    }
    assert(w.address_count == addresses && w.reports_seen == reports &&
           !w.summary_drops && !w.raw_drops && !w.aggregation_drops);
    uint32_t sequence = 1000000;
    cp_codec_t codec = {.node_id = "cp_020000000001",
        .boot_id = "11111111-1111-4111-8111-111111111111",
        .placement_id = "33333333-3333-4333-8333-333333333333",
        .config_id = "44444444-4444-4444-8444-444444444444",
        .dataset = "field", .firmware_version = "mqtt-capacity-fixture",
        .max_items = 16, .max_body_bytes = body_limit,
        .clock_known = clock_known, .clock_mono_ms = start, .clock_utc_ms = 1793232000000ULL,
        .clock_epoch = 100, .uncertainty_ms = 100,
        .summary_sequence = &sequence, .uuid = uuid, .sink = sink};
    cp_codec_window_view_t view = cp_codec_window_from_compact(&w);
    assert(cp_codec_encode_window_view(&codec, &view, seconds * 1000));
    cp_codec_status_t status = {.mono_ms = start + seconds * 1000,
        .collecting = true, .connected = true, .raw_enabled = raw,
        .free_heap = 50000, .slots = 341, .free_slots = 341,
        .warn_pct = 60, .raw_pause_pct = 80, .critical_pct = 95};
    assert(cp_codec_status(&codec, &status, 1000000));
    assert(!live && !codec.failed_batches && !codec.failed_items &&
        codec.summaries_committed == addresses && codec.windows_committed == 1 &&
        codec.raw_committed == (raw ? 4u : 0u));
    assert(stream_items[1] == addresses && stream_batches[1] <= addresses && stream_batches[0] == 1 &&
           stream_batches[3] == 1 && stream_batches[2] == (raw ? 1u : 0u));
    printf("{\"addresses\":%u,\"window_seconds\":%u,\"bin_seconds\":%u,\"bin_count\":%u,"
        "\"compiled_address_limit\":%u,\"collector_static_core_c3_bytes\":%u,\"max_body_limit\":%u,"
        "\"reception_hz_per_address\":%u,"
        "\"raw\":%s,\"clock_known\":%s,\"reports\":%u,\"json_requested_host_peak\":%zu,"
        "\"json_largest_host_request\":%zu,\"max_summary_items_per_batch\":%u,\"stream_batches\":[",
        addresses, seconds, case_bin_seconds, seconds / case_bin_seconds,
        CP_COLLECT_ADDRESSES, CP_COLLECT_ADDRESSES * 2u * 64u, body_limit,
        hz, raw ? "true" : "false", clock_known ? "true" : "false", reports, peak, largest,
        max_summary_items);
    for (unsigned i = 0; i < 4; ++i) printf("%s%u", i ? "," : "", stream_batches[i]);
    printf("],\"stream_items\":[");
    for (unsigned i = 0; i < 4; ++i) printf("%s%u", i ? "," : "", stream_items[i]);
    printf("],\"stream_bytes\":[");
    for (unsigned i = 0; i < 4; ++i) printf("%s%zu", i ? "," : "", stream_bytes[i]);
    printf("],\"body_sizes\":[");
    for (unsigned i = 0; i < bodies; ++i) printf("%s%zu", i ? "," : "", body_sizes[i]);
    puts("]}");
}
int main(void) {
    emit_bodies = getenv("CP_CAPACITY_EMIT_BODIES") != NULL;
    clock_known = getenv("CP_CAPACITY_UNKNOWN_CLOCK") == NULL;
    cJSON_Hooks hooks = {.malloc_fn = allocate, .free_fn = release};
    cJSON_InitHooks(&hooks);
    const unsigned rates[] = {1, 2, 5, 10};
    const char *profile = getenv("CP_CAPACITY_PROFILE");
    if (profile && !strcmp(profile, "128-trial")) {
        const unsigned windows[] = {30, 60, 120}, bins[] = {10, 20, 40};
        body_limit = 4096;
        for (unsigned w = 0; w < 3; ++w)
            for (unsigned r = 0; r < 4; ++r) run(128, windows[w], bins[w], rates[r], false);
    } else {
        assert(!profile || !strcmp(profile, "legacy"));
        const unsigned capacities[] = {16, 32, 64}, windows[] = {10, 30, 60};
        for (unsigned a = 0; a < 3; ++a)
            for (unsigned w = 0; w < 3; ++w)
                for (unsigned r = 0; r < 4; ++r)
                    for (unsigned raw = 0; raw < 2; ++raw) run(capacities[a], windows[w], 5, rates[r], raw);
    }
    cp_collect_t rejected;
    assert(cp_collect_begin(&rejected, 0, 30000, 10000, 1, 128, false));
    assert(!cp_collect_begin(&rejected, 0, 30000, 10000, 1, 129, false));
    assert(!cp_collect_begin(&rejected, 0, 30000, 10000, 1, 256, false));
    cJSON_InitHooks(NULL);
    return 0;
}
