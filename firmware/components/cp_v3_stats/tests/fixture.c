#include "cp_v3_stats.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct { unsigned allocations, releases; size_t bytes; bool fail; } allocator_t;
static void *allocate(void *context, size_t bytes) {
    allocator_t *a = context; ++a->allocations; a->bytes = bytes;
    return a->fail ? NULL : malloc(bytes);
}
static void release(void *context, void *memory) {
    allocator_t *a = context; ++a->releases;
    /* Destructor removes all private key bytes before returning storage. */
    for (size_t i = 0; i < a->bytes; ++i) assert(((uint8_t *)memory)[i] == 0);
    free(memory);
}
static cp_v3_stats_config_t config(uint16_t capacity, uint32_t window) {
    return (cp_v3_stats_config_t){.capacity = capacity, .window_ms = window, .bin_ms = 5000,
        .rules_version = CP_V3_STATS_RULESET};
}
static cp_v3_stats_report_t report(unsigned id, uint64_t at, uint64_t sequence) {
    cp_v3_stats_report_t r = {.mono_us = at, .seq = sequence, .rssi = -70};
    r.address[0] = (uint8_t)id; r.address[1] = (uint8_t)(id >> 8); r.address[2] = 0xab;
    return r;
}
static void source(cp_v3_stats_t *s, uint64_t seen, uint64_t callback, uint64_t processing) {
    assert(cp_v3_stats_set_source(s, (cp_v3_stats_source_t){.reports_seen_known = true,
        .queue_drops_known = true, .processing_losses_known = true, .reports_seen = seen,
        .queue_drops = callback, .processing_losses = processing}));
}
static void conserved(const cp_v3_stats_snapshot_t *s) {
    unsigned categories = 0;
    for (unsigned i = 0; i < CP_V3_STATS_CLASS_COUNT; ++i) categories += s->counts[i];
    assert(categories == s->unique_keys && s->counts[CP_V3_STATS_UNKNOWN] == s->unique_keys);
    assert(!s->estimated_total_available && !s->rules_verified && s->verified_keys == 0);
    assert(s->adv_reports + s->scan_response_reports == s->worker_reports);
    uint64_t reports = 0, samples = 0; int64_t sum = 0; unsigned heat = 0;
    for (unsigned i = 0; i < s->bin_count; ++i) {
        assert(s->bins[i].unique_keys <= s->capacity);
        reports += s->bins[i].reports; samples += s->bins[i].rssi_samples; sum += s->bins[i].rssi_sum;
        heat += s->bins[i].unique_keys;
    }
    assert(reports == s->worker_reports && samples == s->rssi_samples && sum == s->rssi_sum && heat == s->heat_total);
    assert(!strcmp(s->extractor_version, "cp-v3-stats/1") && !strcmp(s->rules_version, "unclassified-v1"));
}
static cp_v3_stats_verdict_t forbidden_classifier(void *ctx, const cp_v3_stats_report_t *r) {
    (void)ctx; (void)r; assert(false); /* Must never be called by initial ruleset. */
    return (cp_v3_stats_verdict_t){.category = CP_V3_STATS_PHONE_RELATED, .strength = CP_V3_STATS_VERIFIED,
        .evidence = CP_V3_STATS_HINT_COMPANY | CP_V3_STATS_HINT_OUI | CP_V3_STATS_PROTOCOL, .rule_id = 1};
}
static void allocation_and_rules(void) {
    assert(!cp_v3_stats_memory_bytes(0) && !cp_v3_stats_memory_bytes(513));
    assert(cp_v3_stats_hash_slots(512) == 1024 && cp_v3_stats_memory_bytes(512) > cp_v3_stats_memory_bytes(256));
    allocator_t a = {0}; cp_v3_stats_config_t c = config(512, 60000);
    cp_v3_stats_t *s = cp_v3_stats_alloc(&c, allocate, release, &a); assert(s && a.bytes == cp_v3_stats_memory_bytes(512));
    assert(cp_v3_stats_begin(s, 1000000));
    cp_v3_stats_report_t r = report(1, 1000000, 1); assert(cp_v3_stats_observe(s, &r) == CP_V3_STATS_OK);
    cp_v3_stats_free(s); assert(a.allocations == 1 && a.releases == 1);
    a.fail = true; assert(!cp_v3_stats_alloc(&c, allocate, release, &a)); assert(a.releases == 1);
    void *memory = malloc(cp_v3_stats_memory_bytes(512) + cp_v3_stats_memory_alignment()); assert(memory);
    assert(!cp_v3_stats_init((uint8_t *)memory + 1, cp_v3_stats_memory_bytes(512), &c));
    assert(!cp_v3_stats_init(memory, cp_v3_stats_memory_bytes(512) - 1, &c));
    c.classify = forbidden_classifier;
    assert(!cp_v3_stats_init(memory, cp_v3_stats_memory_bytes(512), &c));
    c.classify = NULL; c.rules_verified = true; assert(!cp_v3_stats_init(memory, cp_v3_stats_memory_bytes(512), &c));
    c.rules_verified = false; c.rules_version = "appearance-phone-v1"; assert(!cp_v3_stats_init(memory, cp_v3_stats_memory_bytes(512), &c));
    free(memory);
}
static void capacity_512(void) {
    allocator_t a = {0}; cp_v3_stats_config_t c = config(512, 60000);
    cp_v3_stats_t *s = cp_v3_stats_alloc(&c, allocate, release, &a); assert(s);
    assert(cp_v3_stats_begin(s, 1000000) && cp_v3_stats_scan_state(s, 1000000, true) && cp_v3_stats_set_clock_usable(s, true));
    for (unsigned i = 0; i < 512; ++i) {
        cp_v3_stats_report_t r = report(i, 1000000 + i, i + 1);
        assert(cp_v3_stats_observe(s, &r) == CP_V3_STATS_OK);
    }
    cp_v3_stats_report_t r = report(511, 1001000, 513);
    assert(cp_v3_stats_observe(s, &r) == CP_V3_STATS_OK);
    r = report(512, 1002000, 514); assert(cp_v3_stats_observe(s, &r) == CP_V3_STATS_ADDRESS_FULL);
    source(s, 514, 0, 0); cp_v3_stats_snapshot_t out;
    assert(cp_v3_stats_snapshot(s, 61000000, &out)); conserved(&out);
    assert(out.capacity == 512 && out.unique_keys == 512 && out.counts[CP_V3_STATS_UNKNOWN] == 512);
    assert(out.bins[0].unique_keys == 512 && out.worker_reports == 514 && out.rssi_samples == 514);
    assert(out.address_overflow_reports == 1 && out.quality_mask == 8 && out.source_consistent);
    cp_v3_stats_free(s);
}
static void aggregates_and_snapshot_history(void) {
    allocator_t a = {0}; unsigned external_history = 42; cp_v3_stats_config_t c = config(16, 60000);
    c.classify_context = &external_history;
    cp_v3_stats_t *s = cp_v3_stats_alloc(&c, allocate, release, &a); assert(s);
    uint64_t start = 1000000;
    assert(cp_v3_stats_begin(s, start) && cp_v3_stats_scan_state(s, start, true) && cp_v3_stats_set_clock_usable(s, true));
    cp_v3_stats_report_t r = report(1, start, 1); r.rssi = -80; assert(cp_v3_stats_observe(s, &r) == CP_V3_STATS_OK);
    r = report(1, start + 1000, 2); r.rssi = -60; r.event_type = 4; assert(cp_v3_stats_observe(s, &r) == CP_V3_STATS_OK);
    r = report(2, start + 5000000, 4); r.rssi = 127; assert(cp_v3_stats_observe(s, &r) == CP_V3_STATS_OK);
    r = report(1, start + 10000000, 5); assert(cp_v3_stats_observe(s, &r) == CP_V3_STATS_OK);
    r = report(2, start + 59999000, 6); r.rssi = 20; r.kind = 1; r.props = 8; assert(cp_v3_stats_observe(s, &r) == CP_V3_STATS_OK);
    source(s, 6, 1, 0); cp_v3_stats_snapshot_t one, two;
    assert(cp_v3_stats_snapshot(s, start + 60000000, &one));
    assert(cp_v3_stats_snapshot(s, start + 60000000, &two) && !memcmp(&one, &two, sizeof one)); conserved(&one);
    assert(one.worker_reports == 5 && one.received_reports == 6 && one.adv_reports == 3 && one.scan_response_reports == 2);
    assert(one.rssi_samples == 4 && one.rssi_sum == -190 && one.rssi_min == -80 && one.rssi_max == 20);
    assert(one.unique_keys == 2 && one.heat_total == 4 && one.bins[0].reports == 2 && one.bins[0].unique_keys == 1);
    assert(one.forward_sequence_gaps == 1 && one.max_report_gap_us == 49999000 && one.trailing_gap_us == 1000);
    assert(one.scan_coverage_ms == 60000 && one.quality_mask == 16 && one.source_consistent && external_history == 42);
    assert(cp_v3_stats_begin(s, start + 60000000) && external_history == 42);
    assert(cp_v3_stats_snapshot(s, start + 60000000, &two) && two.unique_keys == 0);
    cp_v3_stats_free(s); assert(external_history == 42);
}
static void coverage_and_partial(void) {
    allocator_t a = {0}; cp_v3_stats_config_t c = config(16, 30000);
    cp_v3_stats_t *s = cp_v3_stats_alloc(&c, allocate, release, &a); assert(s && cp_v3_stats_begin(s, 0));
    assert(cp_v3_stats_scan_state(s, 5000000, true));
    assert(cp_v3_stats_scan_state(s, 12000000, false));
    assert(cp_v3_stats_scan_state(s, 20000000, true));
    source(s, 0, 0, 0); cp_v3_stats_snapshot_t out;
    assert(cp_v3_stats_snapshot(s, 30000000, &out)); conserved(&out);
    assert(out.scan_active_us == 17000000 && out.scan_paused_us == 8000000 && out.scan_unknown_us == 5000000);
    assert(out.scan_coverage_ms == 17000 && out.scan_gap_bins == 13 && out.empty_report_bins == 63 && out.quality_mask == 6);
    assert(cp_v3_stats_snapshot(s, 25000000, &out) && out.duration_ms == 25000 && out.bin_count == 5 && !out.window_closed && out.quality_mask == 7);
    assert(!cp_v3_stats_scan_state(s, 19000000, false));
    assert(cp_v3_stats_snapshot(s, 30000000, &out) && out.coverage_regressions == 1 && out.scan_active_us == 0 && out.scan_unknown_us == 30000000);
    cp_v3_stats_free(s);
}
static void malformed_fragments_and_unknown(void) {
    allocator_t a = {0}; cp_v3_stats_config_t c = config(4, 30000);
    cp_v3_stats_t *s = cp_v3_stats_alloc(&c, allocate, release, &a); assert(s && cp_v3_stats_begin(s, 1000));
    const uint8_t malformed[] = {3,255,76,0,5,255,76};
    cp_v3_stats_report_t r = report(1, 1000, 1); r.payload = malformed; r.length = sizeof malformed;
    assert(cp_v3_stats_observe(s, &r) == CP_V3_STATS_BAD_AD);
    for (unsigned status = 1; status <= 3; ++status) {
        r.mono_us++; r.seq++; r.kind = 1; r.data_status = (uint8_t)status;
        assert(cp_v3_stats_observe(s, &r) == CP_V3_STATS_UNSUPPORTED_REPORT);
    }
    uint8_t extended[1650] = {40,9}; memset(extended + 2, 'n', 39);
    extended[41] = 3; extended[42] = 255; extended[43] = 76;
    extended[45] = 3; extended[46] = 25; extended[47] = 64; /* Phone Appearance+company alone remainsunknown. */
    r.mono_us++; r.seq++; r.payload = extended; r.length = sizeof extended; r.data_status = 0;
    assert(cp_v3_stats_observe(s, &r) == CP_V3_STATS_OK);
    r.address_type = 1; r.mono_us++; r.seq++; assert(cp_v3_stats_observe(s, &r) == CP_V3_STATS_OK);
    r.length = 1651; r.mono_us++; r.seq++; assert(cp_v3_stats_observe(s, &r) == CP_V3_STATS_UNSUPPORTED_REPORT);
    const uint8_t conflicting_hints[] = {3,255,76,0,3,255,32,0,3,25,64,0,3,25,192,3};
    r.payload = conflicting_hints; r.length = sizeof conflicting_hints; r.kind = 0; r.mono_us++; r.seq++;
    assert(cp_v3_stats_observe(s, &r) == CP_V3_STATS_OK);
    source(s, 8, 0, 0); cp_v3_stats_snapshot_t out;
    assert(cp_v3_stats_snapshot(s, 30001000, &out)); conserved(&out);
    assert(out.unique_keys == 2 && out.malformed_reports == 1 && out.unsupported_reports == 4);
    assert(out.fragment_more_reports == 1 && out.truncated_reports == 1 && out.unknown_status_reports == 1);
    assert(out.counts[CP_V3_STATS_UNKNOWN] == 2 && !out.counts[CP_V3_STATS_PHONE_RELATED] && !out.counts[CP_V3_STATS_CONFLICTING]);
    cp_v3_stats_free(s);
}
static void time_and_processing(void) {
    allocator_t a = {0}; cp_v3_stats_config_t c = config(16, 30000);
    cp_v3_stats_t *s = cp_v3_stats_alloc(&c, allocate, release, &a); assert(s && cp_v3_stats_begin(s, 1000));
    cp_v3_stats_report_t r = report(1, 999, 1); assert(cp_v3_stats_observe(s, &r) == CP_V3_STATS_OUTSIDE_WINDOW);
    r.mono_us = 30001000; assert(cp_v3_stats_observe(s, &r) == CP_V3_STATS_OUTSIDE_WINDOW);
    r.mono_us = 1001; r.kind = 2; assert(cp_v3_stats_observe(s, &r) == CP_V3_STATS_INVALID);
    r.kind = 0; r.mono_us = 1010; r.seq = 1; assert(cp_v3_stats_observe(s, &r) == CP_V3_STATS_OK);
    r.mono_us = 1030; r.seq = 3; assert(cp_v3_stats_observe(s, &r) == CP_V3_STATS_OK);
    r.mono_us = 1020; r.seq = 2; assert(cp_v3_stats_observe(s, &r) == CP_V3_STATS_OK);
    source(s, 4, 0, 0); cp_v3_stats_snapshot_t out;
    assert(!cp_v3_stats_snapshot(s, 1025, &out));
    assert(cp_v3_stats_snapshot(s, 30001000, &out)); conserved(&out);
    assert(out.outside_window_reports == 2 && out.aggregation_drops == 1 && out.source_consistent && (out.quality_mask & 32));
    assert(out.regressing_sequences == 1 && out.out_of_order_reports == 1 && !out.report_gaps_known);
    assert(cp_v3_stats_set_source(s, (cp_v3_stats_source_t){0}));
    assert(cp_v3_stats_snapshot(s, 30001000, &out) && !out.source_consistent && !out.received_reports_known);
    cp_v3_stats_free(s);
}
int main(void) {
    allocation_and_rules(); capacity_512(); aggregates_and_snapshot_history(); coverage_and_partial();
    malformed_fragments_and_unknown(); time_and_processing();
    printf("Small statistics: conservation,512capacity,heat/RSSI,gaps,losses,AD/fragment and unclassified rules passed; bytes512=%zu\n", cp_v3_stats_memory_bytes(512));
    return 0;
}
