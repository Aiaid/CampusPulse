#include "cp_v3_stats.h"
#include <stdalign.h>
#include <limits.h>
#include <string.h>

#define MAGIC UINT32_C(0x53544154)
typedef struct {
    uint8_t address[6], address_type, flags;
    uint16_t bins;
    uint8_t verified_mask, candidate_mask; /* Reserved; unclassified-v1 stays0. */
    uint32_t reports;
} entry_t;
_Static_assert(sizeof(entry_t) == 16, "Address-entry budget changed");
struct cp_v3_stats {
    uint32_t magic;
    size_t memory_bytes;
    cp_v3_stats_config_t config;
    cp_v3_stats_release_fn release;
    void *allocator_context;
    entry_t *entries;
    uint16_t *hash;
    uint16_t slots;
    bool begun, scan_known, scanning, clock_usable, sequence_known;
    uint64_t coverage_cursor, last_sequence, internal_processing_losses;
    cp_v3_stats_snapshot_t window;
};
static size_t aligned(size_t value) {
    size_t alignment = alignof(max_align_t);
    return (value + alignment - 1) / alignment * alignment;
}
size_t cp_v3_stats_memory_alignment(void) { return alignof(max_align_t); }
uint16_t cp_v3_stats_hash_slots(uint16_t capacity) {
    if (!capacity || capacity > CP_V3_STATS_MAX_CAPACITY) return 0;
    uint16_t slots = 2;
    while (slots < (unsigned)capacity * 2u) slots = (uint16_t)(slots * 2u);
    return slots;
}
size_t cp_v3_stats_memory_bytes(uint16_t capacity) {
    uint16_t slots = cp_v3_stats_hash_slots(capacity);
    if (!slots) return 0;
    return aligned(aligned(sizeof(cp_v3_stats_t)) + (size_t)capacity * sizeof(entry_t)) + aligned((size_t)slots * sizeof(uint16_t));
}
static bool configuration(const cp_v3_stats_config_t *c) {
    return c && cp_v3_stats_memory_bytes(c->capacity) && c->window_ms && c->window_ms <= 60000 &&
        c->bin_ms >= 1000 && c->bin_ms <= c->window_ms && c->window_ms % c->bin_ms == 0 &&
        c->window_ms / c->bin_ms <= CP_V3_STATS_MAX_BINS && c->rules_version &&
        !strcmp(c->rules_version, CP_V3_STATS_RULESET) && !c->rules_verified && !c->classify;
}
cp_v3_stats_t *cp_v3_stats_init(void *memory, size_t bytes, const cp_v3_stats_config_t *config) {
    if (!memory || (uintptr_t)memory % cp_v3_stats_memory_alignment() || !configuration(config)) return NULL;
    size_t need = cp_v3_stats_memory_bytes(config->capacity);
    if (bytes < need) return NULL;
    memset(memory, 0, need);
    cp_v3_stats_t *s = memory;
    s->magic = MAGIC; s->memory_bytes = need; s->config = *config;
    s->config.rules_version = CP_V3_STATS_RULESET;
    s->slots = cp_v3_stats_hash_slots(config->capacity);
    s->entries = (entry_t *)((uint8_t *)memory + aligned(sizeof *s));
    s->hash = (uint16_t *)((uint8_t *)memory + aligned(aligned(sizeof *s) + (size_t)config->capacity * sizeof(entry_t)));
    return s;
}
cp_v3_stats_t *cp_v3_stats_alloc(const cp_v3_stats_config_t *config, cp_v3_stats_allocate_fn allocate,
    cp_v3_stats_release_fn release, void *context) {
    if (!configuration(config) || !allocate || !release) return NULL;
    size_t bytes = cp_v3_stats_memory_bytes(config->capacity);
    void *memory = allocate(context, bytes);
    if (!memory) return NULL;
    cp_v3_stats_t *s = cp_v3_stats_init(memory, bytes, config);
    if (!s) { release(context, memory); return NULL; }
    s->release = release; s->allocator_context = context;
    return s;
}
void cp_v3_stats_free(cp_v3_stats_t *s) {
    if (!s || s->magic != MAGIC) return;
    cp_v3_stats_release_fn release = s->release; void *context = s->allocator_context; size_t bytes = s->memory_bytes;
    volatile uint8_t *p = (volatile uint8_t *)s;
    for (size_t i = 0; i < bytes; ++i) p[i] = 0;
    if (release) release(context, s);
}
bool cp_v3_stats_begin(cp_v3_stats_t *s, uint64_t start) {
    if (!s || s->magic != MAGIC || start > UINT64_MAX - (uint64_t)s->config.window_ms * 1000u) return false;
    memset(s->entries, 0, (size_t)s->config.capacity * sizeof(entry_t));
    memset(s->hash, 0, (size_t)s->slots * sizeof(uint16_t));
    memset(&s->window, 0, sizeof s->window);
    s->window.capacity = s->config.capacity; s->window.window_ms = s->config.window_ms; s->window.bin_ms = s->config.bin_ms;
    s->window.configured_bins = (uint8_t)(s->config.window_ms / s->config.bin_ms);
    s->window.start_mono_us = start; s->window.end_mono_us = start + (uint64_t)s->config.window_ms * 1000u;
    s->window.report_gaps_known = true;
    strcpy(s->window.rules_version, CP_V3_STATS_RULESET); strcpy(s->window.extractor_version, CP_V3_STATS_VERSION);
    s->begun = true; s->scan_known = s->scanning = s->clock_usable = s->sequence_known = false;
    s->coverage_cursor = start; s->last_sequence = s->internal_processing_losses = 0;
    return true;
}
static void increment(cp_v3_stats_t *s, uint64_t *value) {
    if (*value == UINT64_MAX) s->window.counters_saturated = true;
    else ++*value;
}
static void rssi(cp_v3_stats_t *s, uint64_t *samples, int64_t *sum, int16_t *min, int16_t *max, int16_t value) {
    if (!*samples) *min = *max = value;
    else { if (value < *min) *min = value; if (value > *max) *max = value; }
    increment(s, samples);
    if (value > 0 && *sum > INT64_MAX - value) { *sum = INT64_MAX; s->window.counters_saturated = true; }
    else if (value < 0 && *sum < INT64_MIN - value) { *sum = INT64_MIN; s->window.counters_saturated = true; }
    else *sum += value;
}
static bool valid_ad(const uint8_t *data, size_t length) {
    for (size_t p = 0; p < length;) {
        size_t n = data[p];
        if (!n) { while (++p < length) if (data[p]) return false; return true; }
        if (n + 1 > length - p) return false;
        unsigned type = data[p + 1], bytes = (unsigned)n - 1;
        unsigned width = (type == 2 || type == 3 || type == 0x14) ? 2 :
            (type == 4 || type == 5 || type == 0x1f) ? 4 : (type == 6 || type == 7 || type == 0x15) ? 16 : 0;
        if ((width && bytes % width) || (type == 0xff && bytes < 2) || (type == 0x19 && bytes != 2) ||
            (type == 0x16 && bytes < 2) || (type == 0x20 && bytes < 4) || (type == 0x21 && bytes < 16)) return false;
        p += n + 1;
    }
    return true;
}
static uint32_t address_hash(const cp_v3_stats_report_t *r) {
    uint32_t h = UINT32_C(2166136261);
    for (unsigned i = 0; i < 6; ++i) h = (h ^ r->address[i]) * UINT32_C(16777619);
    return (h ^ r->address_type) * UINT32_C(16777619);
}
static entry_t *identifier(cp_v3_stats_t *s, const cp_v3_stats_report_t *r) {
    unsigned first = address_hash(r) & (s->slots - 1u);
    for (unsigned probe = 0; probe < s->slots; ++probe) {
        unsigned slot = (first + probe) & (s->slots - 1u);
        uint16_t stored = s->hash[slot];
        if (stored) {
            entry_t *e = &s->entries[stored - 1];
            if (e->address_type == r->address_type && !memcmp(e->address, r->address, 6)) return e;
        } else {
            if (s->window.unique_keys == s->config.capacity) return NULL;
            uint16_t index = s->window.unique_keys++;
            entry_t *e = &s->entries[index]; memcpy(e->address, r->address, 6); e->address_type = r->address_type;
            s->hash[slot] = (uint16_t)(index + 1u);
            return e;
        }
    }
    return NULL; /* Corruption defense; normal load is at most0.5. */
}
cp_v3_stats_result_t cp_v3_stats_observe(cp_v3_stats_t *s, const cp_v3_stats_report_t *r) {
    if (!s || s->magic != MAGIC || !s->begun || !r) return CP_V3_STATS_INVALID;
    if (r->mono_us < s->window.start_mono_us || r->mono_us >= s->window.end_mono_us) {
        increment(s, &s->window.outside_window_reports); return CP_V3_STATS_OUTSIDE_WINDOW;
    }
    if (r->kind > 1) { increment(s, &s->internal_processing_losses); return CP_V3_STATS_INVALID; }
    unsigned bin = (unsigned)((r->mono_us - s->window.start_mono_us) / ((uint64_t)s->config.bin_ms * 1000u));
    cp_v3_stats_bin_t *b = &s->window.bins[bin];
    if (!s->window.worker_reports) s->window.first_report_mono_us = s->window.last_report_mono_us = r->mono_us;
    else if (r->mono_us < s->window.last_report_mono_us) {
        increment(s, &s->window.out_of_order_reports); s->window.report_gaps_known = false;
        if (r->mono_us < s->window.first_report_mono_us) s->window.first_report_mono_us = r->mono_us;
    } else {
        uint64_t gap = r->mono_us - s->window.last_report_mono_us;
        if (gap > s->window.max_report_gap_us) s->window.max_report_gap_us = gap;
        s->window.last_report_mono_us = r->mono_us;
    }
    if (s->sequence_known) {
        if (r->seq == s->last_sequence) increment(s, &s->window.duplicate_sequences);
        else if (r->seq < s->last_sequence) { increment(s, &s->window.regressing_sequences); s->window.report_gaps_known = false; }
        else {
            uint64_t gaps = r->seq - s->last_sequence - 1u;
            if (UINT64_MAX - s->window.forward_sequence_gaps < gaps) s->window.counters_saturated = true;
            else s->window.forward_sequence_gaps += gaps;
        }
    }
    if (!s->sequence_known || r->seq > s->last_sequence) s->last_sequence = r->seq;
    s->sequence_known = true;
    increment(s, &s->window.worker_reports); increment(s, &b->reports);
    bool scan_response = r->kind ? (r->props & 8u) != 0 : r->event_type == 4;
    increment(s, scan_response ? &s->window.scan_response_reports : &s->window.adv_reports);
    if (r->rssi >= -127 && r->rssi <= 20) {
        rssi(s, &s->window.rssi_samples, &s->window.rssi_sum, &s->window.rssi_min, &s->window.rssi_max, r->rssi);
        rssi(s, &b->rssi_samples, &b->rssi_sum, &b->rssi_min, &b->rssi_max, r->rssi);
    } else increment(s, &s->window.rssi_unknown_reports);
    entry_t *e = identifier(s, r);
    bool overflow = e == NULL;
    if (overflow) increment(s, &s->window.address_overflow_reports);
    else {
        if (e->reports != UINT32_MAX) ++e->reports; else s->window.counters_saturated = true;
        uint16_t mask = (uint16_t)(1u << bin);
        if (!(e->bins & mask)) { e->bins |= mask; ++b->unique_keys; }
    }
    if (r->data_status == 1) increment(s, &s->window.fragment_more_reports);
    else if (r->data_status == 2) increment(s, &s->window.truncated_reports);
    else if (r->data_status) increment(s, &s->window.unknown_status_reports);
    if (r->data_status || r->length > CP_V3_STATS_PAYLOAD_MAX || (!r->kind && r->length > 31)) {
        increment(s, &s->window.unsupported_reports); return CP_V3_STATS_UNSUPPORTED_REPORT;
    }
    if ((!r->payload && r->length) || !valid_ad(r->payload, r->length)) {
        increment(s, &s->window.malformed_reports); return CP_V3_STATS_BAD_AD;
    }
    /* unclassified-v1: even valid company/OUI/Phone Appearance observations are
     * unknown. The future callback interface is deliberately not activated. */
    return overflow ? CP_V3_STATS_ADDRESS_FULL : CP_V3_STATS_OK;
}
static void coverage(cp_v3_stats_t *s, uint64_t from, uint64_t until, bool scanning) {
    uint64_t width = (uint64_t)s->config.bin_ms * 1000u;
    while (from < until) {
        unsigned bin = (unsigned)((from - s->window.start_mono_us) / width);
        uint64_t end = s->window.start_mono_us + (uint64_t)(bin + 1) * width;
        if (end > until) end = until;
        uint64_t *value = scanning ? &s->window.bins[bin].scan_active_us : &s->window.bins[bin].scan_paused_us;
        *value += end - from; from = end;
    }
}
bool cp_v3_stats_scan_state(cp_v3_stats_t *s, uint64_t timestamp, bool scanning) {
    if (!s || s->magic != MAGIC || !s->begun) return false;
    if (timestamp < s->window.start_mono_us && !s->scan_known) timestamp = s->window.start_mono_us;
    if (timestamp > s->window.end_mono_us) timestamp = s->window.end_mono_us;
    if (timestamp < s->coverage_cursor) { increment(s, &s->window.coverage_regressions); return false; }
    if (s->scan_known) coverage(s, s->coverage_cursor, timestamp, s->scanning);
    s->scan_known = true; s->scanning = scanning; s->coverage_cursor = timestamp;
    return true;
}
bool cp_v3_stats_set_source(cp_v3_stats_t *s, cp_v3_stats_source_t source) {
    if (!s || s->magic != MAGIC || !s->begun) return false;
    s->window.source = source; return true;
}
bool cp_v3_stats_set_clock_usable(cp_v3_stats_t *s, bool usable) {
    if (!s || s->magic != MAGIC || !s->begun) return false;
    s->clock_usable = usable; return true;
}
static bool add(uint64_t *to, uint64_t value) { if (UINT64_MAX - *to < value) return false; *to += value; return true; }
bool cp_v3_stats_snapshot(const cp_v3_stats_t *s, uint64_t now, cp_v3_stats_snapshot_t *out) {
    if (!s || s->magic != MAGIC || !s->begun || !out || now < s->window.start_mono_us) return false;
    uint64_t until = now > s->window.end_mono_us ? s->window.end_mono_us : now;
    if (until < s->coverage_cursor || (s->window.worker_reports && until < s->window.last_report_mono_us)) return false;
    *out = s->window; out->snapshot_mono_us = until;
    uint64_t elapsed = until - s->window.start_mono_us, width = (uint64_t)s->config.bin_ms * 1000u;
    out->duration_ms = (uint32_t)(elapsed / 1000u); out->window_closed = until == s->window.end_mono_us;
    out->bin_count = (uint8_t)((elapsed + width - 1) / width);
    out->counts[CP_V3_STATS_UNKNOWN] = out->unique_keys;
    out->received_reports_known = out->source.reports_seen_known;
    out->received_reports = out->received_reports_known ? out->source.reports_seen : 0;
    out->callback_drops_known = out->source.queue_drops_known;
    out->callback_drops = out->callback_drops_known ? out->source.queue_drops : 0;
    out->aggregation_drops_known = out->source.processing_losses_known;
    out->aggregation_drops = out->aggregation_drops_known ? out->source.processing_losses : 0;
    if (!add(&out->aggregation_drops, s->internal_processing_losses)) out->counters_saturated = true;
    for (unsigned i = 0; i < out->bin_count; ++i) {
        cp_v3_stats_bin_t *b = &out->bins[i];
        uint64_t start = out->start_mono_us + i * width, end = start + width;
        if (end > until) end = until;
        if (s->scan_known && s->coverage_cursor < end) {
            uint64_t from = s->coverage_cursor > start ? s->coverage_cursor : start;
            uint64_t *value = s->scanning ? &b->scan_active_us : &b->scan_paused_us;
            *value += end - from;
        }
        b->scan_unknown_us = end - start - b->scan_active_us - b->scan_paused_us;
        if (out->coverage_regressions) {
            /* A late transition can contradict an already-accounted interval.
             * Do not claim that rejected input proves continuous scanning. */
            b->scan_active_us = b->scan_paused_us = 0;
            b->scan_unknown_us = end - start;
        }
        out->scan_active_us += b->scan_active_us; out->scan_paused_us += b->scan_paused_us; out->scan_unknown_us += b->scan_unknown_us;
        if (b->scan_active_us < end - start) out->scan_gap_bins |= (uint16_t)(1u << i);
        if (!b->reports) out->empty_report_bins |= (uint16_t)(1u << i);
        out->heat_total += b->unique_keys;
    }
    out->scan_coverage_ms = out->scan_active_us / 1000u;
    if (out->worker_reports) {
        out->leading_gap_us = out->first_report_mono_us - out->start_mono_us;
        out->trailing_gap_us = until - out->last_report_mono_us;
    } else out->leading_gap_us = out->trailing_gap_us = elapsed;
    uint64_t accounted = out->worker_reports;
    out->source_consistent = out->received_reports_known && out->callback_drops_known && out->aggregation_drops_known &&
        add(&accounted, out->callback_drops) && add(&accounted, out->aggregation_drops) && accounted <= out->received_reports && !out->counters_saturated;
    if (!out->window_closed) out->quality_mask |= 1;
    if (!s->clock_usable) out->quality_mask |= 2;
    if (out->scan_active_us < elapsed || out->coverage_regressions) out->quality_mask |= 4;
    if (out->address_overflow_reports) out->quality_mask |= 8;
    if (out->callback_drops) out->quality_mask |= 16;
    if (out->aggregation_drops) out->quality_mask |= 32;
    return true;
}
