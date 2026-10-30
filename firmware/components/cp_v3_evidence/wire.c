#include "internal.h"
#include <stdarg.h>
#include <stdio.h>
#include <string.h>

#define SAFE UINT64_C(9007199254740991)
void cp_v3_write(cp_v3_writer_t *w, const char *format, ...) {
    if (!w->ok) return;
    va_list args; va_start(args, format);
    int n = vsnprintf(w->out + w->used, w->cap - w->used, format, args);
    va_end(args);
    if (n < 0 || (size_t)n >= w->cap - w->used) w->ok = false;
    else w->used += (size_t)n;
}
void cp_v3_hex(const uint8_t *bytes, size_t count, char *out) {
    static const char digits[] = "0123456789abcdef";
    for (size_t i = 0; i < count; ++i) { out[2*i] = digits[bytes[i] >> 4]; out[2*i+1] = digits[bytes[i] & 15]; }
    out[2*count] = 0;
}
static size_t length(const char *s, size_t cap) { size_t n = 0; if (!s) return cap; while (n < cap && s[n]) ++n; return n; }
static bool hex(const char *s, size_t count) {
    if (length(s, count + 1) != count) return false;
    for (size_t i = 0; i < count; ++i) if (!((s[i] >= '0' && s[i] <= '9') || (s[i] >= 'a' && s[i] <= 'f'))) return false;
    return true;
}
bool cp_v3_uuid(const char *s) {
    if (length(s, 37) != 36 || s[14] != '4' || !(s[19] == '8' || s[19] == '9' || s[19] == 'a' || s[19] == 'b')) return false;
    for (unsigned i = 0; i < 36; ++i) {
        if (i == 8 || i == 13 || i == 18 || i == 23) { if (s[i] != '-') return false; }
        else if (!((s[i] >= '0' && s[i] <= '9') || (s[i] >= 'a' && s[i] <= 'f'))) return false;
    }
    return true;
}
static bool id(const char *s) {
    size_t n = length(s, 65); if (!n || n > 64) return false;
    for (size_t i = 0; i < n; ++i)
        if (!((s[i] >= 'a' && s[i] <= 'z') || (s[i] >= '0' && s[i] <= '9') ||
              (i && (s[i] == '_' || s[i] == '-')))) return false;
    return true;
}
bool cp_v3_scope_valid(const cp_v3_scope_t *s) {
    return s && id(s->node_id) && id(s->placement_id) && id(s->policy_id) && cp_v3_uuid(s->boot_id) &&
        hex(s->policy_sha256, 64) && s->assignment_generation && s->assignment_generation <= SAFE &&
        length(s->dataset, sizeof s->dataset) < sizeof s->dataset &&
        (!strcmp(s->dataset, "field") || !strcmp(s->dataset, "demo") || !strcmp(s->dataset, "controlled_test"));
}
bool cp_v3_time_valid(cp_v3_time_t t) {
    return t.mono_ms <= SAFE && t.utc_ms <= UINT64_C(8640000000000000) && t.uncertainty_ms <= 5000;
}
static void time_json(cp_v3_writer_t *w, cp_v3_time_t t) {
    cp_v3_write(w, "{\"mono_ms\":%llu,\"utc_ms\":%llu,\"clock_epoch\":%u,\"uncertainty_ms\":%u}",
        (unsigned long long)t.mono_ms, (unsigned long long)t.utc_ms, t.clock_epoch, t.uncertainty_ms);
}
static void claim(cp_v3_writer_t *w, bool known, uint32_t count) {
    if (known) cp_v3_write(w, "{\"value\":%u,\"reason\":null}", count);
    else cp_v3_write(w, "{\"value\":null,\"reason\":\"not_provided\"}");
}
static void values(cp_v3_writer_t *w, const cp_v3_value_t *v, unsigned count, bool overflow, bool conflict) {
    cp_v3_write(w, "{\"values\":[");
    for (unsigned i = 0; i < count; ++i) {
        cp_v3_write(w, "%s{\"value\":%u,\"support_reports\":%u,\"adv_reports\":%u,\"scan_response_reports\":%u,\"conflicting\":%s}",
            i ? "," : "", v[i].value, v[i].support, v[i].adv, v[i].scan_response, conflict ? "true" : "false");
    }
    cp_v3_write(w, "],\"unavailable_reason\":null,\"overflow\":%s,\"overflow_reason\":%s}",
        overflow ? "null" : "0", overflow ? "\"not_measured\"" : "null");
}
void cp_v3_evidence_json(cp_v3_writer_t *w, const cp_v3_window_t *window, unsigned index) {
    const cp_v3_identifier_t *r = &window->identifiers[index]; const cp_v3_scope_t *s = &window->scope;
    char token[33]; cp_v3_hex(r->token, 16, token);
    const char *types[] = {"public", "random", "public_identity", "random_identity"};
    bool partial = r->unexamined || r->malformed || r->unsupported || r->company_overflow || r->appearance_overflow ||
        window->address_overflow_reports || (window->ingress_known && window->ingress_drops);
    cp_v3_write(w, "{\"schema\":\"ble-feature-evidence/1\",\"extractor_version\":\"%s\",\"scope\":{"
        "\"node_id\":\"%s\",\"boot_id\":\"%s\",\"placement_id\":\"%s\",\"capture_config_id\":\"%s\","
        "\"policy_sha256\":\"%s\",\"dataset\":\"%s\",\"window_seq\":%u},"
        "\"identity\":{\"scheme\":\"window_token\",\"token\":\"%s\",\"address_type\":\"%s\"},\"observed_time\":{\"start\":",
        CP_V3_EXTRACTOR, s->node_id, s->boot_id, s->placement_id, s->policy_id, s->policy_sha256, s->dataset, s->window_seq,
        token, r->address_type < 4 ? types[r->address_type] : "unknown");
    time_json(w, window->start); cp_v3_write(w, ",\"end\":"); time_json(w, window->end);
    cp_v3_write(w, "},\"population\":\"all_worker_reports\",\"sampling\":null,\"extraction_state\":\"%s\","
        "\"reports\":{\"available_reports\":%u,\"examined_reports\":%u,\"parsed_reports\":%u,\"malformed_reports\":%u,"
        "\"unsupported_reports\":%u,\"unexamined_reports\":%u,\"parsed_adv_reports\":%u,\"parsed_scan_response_reports\":%u},"
        "\"source_counters\":{\"identifier_worker_reports\":", partial ? "partial" : "complete",
        r->available, r->examined, r->parsed, r->malformed, r->unsupported, r->unexamined, r->adv, r->scan_response);
    claim(w, true, r->available); cp_v3_write(w, ",\"window_reports_seen\":"); claim(w, window->ingress_known, window->ingress_seen);
    cp_v3_write(w, ",\"window_reports_aggregated\":"); claim(w, true, window->aggregated_reports);
    cp_v3_write(w, ",\"window_queue_drops\":"); claim(w, window->ingress_known, window->ingress_drops);
    cp_v3_write(w, ",\"window_address_overflow\":"); claim(w, true, window->address_overflow_reports);
    cp_v3_write(w, ",\"identifier_intentional_skips\":"); claim(w, true, 0);
    cp_v3_write(w, ",\"identifier_pressure_skips\":"); claim(w, true, r->unexamined);
    cp_v3_write(w, "},\"features\":{");
    if (window->limits.fields & CP_V3_COMPANY) {
        cp_v3_write(w, "\"company_ids\":"); values(w, r->company, r->company_count, r->company_overflow, false);
    }
    if (window->limits.fields & CP_V3_APPEARANCE) {
        cp_v3_write(w, "%s\"appearance\":", window->limits.fields & CP_V3_COMPANY ? "," : "");
        values(w, r->appearance, r->appearance_count, r->appearance_overflow, r->appearance_count > 1 || r->appearance_overflow);
    }
    cp_v3_write(w, "}}");
}
static void envelope(cp_v3_writer_t *w, const cp_v3_scope_t *s, const char *batch, const char *stream) {
    cp_v3_write(w, "{\"protocol\":\"campuspulse/3\",\"schema\":\"device-ingest/3\",\"batch_id\":\"%s\","
        "\"node_id\":\"%s\",\"boot_id\":\"%s\",\"placement_id\":\"%s\",\"policy_id\":\"%s\","
        "\"policy_sha256\":\"%s\",\"assignment_generation\":%llu,\"dataset\":\"%s\","
        "\"producer_version\":\"%s\",\"stream\":\"%s\",\"items\":[", batch, s->node_id, s->boot_id, s->placement_id,
        s->policy_id, s->policy_sha256, (unsigned long long)s->assignment_generation, s->dataset, CP_V3_PRODUCER, stream);
}
static cp_v3_result_t finish(cp_v3_writer_t *w, const cp_v3_scope_t *scope, const char *batch, const char *stream,
    uint32_t seq, cp_v3_sha256_fn hash, void *context, size_t *length_out, cp_v3_expected_t *expected) {
    uint8_t digest[32];
    if (!w->ok || !hash(context, w->out, w->used, digest)) {
        memset(w->out, 0, w->cap); return CP_V3_OUTPUT_FULL;
    }
    expected->scope = *scope; strcpy(expected->batch_id, batch); strcpy(expected->stream, stream);
    cp_v3_hex(digest, 32, expected->body_sha256);
    expected->seq_first = expected->seq_last = seq; expected->accepted_count = 1; expected->body_bytes = w->used;
    *length_out = w->used;
    return CP_V3_OK;
}
static bool outputs(char *out, size_t capacity, size_t *used, cp_v3_expected_t *expected) {
    if (used) *used = 0;
    if (expected) memset(expected, 0, sizeof *expected);
    if (out && capacity <= CP_V3_BODY_MAX) memset(out, 0, capacity);
    return out && capacity && capacity <= CP_V3_BODY_MAX && used && expected;
}
cp_v3_result_t cp_v3_feature_body(const cp_v3_window_t *window, unsigned index, const char *batch,
    uint32_t seq, cp_v3_sha256_fn hash, void *context, char *out, size_t capacity, size_t *used, cp_v3_expected_t *expected) {
    if (!outputs(out, capacity, used, expected) || !window || !window->sealed || window->failed || index >= window->count ||
        !seq || !hash || !cp_v3_uuid(batch)) return CP_V3_INVALID;
    cp_v3_writer_t w = {.out = out, .cap = capacity, .ok = true};
    envelope(&w, &window->scope, batch, "feature_summaries");
    cp_v3_write(&w, "{\"seq\":%u,\"evidence\":", seq); cp_v3_evidence_json(&w, window, index); cp_v3_write(&w, "}]}");
    return finish(&w, &window->scope, batch, "feature_summaries", seq, hash, context, used, expected);
}
cp_v3_result_t cp_v3_status_body(const cp_v3_scope_t *scope, const cp_v3_status_t *s, const char *batch,
    uint32_t seq, cp_v3_sha256_fn hash, void *context, char *out, size_t capacity, size_t *used, cp_v3_expected_t *expected) {
    if (!outputs(out, capacity, used, expected) || !cp_v3_scope_valid(scope) || !s || !cp_v3_time_valid(s->time) ||
        (s->failed && s->paused) || !seq || !hash || !cp_v3_uuid(batch)) return CP_V3_INVALID;
    cp_v3_writer_t w = {.out = out, .cap = capacity, .ok = true};
    envelope(&w, scope, batch, "node_status");
    cp_v3_write(&w, "{\"seq\":%u,\"schema\":\"device-status/3\",\"time\":", seq); time_json(&w, s->time);
    cp_v3_write(&w, ",\"uptime_ms\":%llu,\"collection_state\":\"%s\",\"queue\":{"
        "\"feature_summaries\":{\"pending_items\":%u,\"pending_bytes\":%u},\"node_status\":{\"pending_items\":%u,\"pending_bytes\":%u}},"
        "\"losses\":{\"feature_items_dropped\":%u,\"feature_bytes_dropped\":%u,\"status_samples_coalesced\":%u,\"upload_failures\":%u,\"ack_failures\":%u}}]}",
        (unsigned long long)s->time.mono_ms, s->failed ? "failed" : s->paused ? "paused" : "running", s->feature_pending_items,
        s->feature_pending_bytes, s->status_pending_items, s->status_pending_bytes, s->feature_items_dropped,
        s->feature_bytes_dropped, s->status_samples_coalesced, s->upload_failures, s->ack_failures);
    return finish(&w, scope, batch, "node_status", seq, hash, context, used, expected);
}

typedef struct { const uint8_t *bytes; size_t length, pos; } reader_t;
static void space(reader_t *r) { while (r->pos < r->length && strchr(" \t\r\n", r->bytes[r->pos]) && r->bytes[r->pos]) ++r->pos; }
static bool character(reader_t *r, char c) { space(r); return r->pos < r->length && r->bytes[r->pos++] == (uint8_t)c; }
static bool string(reader_t *r, char *out, size_t cap) {
    if (!character(r, '"')) return false;
    size_t n = 0;
    while (r->pos < r->length) {
        uint8_t c = r->bytes[r->pos++];
        if (c == '"') { out[n] = 0; return true; }
        if (c < 32 || c > 126 || c == '\\' || n + 1 >= cap) return false;
        out[n++] = (char)c;
    }
    return false;
}
static bool number(reader_t *r, uint64_t *value) {
    space(r); *value = 0;
    size_t start = r->pos;
    while (r->pos < r->length && r->bytes[r->pos] >= '0' && r->bytes[r->pos] <= '9') {
        unsigned digit = r->bytes[r->pos++] - '0';
        if (*value > (SAFE - digit) / 10) return false;
        *value = *value * 10 + digit;
    }
    return r->pos > start && (r->pos - start == 1 || r->bytes[start] != '0');
}
static bool date(const char *s) {
    if (length(s, 25) != 24) return false;
    for (unsigned i = 0; i < 24; ++i) {
        char expected = i == 4 || i == 7 ? '-' : i == 10 ? 'T' : i == 13 || i == 16 ? ':' : i == 19 ? '.' : i == 23 ? 'Z' : 0;
        if (expected ? s[i] != expected : s[i] < '0' || s[i] > '9') return false;
    }
    unsigned year = (s[0]-'0')*1000u+(s[1]-'0')*100u+(s[2]-'0')*10u+s[3]-'0';
    unsigned month = (s[5]-'0')*10u+s[6]-'0', day = (s[8]-'0')*10u+s[9]-'0';
    unsigned hour = (s[11]-'0')*10u+s[12]-'0', minute = (s[14]-'0')*10u+s[15]-'0', second = (s[17]-'0')*10u+s[18]-'0';
    const unsigned days[] = {31,28,31,30,31,30,31,31,30,31,30,31};
    if (!month || month > 12 || !day || hour > 23 || minute > 59 || second > 59) return false;
    unsigned limit = days[month-1] + (month == 2 && !(year % 4) && (year % 100 || !(year % 400)));
    return day <= limit;
}
bool cp_v3_receipt_matches(const void *bytes, size_t count, const cp_v3_expected_t *e) {
    if (!bytes || !count || count > 4096 || !e || !cp_v3_scope_valid(&e->scope) || !cp_v3_uuid(e->batch_id) ||
        !hex(e->body_sha256, 64) || !e->seq_first || e->seq_first != e->seq_last || e->accepted_count != 1 ||
        !e->body_bytes || e->body_bytes > CP_V3_BODY_MAX || length(e->stream, sizeof e->stream) >= sizeof e->stream ||
        (strcmp(e->stream, "feature_summaries") && strcmp(e->stream, "node_status"))) return false;
    const char *names[] = {"protocol","schema","node_id","boot_id","stream","batch_id","body_sha256","policy_id","policy_sha256",
        "assignment_generation","seq_first","seq_last","accepted_count","receipt_id","received_at","expires_at","retain_until",
        "durability","custody","inference","window_completeness"};
    const char *expected[] = {"campuspulse/3","device-ingest-receipt/3",e->scope.node_id,e->scope.boot_id,e->stream,e->batch_id,
        e->body_sha256,e->scope.policy_id,e->scope.policy_sha256,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,
        "committed","private_source","not_performed","not_established"};
    reader_t r = {.bytes = bytes, .length = count}; uint32_t found = 0;
    char times[3][25] = {{0}};
    if (!character(&r, '{')) return false;
    for (unsigned field = 0; field < 21; ++field) {
        char name[40], value[129];
        if ((field && !character(&r, ',')) || !string(&r, name, sizeof name) || !character(&r, ':')) return false;
        unsigned index;
        for (index = 0; index < 21 && strcmp(name, names[index]); ++index) {}
        if (index == 21 || (found & (1u << index))) return false;
        found |= 1u << index;
        if (index >= 9 && index <= 12) {
            uint64_t v;
            const uint64_t numbers[] = {e->scope.assignment_generation,e->seq_first,e->seq_last,e->accepted_count};
            if (!number(&r, &v) || v != numbers[index-9]) return false;
        } else {
            if (!string(&r, value, sizeof value)) return false;
            if (index == 13) { if (!cp_v3_uuid(value)) return false; }
            else if (index >= 14 && index <= 16) { if (!date(value)) return false; strcpy(times[index-14], value); }
            else if (strcmp(value, expected[index])) return false;
        }
    }
    if (found != ((1u << 21)-1) || !character(&r, '}')) return false;
    space(&r);
    return r.pos == r.length && strcmp(times[0], times[1]) < 0 && strcmp(times[1], times[2]) <= 0;
}
