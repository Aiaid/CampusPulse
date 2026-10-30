#pragma once
/* Synthetic saturated window shared by capacity and real-codec tests. */
#include "cp_collect.h"
#include <assert.h>
#include <stdlib.h>
#include <string.h>

static cp_report_t capacity_report(unsigned address, unsigned bin, unsigned sequence, unsigned bin_ms) {
    cp_report_t r = {.mono_ms = 1001u + bin * bin_ms, .report_seq = sequence,
        .address = {2, 0, 0, 0, (uint8_t)(address >> 8), (uint8_t)address},
        .address_type = 1, .report_type = bin % 4 == 1 ? 4 : 0, .rssi = -50};
    const uint8_t name[] = {5, 9, 'A', 'I', 'M', 'A'};
    memcpy(r.payload, name, sizeof name);
    r.payload_length = bin % 4 == 3 ? 2 : sizeof name; /* Four malformed AD reports. */
    return r;
}
static cp_collect_compact_t capacity_fixture_for(unsigned window_ms, unsigned bin_ms) {
    unsigned bin_count=cp_collect_bin_count(window_ms,bin_ms);assert(bin_count && bin_count%4==0);
    unsigned capacity = CP_COLLECT_ADDRESSES;
    cp_collect_compact_t w = {.storage_capacity = capacity, .bin_count = bin_count};
    w.addresses = calloc(capacity, sizeof *w.addresses);
    w.bins = calloc(capacity * w.bin_count, sizeof *w.bins);
    assert(w.addresses && w.bins);
    assert(cp_collect_compact_begin(&w, 1000, window_ms, bin_ms, 1, capacity, false));
    for (unsigned bin = 0; bin < bin_count; ++bin)
        for (unsigned i = 0; i < capacity; ++i) {
            cp_report_t r = capacity_report(i, bin, bin * capacity + i + 1, bin_ms);
            assert(cp_collect_compact_observe(&w, &r));
        }
    cp_report_t extra = capacity_report(capacity, bin_count-1, capacity * bin_count + 1, bin_ms);
    assert(cp_collect_compact_observe(&w, &extra)); /* New identifier overflows explicitly. */
    extra = capacity_report(0, bin_count-1, capacity * bin_count + 2, bin_ms);
    assert(cp_collect_compact_observe(&w, &extra)); /* Existing identifier remains aggregateable. */
    assert(w.address_count == capacity && w.address_overflow && w.summary_drops == 1);
    assert(w.reports_seen == capacity * bin_count + 2 && w.reports_aggregated == w.reports_seen);
    assert(!w.aggregation_drops && !w.raw_count && !w.raw_drops && !w.raw_enabled);
    assert(w.adv + w.scan_responses == w.reports_seen);
    for (unsigned i = 0; i < capacity; ++i) {
        cp_address_core_t *a = &w.addresses[i];
        assert(a->reports == (i ? bin_count : bin_count+1) && a->samples == a->reports);
        assert(a->scan_responses == bin_count/4 && a->adv == (i ? bin_count*3/4 : bin_count*3/4+1));
        assert(a->vehicle_evidence.parsed_reports == bin_count*3/4);
        assert(a->vehicle_evidence.malformed_reports == (i ? bin_count/4 : bin_count/4+1));
        assert(a->vehicle_evidence.name_brand_mask == (1u << CP_VEHICLE_NAME_AIMA));
        assert(!a->vehicle_evidence.exclusion_mask && !a->vehicle_evidence.ecosystem_mask);
        assert(a->first_ms == 1 && a->last_ms == (bin_count-1)*bin_ms+1);
        for (unsigned bin = 0; bin < bin_count; ++bin)
            assert(w.bins[i * bin_count + bin] == ((!i && bin == bin_count-1) ? 2u : 1u));
    }
    return w;
}

#define capacity_fixture() capacity_fixture_for(80000,5000)
