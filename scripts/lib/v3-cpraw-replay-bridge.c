/* Host-only CPRAW adapter. Aggregation is the exact portable firmware core.
 * Borrowed addresses/payloads never leave memory; snapshot JSON is counts only. */
#include "cp_v3_stats.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdarg.h>

typedef struct { cp_v3_stats_t *stats; uint64_t delivered; } replay_t;
static uint64_t le(const unsigned char *p, unsigned n) {
    uint64_t value = 0; for (unsigned i = 0; i < n; ++i) value |= (uint64_t)p[i] << (8u * i); return value;
}
static void *allocate(void *ctx, size_t bytes) { (void)ctx; return malloc(bytes); }
static void release(void *ctx, void *memory) { (void)ctx; free(memory); }
void *cp_replay_create(uint32_t window_ms, uint32_t bin_ms, uint64_t start) {
    cp_v3_stats_config_t c = { .capacity = 512, .window_ms = window_ms, .bin_ms = bin_ms,
        .rules_version = CP_V3_STATS_RULESET };
    replay_t *r = calloc(1, sizeof *r); if (!r) return NULL;
    r->stats = cp_v3_stats_alloc(&c, allocate, release, NULL);
    if (!r->stats || !cp_v3_stats_begin(r->stats, start)) {
        cp_v3_stats_free(r->stats); free(r); return NULL;
    }
    /* The simulator supplies a new runtime clock. Source RTC anchors remain
     * separate provenance, never presented as current observation timestamps. */
    cp_v3_stats_set_clock_usable(r->stats, true);
    return r;
}
void cp_replay_free(void *opaque) {
    replay_t *r = opaque; if (!r) return; cp_v3_stats_free(r->stats); memset(r, 0, sizeof *r); free(r);
}
int cp_replay_scan(void *opaque, uint64_t mono, int scanning) {
    replay_t *r = opaque; return r && cp_v3_stats_scan_state(r->stats, mono, scanning != 0);
}
int cp_replay_report(void *opaque, const unsigned char *body, size_t size) {
    replay_t *r = opaque;
    if (!r || !body || size < 43 || size != 43 + le(body + 16, 2) || body[27] > 1) return 0;
    cp_v3_stats_report_t report = { .seq = le(body, 8), .mono_us = le(body + 8, 8),
        .periodic_interval = (uint16_t)le(body + 18, 2), .address_type = body[26],
        .kind = body[27], .event_type = body[28], .props = body[29], .data_status = body[30],
        .sid = body[31], .primary_phy = body[32], .secondary_phy = body[33],
        .direct_address_type = body[34], .rssi = (int8_t)body[41], .tx_power = (int8_t)body[42],
        .payload = body + 43, .length = (size_t)le(body + 16, 2) };
    memcpy(report.address, body + 20, 6); memcpy(report.direct_address, body + 35, 6);
    cp_v3_stats_result_t result = cp_v3_stats_observe(r->stats, &report);
    if (result == CP_V3_STATS_INVALID || result == CP_V3_STATS_OUTSIDE_WINDOW) return 0;
    ++r->delivered; return 1;
}
typedef struct { char *out; size_t size, used; int ok; } writer_t;
static void emit(writer_t *w, const char *format, ...) {
    if (!w->ok) return;
    va_list ap; va_start(ap, format); int n = vsnprintf(w->out + w->used, w->size - w->used, format, ap); va_end(ap);
    if (n < 0 || (size_t)n >= w->size - w->used) w->ok = 0; else w->used += (size_t)n;
}
#define U(value) ((unsigned long long)(value))
int cp_replay_snapshot(void *opaque, uint64_t end, char *out, size_t size) {
    replay_t *r = opaque; if (!r || !out || !size) return 0;
    cp_v3_stats_source_t source = { .reports_seen_known = true, .queue_drops_known = true,
        .processing_losses_known = true, .reports_seen = r->delivered };
    cp_v3_stats_snapshot_t s;
    if (!cp_v3_stats_set_source(r->stats, source) || !cp_v3_stats_snapshot(r->stats, end, &s) ||
        !s.source_consistent || s.counters_saturated) return 0;
    writer_t w = { out, size, 0, 1 };
    emit(&w, "{\"item\":{\"d\":%u,\"b\":%u,\"c\":[", s.duration_ms, s.bin_ms);
    for (unsigned i = 0; i < CP_V3_STATS_CLASS_COUNT; ++i) emit(&w, "%s%u", i ? "," : "", s.counts[i]);
    emit(&w, "],\"r\":[%llu,%llu,%llu,%llu],\"x\":[", U(s.received_reports), U(s.worker_reports), U(s.adv_reports), U(s.scan_response_reports));
    for (unsigned i = 0; i < s.bin_count; ++i) {
        cp_v3_stats_bin_t *b = &s.bins[i]; emit(&w, "%s[%llu,%u,%llu,%lld]", i ? "," : "", U(b->reports), b->unique_keys, U(b->rssi_samples), (long long)b->rssi_sum);
    }
    emit(&w, "],\"s\":[%llu,%lld,", U(s.rssi_samples), (long long)s.rssi_sum);
    if (s.rssi_samples) emit(&w, "%d,%d", s.rssi_min, s.rssi_max); else emit(&w, "null,null");
    emit(&w, "],\"l\":[%llu,%llu,%llu,%llu],\"f\":%u,\"v\":[\"%s\",\"%s\"]},",
        U(s.scan_coverage_ms), U(s.callback_drops), U(s.aggregation_drops), U(s.address_overflow_reports), s.quality_mask, s.extractor_version, s.rules_version);
    emit(&w, "\"diagnostics\":{\"malformed_reports\":%llu,\"unsupported_reports\":%llu,\"fragment_more_reports\":%llu,\"truncated_reports\":%llu,\"unknown_status_reports\":%llu,\"rssi_unknown_reports\":%llu,\"forward_sequence_gaps\":%llu,\"scan_active_us\":%llu,\"scan_paused_us\":%llu,\"scan_unknown_us\":%llu,\"heat_total\":%u,\"scan_gap_bins\":%u,\"empty_report_bins\":%u}}",
        U(s.malformed_reports), U(s.unsupported_reports), U(s.fragment_more_reports), U(s.truncated_reports), U(s.unknown_status_reports), U(s.rssi_unknown_reports), U(s.forward_sequence_gaps), U(s.scan_active_us), U(s.scan_paused_us), U(s.scan_unknown_us), s.heat_total, s.scan_gap_bins, s.empty_report_bins);
    return w.ok;
}
