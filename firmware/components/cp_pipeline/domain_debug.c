#include "domain_debug.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include <limits.h>
#include <string.h>

static portMUX_TYPE lock = portMUX_INITIALIZER_UNLOCKED;
static cp_debug_domain_t published;
static uint64_t published_ms, working_start, refreshed_ms;
static uint32_t working_sequence, bins[CP_DEBUG_DOMAIN_BINS];
static bool working, refreshed;

static uint32_t saturate(uint64_t n) { return n > UINT32_MAX ? UINT32_MAX : (uint32_t)n; }
static bool prepare(const cp_collect_state_t *window)
{
    if (working && working_start == window->start_ms && working_sequence == window->window_seq)
        return false;
    working = true;
    working_start = window->start_ms;
    working_sequence = window->window_seq;
    memset(bins, 0, sizeof bins);
    refreshed = false;
    return true;
}

static void observe(const cp_collect_state_t *window, const cp_report_t *report, bool counted)
{
    if (!window || !report || !window->bin_ms) return;
    (void)prepare(window);
    if (!counted || report->mono_ms < window->start_ms) return;
    uint64_t offset = report->mono_ms - window->start_ms;
    if (offset >= window->window_ms) return;
    uint64_t bin = offset / window->bin_ms;
    if (bin < CP_DEBUG_DOMAIN_BINS && bins[bin] < UINT32_MAX) ++bins[bin];
}

static void refresh(const cp_collect_state_t *window, const cp_address_summary_t *legacy,
                    const cp_address_core_t *cores, uint64_t now, bool sealed, uint32_t duration)
{
    if (!window || !window->bin_ms || !window->window_ms) return;
    (void)prepare(window);
    if (!sealed && refreshed && now >= refreshed_ms && now - refreshed_ms < 1000) return;
    cp_debug_domain_t next = {0};
    next.known = true;
    next.window_partial = !sealed || duration < window->window_ms;
    next.address_overflow = window->address_overflow;
    next.window_seq = window->window_seq;
    next.window_ms = sealed ? duration : window->window_ms;
    next.bin_ms = window->bin_ms;
    uint64_t count = ((uint64_t)next.window_ms + window->bin_ms - 1) / window->bin_ms;
    next.bin_count = (uint8_t)(count > CP_DEBUG_DOMAIN_BINS ? CP_DEBUG_DOMAIN_BINS : count);
    next.reports_seen = window->reports_seen;
    next.reports_aggregated = window->reports_aggregated;
    next.addresses = window->address_count;
    next.aggregation_drops = window->aggregation_drops;
    next.summary_drops = window->summary_drops;
    next.rssi_samples = window->rssi_samples;
    if (window->rssi_samples) {
        next.rssi_min = window->rssi_min;
        next.rssi_mean = (int16_t)(window->rssi_sum / window->rssi_samples);
        next.rssi_max = window->rssi_max;
    }
    for (unsigned i = 0; i < next.bin_count; ++i) next.bin_reports[i] = bins[i];
    uint64_t parsed = 0, malformed = 0;
    for (unsigned i = 0; i < window->address_count && i < CP_COLLECT_ADDRESSES; ++i) {
        const cp_vehicle_evidence_t *e = legacy ? &legacy[i].vehicle_evidence :
                                               &cores[i].vehicle_evidence;
        parsed += e->parsed_reports;
        malformed += e->malformed_reports;
        if (e->name_brand_mask) ++next.vehicle_name_addresses;
        if (e->ecosystem_mask) ++next.vehicle_ecosystem_addresses;
        if (e->exclusion_mask) ++next.vehicle_excluded_addresses;
        if (e->name_brand_mask && !e->exclusion_mask) ++next.vehicle_candidates;
    }
    next.vehicle_parsed_reports = saturate(parsed);
    next.vehicle_malformed_reports = saturate(malformed);
    portENTER_CRITICAL(&lock);
    published = next;
    published_ms = now;
    portEXIT_CRITICAL(&lock);
    refreshed = true;
    refreshed_ms = now;
}

void cp_pipeline_domain_snapshot(cp_debug_domain_t *out)
{
    if (!out) return;
    portENTER_CRITICAL(&lock);
    *out = published;
    uint64_t at = published_ms;
    portEXIT_CRITICAL(&lock);
    uint64_t now = (uint64_t)esp_timer_get_time() / 1000;
    if (out->known) {
        if (now < at) { out->known = false; out->age_ms = UINT32_MAX; }
        else out->age_ms = saturate(now - at);
    }
}

void cp_domain_debug_observe(const cp_collect_t *w, const cp_report_t *r, bool counted) {
    observe(w ? &w->state : NULL, r, counted);
}
void cp_domain_debug_observe_compact(const cp_collect_compact_t *w, const cp_report_t *r,
                                    bool counted) {
    observe(w ? &w->state : NULL, r, counted);
}
void cp_domain_debug_refresh(const cp_collect_t *w, uint64_t now, bool sealed, uint32_t duration) {
    refresh(w ? &w->state : NULL, w ? w->addresses : NULL, NULL, now, sealed, duration);
}
void cp_domain_debug_refresh_compact(const cp_collect_compact_t *w, uint64_t now,
                                    bool sealed, uint32_t duration) {
    if (w && w->address_count && !w->addresses) return;
    refresh(w ? &w->state : NULL, NULL, w ? w->addresses : NULL, now, sealed, duration);
}
