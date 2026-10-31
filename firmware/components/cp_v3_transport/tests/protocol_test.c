#include "internal.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

static void parse(const char *wire, size_t split, unsigned status, const char *body) {
    char output[1024]; cp_v3_http_response_t s;
    cp_v3_http_init(&s, output, sizeof output);
    size_t length = strlen(wire);
    assert(split <= length);
    assert(cp_v3_http_feed(&s, wire, split));
    if (split < length) assert(cp_v3_http_feed(&s, wire + split, length - split));
    assert(cp_v3_http_eof(&s));
    assert(s.complete && s.parser.status_code == status && !strcmp(output, body));
}
static void reject(const char *wire, size_t capacity) {
    char output[1024]; cp_v3_http_response_t s;
    cp_v3_http_init(&s, output, capacity);
    bool accepted = cp_v3_http_feed(&s, wire, strlen(wire));
    if (accepted && cp_v3_http_eof(&s)) fprintf(stderr, "unexpected accepted fixture: %s\n", wire);
    assert(!accepted || !cp_v3_http_eof(&s));
}
int main(void) {
    cp_v3_origin_t origin;
    assert(cp_v3_transport_origin("https://v3-test.example:8443", &origin));
    assert(!strcmp(origin.host, "v3-test.example") && !strcmp(origin.authority, "v3-test.example:8443") && origin.port == 8443);
    assert(cp_v3_transport_origin("https://192.0.2.4", &origin) && origin.port == 443);
    assert(cp_v3_transport_origin(CP_API_ORIGIN, &origin) && origin.port == 443);
    assert(!strcmp(origin.host, &CP_API_ORIGIN[sizeof("https://") - 1]));
    assert(cp_v3_transport_origin_allowed(CP_API_ORIGIN, false));
    assert(!cp_v3_transport_origin_allowed(CP_API_ORIGIN, true));
    assert(cp_v3_transport_origin_allowed("https://v3-test.example:8443", true));
    assert(cp_v3_transport_origin_allowed("https://v3-test.example:8443", false));
    assert(!cp_v3_transport_origin_allowed(NULL, false));
    const char *bad[] = {"http://example.test", "https://", "https://u:p@example.test", "https://example.test/", "https://example.test?q=1",
        "https://example.test#x", "https://example.test:0", "https://example.test:65536", "https://example.test:01", "https://example.test:",
        "https://example.test:443/", "https://example.test\r\nX:1", "https://.example", "https://example.", "https://a..b", "https://-bad.test",
        "https://bad-.test", CP_API_ORIGIN ":443", CP_API_ORIGIN ":8443", CP_API_ORIGIN "/", CP_API_ORIGIN ".",
        "https://test.pulse.anend.net", "https://PULSE.ANEND.NET", "https://EXAMPLE.TEST"};
    for (unsigned i = 0; i < sizeof bad / sizeof bad[0]; i++) assert(!cp_v3_transport_origin(bad[i], &origin));
    assert(cp_v3_transport_path(CP_V3_HTTP_POST, "/api/v3/ingest"));
    assert(cp_v3_transport_path(CP_V3_HTTP_POST, "/api/v3/device/capabilities"));
    assert(cp_v3_transport_path(CP_V3_HTTP_POST, "/api/v3/device/config/ack"));
    assert(cp_v3_transport_path(CP_V3_HTTP_POST, "/api/v3/device/lease"));
    assert(cp_v3_transport_path(CP_V3_HTTP_POST, "/api/v3/statistics/ingest"));
    assert(cp_v3_transport_receipt_only_path(CP_V3_HTTP_POST,"/api/v3/device/config/ack"));
    assert(cp_v3_transport_receipt_only_path(CP_V3_HTTP_POST,"/api/v3/device/lease"));
    const char *not_recovery[]={"/api/v3/device/capabilities","/api/v3/statistics/ingest","/api/v3/ingest",
        "/api/v3/device/config/ack?x=1","/api/v3/device/lease/","/api/v3/device/lease\r\nX: bad"};
    for(unsigned i=0;i<sizeof not_recovery/sizeof not_recovery[0];i++)
        assert(!cp_v3_transport_receipt_only_path(CP_V3_HTTP_POST,not_recovery[i]));
    assert(!cp_v3_transport_receipt_only_path(CP_V3_HTTP_GET,"/api/v3/device/lease"));
    assert(!cp_v3_transport_receipt_only_path(CP_V3_HTTP_POST,NULL));
    assert(!cp_v3_transport_path(CP_V3_HTTP_GET, "/api/v3/statistics/ingest"));
    assert(!cp_v3_transport_path(CP_V3_HTTP_POST, "/api/v3/statistics/ingest?raw=1"));
    assert(cp_v3_transport_path(CP_V3_HTTP_GET, "/api/v3/device/config?boot_id=12345678-1234-4123-8123-123456789abc"));
    assert(!cp_v3_transport_path(CP_V3_HTTP_GET, "/api/v3/ingest"));
    assert(!cp_v3_transport_path(CP_V3_HTTP_GET, "/api/v3/device/config?boot_id=12345678-1234-4123-8123-123456789abc&x=1"));
    assert(!cp_v3_transport_path(CP_V3_HTTP_POST, "/api/v2/ingest"));
    assert(!cp_v3_transport_path(CP_V3_HTTP_POST, "/api/v3/ingest\r\nX: bad"));
    cp_v3_time_t seed = {.mono_ms = 100, .utc_ms = 1704067200000ULL, .clock_epoch = 1, .uncertainty_ms = 1000}, out;
    assert(cp_v3_transport_anchor(&seed, 101, &out) && out.utc_ms == seed.utc_ms + 1 && out.uncertainty_ms == 1001);
    assert(cp_v3_transport_anchor(&seed, 2000100, &out) && out.uncertainty_ms == 2000);
    assert(!cp_v3_transport_anchor(&seed, 99, &out));
    assert(!cp_v3_transport_anchor(&seed, 8000101, &out));
    seed.clock_epoch = 0; assert(!cp_v3_transport_anchor(&seed, 100, &out)); seed.clock_epoch = 1;
    seed.utc_ms = 0; assert(!cp_v3_transport_anchor(&seed, 100, &out));
    uint64_t epoch;
    assert(cp_v3_transport_date("Mon, 01 Jan 2024 00:00:00 GMT", &epoch) && epoch == 1704067200000ULL);
    assert(cp_v3_transport_date("Thu, 29 Feb 2024 23:59:59 GMT", &epoch));
    assert(!cp_v3_transport_date("Fri, 29 Feb 2024 23:59:59 GMT", &epoch));
    assert(!cp_v3_transport_date("Thu, 29 Feb 2025 00:00:00 GMT", &epoch));
    assert(!cp_v3_transport_date("Mon, 01 Jan 2024 24:00:00 GMT", &epoch));
    assert(!cp_v3_transport_date("Mon, 01 Jan 2024 00:00:00 UTC", &epoch));
    const char *length = "HTTP/1.1 200 OK\r\nDate: Mon, 01 Jan 2024 00:00:00 GMT\r\nContent-Length: 2\r\n\r\n{}";
    const char *chunked = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1\r\n{\r\n1\r\n}\r\n0\r\n\r\n";
    for (size_t i = 0; i <= strlen(length); i++) parse(length, i, 200, "{}");
    for (size_t i = 0; i <= strlen(chunked); i++) parse(chunked, i, 200, "{}");
    parse("HTTP/1.1 307 Temporary Redirect\r\nLocation: https://elsewhere.test\r\nContent-Length: 0\r\n\r\n", 3, 307, "");
    parse("HTTP/1.1 403 Forbidden\r\nContent-Length: 2\r\n\r\n{}", 0, 403, "{}");
    parse("HTTP/1.0 200 OK\r\n\r\n{}", 3, 200, "{}");
    reject(length, 2); /* Room for NUL is mandatory. */
    reject("HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\n{}", 1024);
    reject("HTTP/1.1 200 OK\r\nContent-Length: 1\r\n\r\n{}", 1024);
    reject("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}HTTP/1.1 200 OK\r\n\r\n", 1024);
    reject("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n", 1024);
    reject("HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: 2\r\n\r\n{}", 1024);
    reject("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\n{}\r\n0\r\n\r\n", 1024);
    reject("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\n{}\r\n0\r\n\r\n", 2);
    char oversized[700]; memset(oversized, 'x', sizeof oversized);
    memcpy(oversized, "HTTP/1.1 200 OK\r\nX: ", 19); oversized[sizeof oversized - 1] = 0;
    reject(oversized, 1024);
    char many_headers[20000]; size_t position = 0;
    position += (size_t)snprintf(many_headers, sizeof many_headers, "HTTP/1.1 200 OK\r\n");
    for (unsigned i = 0; i < 1000; i++) position += (size_t)snprintf(many_headers + position, sizeof many_headers - position, "X: 12345678\r\n");
    snprintf(many_headers + position, sizeof many_headers - position, "Content-Length: 0\r\n\r\n");
    reject(many_headers, 1024);
    char output[64]; cp_v3_http_response_t s;
    cp_v3_http_init(&s, output, sizeof output);
    assert(cp_v3_http_feed(&s, length, strlen(length)) && s.date_valid && s.date_ms == 1704067200000ULL);
    const char *duplicate = "HTTP/1.1 200 OK\r\nDate: Mon, 01 Jan 2024 00:00:00 GMT\r\nDate: Mon, 01 Jan 2024 00:00:00 GMT\r\nContent-Length: 0\r\n\r\n";
    cp_v3_http_init(&s, output, sizeof output);
    assert(cp_v3_http_feed(&s, duplicate, strlen(duplicate)) && !s.date_valid);
    cp_v3_http_init(&s, output, CP_V3_TRANSPORT_RESPONSE_MAX + 2);
    assert(s.failed && !cp_v3_http_feed(&s, length, strlen(length)));
    cp_v3_transport_response_t diagnostic = {.http_status = 200, .body_bytes = 17, .complete = true, .date_known = true,
        .server_time = {.utc_ms = 1704067200000ULL}, .tls_esp_error = 33, .tls_stack_error = -44, .tls_verify_flags = 55,
        .stage = CP_V3_TRANSPORT_RESPONSE_HEADERS, .io_error = -76, .dns_error = 0, .tls_connected = 1,
        .last_read = -76, .last_write = 512, .received_bytes = 600, .written_bytes = 512};
    cp_v3_transport_clear_response(&diagnostic);
    assert(!diagnostic.complete && !diagnostic.http_status && !diagnostic.body_bytes && !diagnostic.date_known && !diagnostic.server_time.utc_ms);
    assert(diagnostic.stage == CP_V3_TRANSPORT_RESPONSE_HEADERS && diagnostic.io_error == -76 && !diagnostic.dns_error && diagnostic.tls_connected == 1);
    assert(diagnostic.last_read == -76 && diagnostic.last_write == 512 && diagnostic.received_bytes == 600 && diagnostic.written_bytes == 512);
    assert(diagnostic.tls_esp_error == 33 && diagnostic.tls_stack_error == -44 && diagnostic.tls_verify_flags == 55);
    puts("v3 transport origin/path/time and fragmented bounded HTTP parser passed");
    return 0;
}
