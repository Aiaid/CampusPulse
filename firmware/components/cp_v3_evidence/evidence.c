#include "internal.h"
#include <string.h>

void cp_v3_window_clear(cp_v3_window_t *w) {
    if (!w) return;
    volatile uint8_t *p = (volatile uint8_t *)w;
    for (size_t i = 0; i < sizeof *w; ++i) p[i] = 0;
}
cp_v3_result_t cp_v3_window_begin(cp_v3_window_t *w, const cp_v3_scope_t *scope,
    const cp_v3_limits_t *limits, cp_v3_time_t start, cp_v3_entropy_fn entropy, void *context) {
    if (!w) return CP_V3_INVALID;
    cp_v3_window_clear(w);
    if (!scope || !limits || !entropy || !cp_v3_scope_valid(scope) || !scope->window_seq || !cp_v3_time_valid(start) ||
        !limits->max_identifiers || limits->max_identifiers > CP_V3_MAX_IDENTIFIERS ||
        !limits->fields || (limits->fields & ~(CP_V3_COMPANY | CP_V3_APPEARANCE)) ||
        ((limits->fields & CP_V3_COMPANY) && (!limits->company_limit || limits->company_limit > 4)) ||
        ((limits->fields & CP_V3_APPEARANCE) && (!limits->appearance_limit || limits->appearance_limit > 2)) ||
        limits->window_ms < 1000 || limits->window_ms > 300000 || !limits->max_reports ||
        limits->max_reports > CP_V3_REPORT_LIMIT || !limits->max_evidence_bytes || limits->max_evidence_bytes > 65536) {
        w->failed = true; return CP_V3_INVALID;
    }
    w->scope = *scope; w->limits = *limits; w->start = start;
    w->entropy = entropy; w->entropy_context = context;
    return CP_V3_OK;
}
static bool valid_ad(const uint8_t *bytes, size_t length) {
    for (size_t p = 0; p < length;) {
        size_t n = bytes[p];
        if (!n) { while (++p < length) if (bytes[p]) return false; return true; }
        if (n + 1 > length - p) return false;
        uint8_t type = bytes[p + 1];
        if ((type == 0xff && n < 3) || (type == 0x19 && n != 3)) return false;
        p += n + 1;
    }
    return true;
}
static void value(cp_v3_value_t *values, uint8_t *count, unsigned limit, bool *overflow,
    uint16_t observed, bool scan_response, unsigned *seen) {
    unsigned i;
    for (i = 0; i < *count && values[i].value != observed; ++i) {}
    if (i == *count) {
        if (i >= limit) { *overflow = true; return; }
        values[i].value = observed; ++*count;
    }
    if (*seen & (1u << i)) return;
    *seen |= 1u << i;
    ++values[i].support;
    if (scan_response) ++values[i].scan_response; else ++values[i].adv;
}
cp_v3_result_t cp_v3_window_observe(cp_v3_window_t *w, const cp_v3_report_t *r) {
    if (!w || !r || w->failed || w->sealed || !w->entropy || (!r->payload && r->length)) return CP_V3_INVALID;
    if (w->worker_reports >= CP_V3_REPORT_LIMIT) { w->failed = true; return CP_V3_OUTPUT_FULL; }
    ++w->worker_reports;
    unsigned index;
    for (index = 0; index < w->count; ++index)
        if (w->identifiers[index].address_type == r->address_type && !memcmp(w->identifiers[index].address, r->address, 6)) break;
    if (index == w->count) {
        if (index >= w->limits.max_identifiers) { ++w->address_overflow_reports; return CP_V3_ADDRESS_FULL; }
        uint8_t token[16]; bool unique = false;
        for (unsigned attempt = 0; attempt < 4; ++attempt) {
            if (!w->entropy(w->entropy_context, token)) break;
            unique = true;
            for (unsigned i = 0; i < w->count; ++i)
                if (!memcmp(token, w->identifiers[i].token, 16)) unique = false;
            if (unique) break;
        }
        if (!unique) { w->failed = true; return CP_V3_ENTROPY_FAILED; }
        memcpy(w->identifiers[index].token, token, 16);
        memset(token, 0, sizeof token);
        memcpy(w->identifiers[index].address, r->address, 6);
        w->identifiers[index].address_type = r->address_type; ++w->count;
    }
    cp_v3_identifier_t *id = &w->identifiers[index];
    ++id->available; ++w->aggregated_reports;
    if (w->examined_reports >= w->limits.max_reports) { ++id->unexamined; return CP_V3_PRESSURE; }
    ++id->examined; ++w->examined_reports;
    if (r->data_status == 1) ++id->fragment_more;
    else if (r->data_status == 2) ++id->truncated;
    else if (r->data_status) ++id->unknown_status;
    if (r->kind > 1 || r->data_status || r->report_type > 1 || r->length > 1650 || (!r->kind && r->length > 31)) {
        ++id->unsupported; return CP_V3_UNSUPPORTED;
    }
    if (!valid_ad(r->payload, r->length)) { ++id->malformed; return CP_V3_MALFORMED; }
    ++id->parsed;
    if (r->report_type) ++id->scan_response; else ++id->adv;
    unsigned company_seen = 0, appearance_seen = 0;
    for (size_t p = 0; p < r->length && r->payload[p]; p += r->payload[p] + 1) {
        uint8_t type = r->payload[p + 1];
        if (type != 0xff && type != 0x19) continue;
        uint16_t observed = r->payload[p + 2] | ((uint16_t)r->payload[p + 3] << 8);
        if (type == 0xff && (w->limits.fields & CP_V3_COMPANY))
            value(id->company, &id->company_count, w->limits.company_limit, &id->company_overflow,
                observed, r->report_type != 0, &company_seen);
        if (type == 0x19 && (w->limits.fields & CP_V3_APPEARANCE))
            value(id->appearance, &id->appearance_count, w->limits.appearance_limit, &id->appearance_overflow,
                observed, r->report_type != 0, &appearance_seen);
    }
    return CP_V3_OK;
}
cp_v3_result_t cp_v3_window_seal(cp_v3_window_t *w, cp_v3_time_t end, bool known, uint32_t seen, uint32_t drops) {
    if (!w || w->failed || w->sealed || !w->entropy || !cp_v3_time_valid(end) || end.mono_ms < w->start.mono_ms ||
        end.mono_ms - w->start.mono_ms != w->limits.window_ms || end.clock_epoch != w->start.clock_epoch ||
        end.utc_ms < w->start.utc_ms || (known && (seen < w->worker_reports || seen > CP_V3_REPORT_LIMIT ||
        drops > seen || w->worker_reports > seen - drops))) return CP_V3_INVALID;
    uint64_t utc_duration = end.utc_ms - w->start.utc_ms;
    uint64_t discrepancy = utc_duration > w->limits.window_ms ? utc_duration - w->limits.window_ms : w->limits.window_ms - utc_duration;
    if (discrepancy > (uint64_t)w->start.uncertainty_ms + end.uncertainty_ms) return CP_V3_INVALID;
    w->end = end; w->ingress_known = known; w->ingress_seen = seen; w->ingress_drops = drops;
    char scratch[CP_V3_BODY_MAX];
    uint32_t total = 2;
    for (unsigned i = 0; i < w->count; ++i) {
        cp_v3_writer_t out = {.out = scratch, .cap = sizeof scratch, .ok = true};
        cp_v3_evidence_json(&out, w, i);
        if (!out.ok || out.used > UINT32_MAX - total) { w->failed = true; return CP_V3_OUTPUT_FULL; }
        total += (uint32_t)out.used + (i != 0);
    }
    if (total > w->limits.max_evidence_bytes) { w->failed = true; return CP_V3_OUTPUT_FULL; }
    w->evidence_bytes = total; w->sealed = true;
    return CP_V3_OK;
}
