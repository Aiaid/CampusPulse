#pragma once
#include "cp_settings.h"
#include "cp_v3_evidence.h"
#include "esp_err.h"
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define CP_V3_TRANSPORT_REQUEST_MAX 65536u
#define CP_V3_TRANSPORT_RESPONSE_MAX 32768u

typedef struct {
    /* Explicit HTTPS origin, no path/userinfo/query. Production accepts only
     * canonical CP_API_ORIGIN with implicit port 443. settings.api_origin is unused. */
    const char *origin;
    /* NULL selects the ESP certificate bundle. Otherwise a NUL-terminated PEM
     * CA is required for isolated servers only. Production requires NULL.
     * CA pointers remain valid until stop. No insecure option. */
    const char *server_ca_pem;
    /* PEAP requires explicit CA and expected RADIUS certificate domain. */
    const char *eap_ca_pem, *eap_domain;
    /* Caller-trusted RTC/physical-host anchor, captured on this boot's monotonic
     * clock. Mandatory before TLS; no unauthenticated SNTP bootstrap. */
    cp_v3_time_t clock_seed;
    uint32_t wifi_timeout_ms; /* 1000..60000 */
    uint32_t request_timeout_ms; /* 1000..30000, whole DNS/TCP/TLS/HTTP attempt */
    uint32_t server_clock_error_ms; /* 1..3000; declared server-clock error bound */
    /* Default false. Only an application owning ALL outbound network clients
     * may opt in. Production network failures can flush the WHOLE SDK DNS
     * cache, including other pending queries; never a per-host/DONE-only flush. */
    bool flush_dns_on_network_failure;
} cp_v3_transport_config_t;

/* Pure USB preflight: validates origin syntax and production's bundle-only rule.
 * It performs no DNS/TLS and grants no policy or collection authority. */
bool cp_v3_transport_origin_allowed(const char *origin, bool custom_ca);

typedef enum { CP_V3_HTTP_GET, CP_V3_HTTP_POST } cp_v3_http_method_t;
typedef enum {
    CP_V3_TRANSPORT_IDLE, CP_V3_TRANSPORT_DNS, CP_V3_TRANSPORT_TLS,
    CP_V3_TRANSPORT_REQUEST_HEADERS, CP_V3_TRANSPORT_REQUEST_BODY,
    CP_V3_TRANSPORT_RESPONSE_HEADERS, CP_V3_TRANSPORT_RESPONSE_BODY,
    CP_V3_TRANSPORT_COMPLETE
} cp_v3_transport_stage_t;
typedef struct {
    int http_status;
    size_t body_bytes;
    bool complete, date_known;
    cp_v3_time_t server_time;
    /* Numeric-only failure evidence; never certificates, URLs or credentials. */
    int32_t tls_esp_error, tls_stack_error, tls_verify_flags;
    cp_v3_transport_stage_t stage;
    /* io_error is the raw failing IO return when available, else esp_err_t.
     * Last read/write include WANT_READ/WANT_WRITE; zero can mean no call yet.
     * tls_connected is the final async connect return, with 1 meaning connected. */
    int32_t io_error, dns_error, tls_connected, last_read, last_write;
    uint32_t received_bytes, written_bytes;
    /* DNS diagnostic only: a.b.c.d -> (a<<24)|(b<<16)|(c<<8)|d.
     * Zero means unresolved/0.0.0.0. Never used to select or pin a destination. */
    uint32_t resolved_ipv4;
    /* A parsed HTTP status may be known while headers/body are incomplete.
     * This diagnostic never makes http_status/complete valid on failure. */
    int parsed_http_status;
    /* Attempt means TCP/IP execution was requested; success requires that the
     * callback actually flushed. No claim that a DNS server returns another A. */
    bool whole_flush_attempted, whole_flush_succeeded;
    int32_t whole_flush_error; /* TCP/IP dispatch/callback result;0 alone is not proof of an attempt. */
} cp_v3_transport_response_t;

/* One application task exclusively owns start/request/time/stop. It must stop
 * other Wi-Fi owners first. No NVS erase/save, v2 policy loop, MQTT, TF, scanner,
 * retries or queue reclamation. The caller owns frozen request bytes/receipts. */
esp_err_t cp_v3_transport_start(const cp_settings_t *, const cp_v3_transport_config_t *);
esp_err_t cp_v3_transport_request(cp_v3_http_method_t, const char *path,
    const void *body, size_t length, char *response, size_t capacity,
    cp_v3_transport_response_t *result);
/* Historical control recovery only. Adds X-Receipt-Only:1 to exact ACK/lease
 * POSTs, never registration, config reads or statistics. A missing committed
 * receipt is a server conflict, not permission to create a new ACK/lease. */
esp_err_t cp_v3_transport_request_receipt_only(cp_v3_http_method_t, const char *path,
    const void *body, size_t length, char *response, size_t capacity,
    cp_v3_transport_response_t *result);
esp_err_t cp_v3_transport_time(cp_v3_time_t *);
/* Explicit closed-boundary action; advances clock epoch. Only the most recent
 * successful HTTPS response's Date candidate is accepted, never plain HTTP. */
esp_err_t cp_v3_transport_sync_clock(void);
/* May be called by another task; owner performs cleanup after its bounded IO. */
void cp_v3_transport_cancel(void);
esp_err_t cp_v3_transport_stop(void);
/* Matches cp_v3_sha256_fn; writes an actual 32-byte SHA-256 digest. */
bool cp_v3_transport_sha256(void *, const void *, size_t, uint8_t digest[32]);
