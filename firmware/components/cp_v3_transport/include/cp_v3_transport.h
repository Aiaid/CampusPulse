#pragma once
#include "cp_settings.h"
#include "cp_v3_evidence.h"
#include "esp_err.h"
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define CP_V3_TRANSPORT_REQUEST_MAX 65536u
#define CP_V3_TRANSPORT_RESPONSE_MAX 32768u
#define CP_V3_MQTT_REQUEST_MAX 8192u
#define CP_V3_MQTT_RESPONSE_MAX 8192u

/* Zero preserves existing isolated HTTPS test callers. Production applications
 * explicitly select native MQTT/TLS; the legacy cp_network owner is not started. */
typedef enum { CP_V3_TRANSPORT_HTTPS=0, CP_V3_TRANSPORT_MQTT_TLS=1 } cp_v3_transport_mode_t;

typedef struct {
    /* MQTT requires logical CP_API_ORIGIN; its actual peer is the fixed broker.
     * HTTPS compatibility is restricted to nonproduction diagnostic origins. */
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
    uint32_t request_timeout_ms; /* 1000..30000; HTTPS attempt or MQTT connect/RPC deadline. SDK calls may overrun. */
    uint32_t server_clock_error_ms; /* 1..3000; declared server-clock error bound */
    /* HTTPS diagnostics only, default false. Only an application owning ALL outbound network clients
     * may opt in. Production network failures can flush the WHOLE SDK DNS
     * cache, including other pending queries; never a per-host/DONE-only flush. */
    bool flush_dns_on_network_failure;
    cp_v3_transport_mode_t mode;
    /* Required current UUIDv4 boot for MQTT topics/config reads. Frozen old
     * request bodies retain their original boot; this string is copied at start.
     * MQTT uses settings.mqtt_* and fixed CP_MQTT_PRODUCTION_URI/public bundle.
     * No custom MQTT CA, broker, fallback proxy or HTTP Date is accepted. */
    const char *active_boot;
} cp_v3_transport_config_t;

/* Pure USB preflight: validates origin syntax and production's bundle-only rule.
 * It performs no DNS/TLS and grants no policy or collection authority. */
bool cp_v3_transport_origin_allowed(const char *origin, bool custom_ca);
typedef struct {
    bool mqtt_hot; /* Actual connected + subscribed + empty-outbox state. */
    uint32_t min_internal_free,min_internal_largest;
    size_t persistent_external_bytes;
} cp_v3_transport_memory_t;
/* Owner-only allocation phase. MQTT serializes TLS IO allocations with this
 * lease; do not call any MQTT/request/start/stop API while it is held. Always
 * end it, including allocation/admission failures. HTTPS has no async IO owner. */
esp_err_t cp_v3_transport_begin_memory(uint32_t timeout_ms,cp_v3_transport_memory_t *);
void cp_v3_transport_end_memory(void);

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
     * HTTPS tls_connected is its async connect return. MQTT sets1 only after
     * verified CONNECTED plus the required QoS0 subscription acknowledgment. */
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
    /* Native MQTT diagnostics; a PUBACK is never an application receipt.
     * complete/status/body become valid only after full correlated response,
     * matching PUBACK and an empty SDK outbox. */
    int32_t mqtt_publish_id,mqtt_puback_id,mqtt_connect_code;
    uint32_t mqtt_outbox_bytes,mqtt_callback_stack_min;
    bool mqtt_session_ready,mqtt_response_received,mqtt_stop_confirmed,mqtt_retained;
} cp_v3_transport_response_t;

/* One application task exclusively owns start/request/time/stop. It must stop
 * other Wi-Fi owners first. No NVS erase/save, v2 policy loop, TF, scanner,
 * retries or queue reclamation. The caller owns frozen request bytes/receipts. */
esp_err_t cp_v3_transport_start(const cp_settings_t *, const cp_v3_transport_config_t *);
esp_err_t cp_v3_transport_request(cp_v3_http_method_t, const char *path,
    const void *body, size_t length, char *response, size_t capacity,
    cp_v3_transport_response_t *result);
/* Historical control recovery only. HTTPS adds X-Receipt-Only:1; MQTT sets the
 * CPV3 frame flag for the same exact ACK/lease body.
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
