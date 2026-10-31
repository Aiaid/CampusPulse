#include "internal.h"
#include <limits.h>
#include <string.h>
#include <strings.h>

static bool digit(char c) { return c >= '0' && c <= '9'; }
static bool uuid(const char *s) {
    if (strlen(s) != 36 || s[14] != '4' || !strchr("89ab", s[19])) return false;
    for (unsigned i = 0; i < 36; i++) {
        if (i == 8 || i == 13 || i == 18 || i == 23) { if (s[i] != '-') return false; }
        else if (!digit(s[i]) && !(s[i] >= 'a' && s[i] <= 'f')) return false;
    }
    return true;
}
bool cp_v3_transport_origin(const char *s, cp_v3_origin_t *out) {
    if (!s || !out || strnlen(s, 272) >= 272 || strncmp(s, "https://", 8)) return false;
    memset(out, 0, sizeof *out);
    const char *host = s + 8, *p = host;
    size_t label = 0;
    while (*p && *p != ':') {
        char c = *p;
        if (c == '.') { if (!label || label > 63 || p[-1] == '-') return false; label = 0; }
        else if ((c >= 'a' && c <= 'z') || digit(c) || (c == '-' && label)) label++;
        else return false;
        p++;
    }
    size_t length = (size_t)(p - host);
    if (!length || length > 253 || !label || label > 63 || p[-1] == '-') return false;
    memcpy(out->host, host, length);
    out->port = 443;
    if (*p) {
        unsigned port = 0; p++;
        if (!*p || *p == '0') return false;
        for (; *p; p++) { if (!digit(*p) || port > (65535u - (unsigned)(*p - '0')) / 10u) return false; port = port * 10u + (unsigned)(*p - '0'); }
        out->port = (uint16_t)port;
    }
    memcpy(out->authority, host, strlen(host) + 1);
    /* Production has one canonical spelling and the implicit HTTPS port.
     * Its subdomains cannot be treated as isolated aliases. */
    const char *production_host = &CP_API_ORIGIN[sizeof("https://") - 1];
    size_t production_length = strlen(production_host);
    if ((!strcmp(out->host, production_host) && strcmp(s, CP_API_ORIGIN)) ||
        (length > production_length && out->host[length-production_length-1] == '.' &&
         !strcmp(out->host+length-production_length, production_host))) return false;
    return true;
}
bool cp_v3_transport_origin_allowed(const char *s, bool custom_ca) {
    cp_v3_origin_t origin;
    return cp_v3_transport_origin(s, &origin) && (!custom_ca || strcmp(s, CP_API_ORIGIN));
}
bool cp_v3_transport_path(cp_v3_http_method_t method, const char *s) {
    if (!s || strnlen(s, 160) >= 160) return false;
    if (method == CP_V3_HTTP_POST) return !strcmp(s, "/api/v3/ingest") ||
        !strcmp(s, "/api/v3/device/capabilities") || !strcmp(s, "/api/v3/device/config/ack") ||
        !strcmp(s, "/api/v3/device/lease") || !strcmp(s, "/api/v3/statistics/ingest");
    static const char prefix[] = "/api/v3/device/config?boot_id=";
    return method == CP_V3_HTTP_GET && !strncmp(s, prefix, sizeof prefix - 1) && uuid(s + sizeof prefix - 1);
}
bool cp_v3_transport_receipt_only_path(cp_v3_http_method_t method,const char *s) {
    return method==CP_V3_HTTP_POST&&s&&(!strcmp(s,"/api/v3/device/config/ack")||!strcmp(s,"/api/v3/device/lease"));
}
bool cp_v3_transport_anchor(const cp_v3_time_t *seed, uint64_t now, cp_v3_time_t *out) {
    if (!seed || !out || seed->utc_ms < UINT64_C(1704067200000) || seed->utc_ms > UINT64_C(7258118400000) ||
        !seed->clock_epoch || seed->uncertainty_ms > 5000 || now < seed->mono_ms) return false;
    uint64_t age = now - seed->mono_ms;
    if (age > UINT64_C(10000000)) return false;
    /* Conservative 500ppm oscillator allowance, rounded upward. */
    uint64_t uncertainty = seed->uncertainty_ms + (age * 500u + 999999u) / 1000000u;
    if (uncertainty > 5000 || seed->utc_ms > UINT64_C(7258118400000) - age) return false;
    *out = *seed; out->mono_ms = now; out->utc_ms += age; out->uncertainty_ms = (uint32_t)uncertainty;
    return true;
}

/* Strict IMF-fixdate parser, timezone independent; no locale/mktime/SNTP. */
static unsigned decimal(const char *s, unsigned n) {
    unsigned value = 0;
    while (n--) { if (!digit(*s)) return UINT_MAX; value = value * 10u + (unsigned)(*s++ - '0'); }
    return value;
}
bool cp_v3_transport_date(const char *s, uint64_t *out) {
    if (!s || !out || strlen(s) != 29 || s[3] != ',' || s[4] != ' ' || s[7] != ' ' || s[11] != ' ' ||
        s[16] != ' ' || s[19] != ':' || s[22] != ':' || strcmp(s + 25, " GMT")) return false;
    const char *months = "JanFebMarAprMayJunJulAugSepOctNovDec", *days = "SunMonTueWedThuFriSat";
    unsigned month = 0, weekday = 7;
    for (unsigned i = 0; i < 12; i++) if (!memcmp(s + 8, months + i * 3, 3)) month = i + 1;
    for (unsigned i = 0; i < 7; i++) if (!memcmp(s, days + i * 3, 3)) weekday = i;
    unsigned year = decimal(s + 12, 4), day = decimal(s + 5, 2), hour = decimal(s + 17, 2), minute = decimal(s + 20, 2), second = decimal(s + 23, 2);
    if (!month || weekday == 7 || year < 2024 || year > 2199 || !day || hour > 23 || minute > 59 || second > 59) return false;
    bool leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    const unsigned md[] = {31,28,31,30,31,30,31,31,30,31,30,31};
    if (day > md[month - 1] + (month == 2 && leap)) return false;
    uint64_t date = 0;
    for (unsigned y = 1970; y < year; y++) date += 365u + (y % 4 == 0 && (y % 100 != 0 || y % 400 == 0));
    for (unsigned m = 1; m < month; m++) date += md[m - 1] + (m == 2 && leap);
    date += day - 1;
    if ((date + 4) % 7 != weekday) return false;
    *out = ((date * 24u + hour) * 3600u + minute * 60u + second) * 1000u;
    return true;
}

static bool header(cp_v3_http_response_t *s) {
    if (!s->key_used) return true;
    s->key[s->key_used] = s->value[s->value_used] = 0;
    if (!strcasecmp(s->key, "Content-Encoding") && strcasecmp(s->value, "identity")) return false;
    if (!strcasecmp(s->key, "Date")) {
        if (s->date_seen) { s->date_valid = false; }
        else s->date_valid = cp_v3_transport_date(s->value, &s->date_ms);
        s->date_seen = true;
    }
    s->key_used = s->value_used = 0; s->value_started = false;
    return true;
}
static int field(http_parser *p, const char *bytes, size_t n) {
    cp_v3_http_response_t *s = p->data;
    if (s->value_started && !header(s)) return 1;
    if (n > sizeof s->key - 1 - s->key_used || n > 8192 - s->header_bytes) return 1;
    memcpy(s->key + s->key_used, bytes, n); s->key_used += n; s->header_bytes += n;
    return 0;
}
static int value(http_parser *p, const char *bytes, size_t n) {
    cp_v3_http_response_t *s = p->data;
    if (n > sizeof s->value - 1 - s->value_used || n > 8192 - s->header_bytes) return 1;
    memcpy(s->value + s->value_used, bytes, n); s->value_used += n; s->header_bytes += n; s->value_started = true;
    return 0;
}
static int headers(http_parser *p) {
    cp_v3_http_response_t *s = p->data;
    if (!header(s) || p->status_code < 200 || p->status_code > 599 || p->upgrade ||
        (p->content_length != ULLONG_MAX && p->content_length >= s->capacity)) return -1;
    s->headers_done = true; return 0;
}
static int body(http_parser *p, const char *bytes, size_t n) {
    cp_v3_http_response_t *s = p->data;
    if (!s->headers_done || !s->capacity || n >= s->capacity - s->used) return 1;
    memcpy(s->body + s->used, bytes, n); s->used += n; s->body[s->used] = 0; return 0;
}
static int complete(http_parser *p) {
    cp_v3_http_response_t *s = p->data;
    if (s->complete || !header(s)) return 1;
    s->complete = true; http_parser_pause(p, 1); return 0;
}
static const http_parser_settings settings = {.on_header_field = field, .on_header_value = value,
    .on_headers_complete = headers, .on_body = body, .on_message_complete = complete};
void cp_v3_http_init(cp_v3_http_response_t *s, char *out, size_t cap) {
    memset(s, 0, sizeof *s); s->body = out; s->capacity = cap;
    if (out && cap) out[0] = 0;
    http_parser_init(&s->parser, HTTP_RESPONSE); s->parser.data = s;
    if (!out || !cap || cap > CP_V3_TRANSPORT_RESPONSE_MAX + 1u) s->failed = true;
}
bool cp_v3_http_feed(cp_v3_http_response_t *s, const void *bytes, size_t n) {
    if (!s || s->failed || s->complete || (!bytes && n)) return false;
    size_t used = http_parser_execute(&s->parser, &settings, bytes, n);
    enum http_errno error = HTTP_PARSER_ERRNO(&s->parser);
    if (used != n || (error != HPE_OK && !(s->complete && error == HPE_PAUSED))) s->failed = true;
    return !s->failed;
}
bool cp_v3_http_eof(cp_v3_http_response_t *s) {
    if (!s || s->failed) return false;
    if (!s->complete) (void)cp_v3_http_feed(s, NULL, 0);
    return s->complete && !s->failed;
}
void cp_v3_transport_clear_response(cp_v3_transport_response_t *s) {
    if (!s) return;
    s->http_status = 0; s->body_bytes = 0;
    s->complete = s->date_known = false;
    memset(&s->server_time, 0, sizeof s->server_time);
}
