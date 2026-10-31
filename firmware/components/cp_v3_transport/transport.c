#include "internal.h"
#include "sdkconfig.h"
#if CONFIG_MBEDTLS_CERTIFICATE_BUNDLE
#include "esp_crt_bundle.h"
#endif
#include "esp_eap_client.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_netif_net_stack.h"
#include "esp_timer.h"
#include "esp_tls.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "lwip/dns.h"
#include "lwip/ip_addr.h"
#include "mbedtls/sha256.h"
#include <limits.h>
#include <stdio.h>
#include <string.h>
#include <sys/time.h>

#if !CONFIG_MBEDTLS_HAVE_TIME || !CONFIG_MBEDTLS_HAVE_TIME_DATE
#error "v3 transport requires mbedTLS certificate date checks and a trusted bootstrap clock"
#endif

static TaskHandle_t s_owner;
static bool s_wifi_initialized, s_wifi_started, s_enterprise, s_eap_configured;
static bool s_cancelled, s_link;
static esp_netif_t *s_sta;
static esp_event_handler_instance_t s_wifi_handler, s_ip_handler;
static cp_v3_transport_config_t s_config;
static cp_v3_origin_t s_origin;
static cp_v3_time_t s_anchor, s_date;
static bool s_date_known;
static char s_token[CP_SETTINGS_TOKEN_SIZE];
static portMUX_TYPE s_dns_lock = portMUX_INITIALIZER_UNLOCKED;
static uint32_t s_dns_generation;
static int s_dns_result;
static ip_addr_t s_dns_address;

static uint64_t now_ms(void) { return (uint64_t)esp_timer_get_time() / 1000u; }
static void wipe(void *data, size_t n) { volatile uint8_t *p = data; while (n--) *p++ = 0; }
static bool owner(void) {
    TaskHandle_t current = __atomic_load_n(&s_owner, __ATOMIC_ACQUIRE);
    return current && current == xTaskGetCurrentTaskHandle();
}
static bool active(void) { return !__atomic_load_n(&s_cancelled, __ATOMIC_ACQUIRE); }
static bool before(uint64_t deadline) { return active() && now_ms() < deadline; }
static void pause_io(void) { vTaskDelay(pdMS_TO_TICKS(10) ?: 1); }
static esp_err_t cancelled_or_timeout(void) { return active() ? ESP_ERR_TIMEOUT : ESP_ERR_INVALID_STATE; }

static void wifi_event(void *arg, esp_event_base_t base, int32_t event, void *data) {
    (void)arg; (void)data;
    if (base == IP_EVENT && event == IP_EVENT_STA_GOT_IP)
        __atomic_store_n(&s_link, true, __ATOMIC_RELEASE);
    else if ((base == WIFI_EVENT && event == WIFI_EVENT_STA_DISCONNECTED) ||
             (base == IP_EVENT && event == IP_EVENT_STA_LOST_IP))
        __atomic_store_n(&s_link, false, __ATOMIC_RELEASE);
}
static void dns_complete(const char *name, const ip_addr_t *address, void *arg) {
    (void)name;
    portENTER_CRITICAL(&s_dns_lock);
    if ((uint32_t)(uintptr_t)arg == s_dns_generation) {
        if (address && IP_IS_V4(address)) { s_dns_address = *address; s_dns_result = 1; }
        else s_dns_result = -1;
    }
    portEXIT_CRITICAL(&s_dns_lock);
}
static esp_err_t dns_start(void *arg) {
    ip_addr_t address;
    err_t error = dns_gethostbyname_addrtype(s_origin.host, &address, dns_complete, arg, LWIP_DNS_ADDRTYPE_IPV4);
    if (error == ERR_OK) dns_complete(NULL, &address, arg);
    else if (error != ERR_INPROGRESS) dns_complete(NULL, NULL, arg);
    return ESP_OK;
}
static esp_err_t resolve(char address[16], uint64_t deadline) {
    portENTER_CRITICAL(&s_dns_lock);
    uint32_t generation = ++s_dns_generation;
    if (!generation) generation = ++s_dns_generation;
    s_dns_result = 0;
    portEXIT_CRITICAL(&s_dns_lock);
    esp_err_t error = esp_netif_tcpip_exec(dns_start, (void *)(uintptr_t)generation);
    int ready = 0; ip_addr_t result = {0};
    while (error == ESP_OK && before(deadline)) {
        portENTER_CRITICAL(&s_dns_lock);
        ready = s_dns_result; result = s_dns_address;
        portEXIT_CRITICAL(&s_dns_lock);
        if (ready) break;
        pause_io();
    }
    portENTER_CRITICAL(&s_dns_lock); ++s_dns_generation; portEXIT_CRITICAL(&s_dns_lock);
    if (error != ESP_OK) return error;
    if (!before(deadline)) return cancelled_or_timeout();
    if (ready < 0) return ESP_ERR_NOT_FOUND;
    return ipaddr_ntoa_r(&result, address, 16) ? ESP_OK : ESP_FAIL;
}
static esp_err_t set_wall_clock(const cp_v3_time_t *seed) {
    cp_v3_time_t current;
    if (!cp_v3_transport_anchor(seed, now_ms(), &current)) return ESP_ERR_INVALID_STATE;
    struct timeval tv = {.tv_sec = (time_t)(current.utc_ms / 1000u), .tv_usec = (suseconds_t)(current.utc_ms % 1000u) * 1000};
    return settimeofday(&tv, NULL) == 0 ? ESP_OK : ESP_FAIL;
}
esp_err_t cp_v3_transport_time(cp_v3_time_t *out) {
    if (!out) return ESP_ERR_INVALID_ARG;
    memset(out, 0, sizeof *out);
    if (!owner() || !active() || !cp_v3_transport_anchor(&s_anchor, now_ms(), out)) return ESP_ERR_INVALID_STATE;
    return ESP_OK;
}
esp_err_t cp_v3_transport_sync_clock(void) {
    if (!owner() || !active() || !s_date_known || s_anchor.clock_epoch == UINT32_MAX) return ESP_ERR_INVALID_STATE;
    cp_v3_time_t candidate = s_date;
    candidate.clock_epoch = s_anchor.clock_epoch + 1;
    esp_err_t result = set_wall_clock(&candidate);
    if (result == ESP_OK) { s_anchor = candidate; s_date_known = false; }
    return result;
}
bool cp_v3_transport_sha256(void *context, const void *data, size_t length, uint8_t digest[32]) {
    (void)context;
    if ((!data && length) || !digest) return false;
    return mbedtls_sha256(data, length, digest, 0) == 0;
}
void cp_v3_transport_cancel(void) { __atomic_store_n(&s_cancelled, true, __ATOMIC_RELEASE); }

esp_err_t cp_v3_transport_stop(void) {
    if (!__atomic_load_n(&s_owner, __ATOMIC_ACQUIRE)) return ESP_OK;
    if (!owner()) return ESP_ERR_INVALID_STATE;
    cp_v3_transport_cancel();
    portENTER_CRITICAL(&s_dns_lock); ++s_dns_generation; portEXIT_CRITICAL(&s_dns_lock);
    /* Keep ownership/handles if a driver stop fails so cleanup can be retried. */
    if (s_wifi_started) {
        esp_err_t error = esp_wifi_stop();
        if (error != ESP_OK && error != ESP_ERR_WIFI_NOT_STARTED) return error;
        s_wifi_started = false;
    }
    if (s_enterprise) {
        esp_err_t error = esp_wifi_sta_enterprise_disable();
        if (error != ESP_OK) return error;
        s_enterprise = false;
    }
    if (s_eap_configured) {
        esp_eap_client_clear_identity(); esp_eap_client_clear_username(); esp_eap_client_clear_password(); esp_eap_client_clear_ca_cert();
        (void)esp_eap_client_set_domain_name(NULL);
        s_eap_configured = false;
    }
    if (s_wifi_initialized) {
        esp_err_t error = esp_wifi_deinit();
        if (error != ESP_OK) return error;
        s_wifi_initialized = false;
    }
    if (s_wifi_handler) { (void)esp_event_handler_instance_unregister(WIFI_EVENT, ESP_EVENT_ANY_ID, s_wifi_handler); s_wifi_handler = NULL; }
    if (s_ip_handler) { (void)esp_event_handler_instance_unregister(IP_EVENT, ESP_EVENT_ANY_ID, s_ip_handler); s_ip_handler = NULL; }
    if (s_sta) { esp_netif_destroy_default_wifi(s_sta); s_sta = NULL; }
    wipe(s_token, sizeof s_token); memset(&s_config, 0, sizeof s_config);
    memset(&s_anchor, 0, sizeof s_anchor); memset(&s_date, 0, sizeof s_date);
    s_date_known = false; __atomic_store_n(&s_link, false, __ATOMIC_RELEASE);
    __atomic_store_n(&s_owner, NULL, __ATOMIC_RELEASE);
    return ESP_OK;
}
esp_err_t cp_v3_transport_start(const cp_settings_t *settings, const cp_v3_transport_config_t *config) {
    cp_v3_origin_t origin; cp_v3_time_t current;
    if (!settings || !config || !cp_settings_validate(settings) || !cp_v3_transport_origin(config->origin, &origin) ||
        !cp_v3_transport_origin_allowed(config->origin, config->server_ca_pem != NULL) ||
        config->wifi_timeout_ms < 1000 || config->wifi_timeout_ms > 60000 ||
        config->request_timeout_ms < 1000 || config->request_timeout_ms > 30000 ||
        !config->server_clock_error_ms || config->server_clock_error_ms > 3000 ||
        !cp_v3_transport_anchor(&config->clock_seed, now_ms(), &current)) return ESP_ERR_INVALID_ARG;
    if (config->server_ca_pem && (strnlen(config->server_ca_pem, 16385) > 16384 ||
        !strstr(config->server_ca_pem, "-----BEGIN CERTIFICATE-----"))) return ESP_ERR_INVALID_ARG;
#if !CONFIG_MBEDTLS_CERTIFICATE_BUNDLE
    if (!config->server_ca_pem) return ESP_ERR_NOT_SUPPORTED;
#endif
    if (settings->wifi_security == CP_WIFI_ENTERPRISE_PEAP &&
        (!config->eap_ca_pem || strnlen(config->eap_ca_pem, 16385) > 16384 ||
         !strstr(config->eap_ca_pem, "-----BEGIN CERTIFICATE-----") || !config->eap_domain ||
         !*config->eap_domain || strnlen(config->eap_domain, 254) >= 254)) return ESP_ERR_INVALID_ARG;
    TaskHandle_t expected = NULL, self = xTaskGetCurrentTaskHandle();
    if (!__atomic_compare_exchange_n(&s_owner, &expected, self, false, __ATOMIC_ACQ_REL, __ATOMIC_ACQUIRE)) return ESP_ERR_INVALID_STATE;
    __atomic_store_n(&s_cancelled, false, __ATOMIC_RELEASE);
    wifi_mode_t mode;
    /* Never deinitialize another component's already initialized Wi-Fi. */
    esp_err_t result = esp_wifi_get_mode(&mode);
    if (result != ESP_ERR_WIFI_NOT_INIT) { __atomic_store_n(&s_owner, NULL, __ATOMIC_RELEASE); return ESP_ERR_INVALID_STATE; }
    s_config = *config; s_origin = origin; s_anchor = config->clock_seed;
    memcpy(s_token, settings->device_token, sizeof s_token);
    result = set_wall_clock(&s_anchor);
    if (result != ESP_OK) goto failed;
    /* SDK INFO/debug logs can contain identifiers. Suppress transport/radio
     * details; this component emits no credentials, addresses, bodies or URLs. */
    esp_log_level_set("wifi", ESP_LOG_WARN); esp_log_level_set("esp-tls", ESP_LOG_NONE);
    esp_log_level_set("esp-tls-mbedtls", ESP_LOG_NONE); esp_log_level_set("mbedtls", ESP_LOG_NONE);
    result = esp_netif_init(); if (result != ESP_OK) goto failed;
    result = esp_event_loop_create_default(); if (result != ESP_OK && result != ESP_ERR_INVALID_STATE) goto failed;
    if (esp_netif_get_handle_from_ifkey("WIFI_STA_DEF")) { result = ESP_ERR_INVALID_STATE; goto failed; }
    s_sta = esp_netif_create_default_wifi_sta();
    if (!s_sta) { result = ESP_ERR_NO_MEM; goto failed; }
    wifi_init_config_t init = WIFI_INIT_CONFIG_DEFAULT();
    result = esp_wifi_init(&init); if (result != ESP_OK) goto failed;
    s_wifi_initialized = true;
    result = esp_wifi_set_storage(WIFI_STORAGE_RAM); if (result != ESP_OK) goto failed;
    result = esp_event_handler_instance_register(WIFI_EVENT, ESP_EVENT_ANY_ID, wifi_event, NULL, &s_wifi_handler); if (result != ESP_OK) goto failed;
    result = esp_event_handler_instance_register(IP_EVENT, ESP_EVENT_ANY_ID, wifi_event, NULL, &s_ip_handler); if (result != ESP_OK) goto failed;
    wifi_config_t wifi = {0};
    memcpy(wifi.sta.ssid, settings->ssid, strlen(settings->ssid));
    memcpy(wifi.sta.password, settings->password, strlen(settings->password));
    wifi.sta.threshold.authmode = settings->wifi_security == CP_WIFI_OPEN ? WIFI_AUTH_OPEN :
        settings->wifi_security == CP_WIFI_ENTERPRISE_PEAP ? WIFI_AUTH_WPA2_ENTERPRISE : WIFI_AUTH_WPA2_PSK;
    wifi.sta.pmf_cfg.capable = true;
    result = esp_wifi_set_mode(WIFI_MODE_STA);
    if (result == ESP_OK) result = esp_wifi_set_config(WIFI_IF_STA, &wifi);
    wipe(&wifi, sizeof wifi); if (result != ESP_OK) goto failed;
    if (settings->wifi_security == CP_WIFI_ENTERPRISE_PEAP) {
        s_eap_configured = true;
        result = esp_eap_client_use_default_cert_bundle(false);
        if (result == ESP_OK) result = esp_eap_client_set_ca_cert((const unsigned char *)config->eap_ca_pem, strlen(config->eap_ca_pem) + 1);
        if (result == ESP_OK) result = esp_eap_client_set_domain_name(config->eap_domain);
        if (result == ESP_OK) result = esp_eap_client_set_disable_time_check(false);
        if (result == ESP_OK) result = esp_eap_client_set_eap_methods(ESP_EAP_TYPE_PEAP);
        if (result == ESP_OK) result = esp_eap_client_set_identity((const unsigned char *)settings->eap_identity, strlen(settings->eap_identity));
        if (result == ESP_OK) result = esp_eap_client_set_username((const unsigned char *)settings->eap_username, strlen(settings->eap_username));
        if (result == ESP_OK) result = esp_eap_client_set_password((const unsigned char *)settings->eap_password, strlen(settings->eap_password));
        if (result == ESP_OK) result = esp_wifi_sta_enterprise_enable();
        if (result != ESP_OK) goto failed;
        s_enterprise = true;
    }
    result = esp_wifi_start(); if (result != ESP_OK) goto failed;
    s_wifi_started = true;
    result = esp_wifi_connect(); if (result != ESP_OK) goto failed;
    uint64_t deadline = now_ms() + config->wifi_timeout_ms;
    while (before(deadline) && !__atomic_load_n(&s_link, __ATOMIC_ACQUIRE)) pause_io();
    if (!before(deadline)) { result = cancelled_or_timeout(); goto failed; }
    return ESP_OK;
failed: {
    esp_err_t cleanup = cp_v3_transport_stop();
    return cleanup == ESP_OK ? result : cleanup;
    }
}

static bool want_io(ssize_t value) { return value == ESP_TLS_ERR_SSL_WANT_READ || value == ESP_TLS_ERR_SSL_WANT_WRITE; }
static esp_err_t write_all(esp_tls_t *tls, const void *bytes, size_t n, uint64_t deadline,
    cp_v3_transport_response_t *out) {
    const uint8_t *p = bytes;
    while (n && before(deadline)) {
        ssize_t written = esp_tls_conn_write(tls, p, n);
        out->last_write = (int32_t)written;
        if (want_io(written)) { pause_io(); continue; }
        if (written <= 0 || (size_t)written > n) { out->io_error = (int32_t)written; return ESP_FAIL; }
        out->written_bytes += (uint32_t)written;
        p += written; n -= (size_t)written;
    }
    return n ? cancelled_or_timeout() : ESP_OK;
}
static esp_err_t request_mode(cp_v3_http_method_t method, const char *path,
    const void *body, size_t length, char *response, size_t capacity,
    cp_v3_transport_response_t *out,bool receipt_only) {
    if (out) memset(out, 0, sizeof *out);
    if (response && capacity) response[0] = 0;
    if (!out || !response || !capacity || capacity > CP_V3_TRANSPORT_RESPONSE_MAX + 1u ||
        !cp_v3_transport_path(method, path) || (receipt_only&&!cp_v3_transport_receipt_only_path(method,path)) ||
        (!body && length) || length > CP_V3_TRANSPORT_REQUEST_MAX ||
        (method == CP_V3_HTTP_GET && length) || (method == CP_V3_HTTP_POST && !length)) return ESP_ERR_INVALID_ARG;
    if (!owner() || !active() || !s_wifi_initialized || !__atomic_load_n(&s_link, __ATOMIC_ACQUIRE)) return ESP_ERR_INVALID_STATE;
    cp_v3_time_t current;
    if (cp_v3_transport_time(&current) != ESP_OK) return ESP_ERR_INVALID_STATE;
    s_date_known = false;
    uint64_t started = now_ms(), deadline = started + s_config.request_timeout_ms;
    out->stage = CP_V3_TRANSPORT_DNS;
    char address[16]; esp_err_t result = resolve(address, deadline);
    out->dns_error = result;
    if (result != ESP_OK) { out->io_error = result; return result; }
    out->stage = CP_V3_TRANSPORT_TLS;
    esp_tls_t *tls = esp_tls_init();
    if (!tls) { out->io_error = ESP_ERR_NO_MEM; return ESP_ERR_NO_MEM; }
    esp_tls_cfg_t cfg = {.non_block = true, .timeout_ms = (int)s_config.request_timeout_ms,
        .common_name = s_origin.host};
    if (s_config.server_ca_pem) {
        cfg.cacert_buf = (const unsigned char *)s_config.server_ca_pem;
        cfg.cacert_bytes = strlen(s_config.server_ca_pem) + 1;
    }
#if CONFIG_MBEDTLS_CERTIFICATE_BUNDLE
    else cfg.crt_bundle_attach = esp_crt_bundle_attach;
#endif
    int connected = 0;
    while (before(deadline)) {
        connected = esp_tls_conn_new_async(address, strlen(address), s_origin.port, &cfg, tls);
        out->tls_connected = connected;
        if (connected) break;
        pause_io();
    }
    if (!before(deadline)) { result = cancelled_or_timeout(); goto done; }
    if (connected != 1) { out->io_error = connected; result = ESP_FAIL; goto done; }
    char headers[1024], hash[65] = {0}; uint8_t digest[32];
    if (method == CP_V3_HTTP_POST) {
        if (!cp_v3_transport_sha256(NULL, body, length, digest)) { result = ESP_FAIL; goto done; }
        static const char hex[] = "0123456789abcdef";
        for (unsigned i = 0; i < 32; i++) { hash[i * 2] = hex[digest[i] >> 4]; hash[i * 2 + 1] = hex[digest[i] & 15]; }
        wipe(digest, sizeof digest);
    }
    int n = snprintf(headers, sizeof headers, "%s %s HTTP/1.1\r\nHost: %s\r\nAuthorization: Bearer %s\r\n"
        "Accept: application/json\r\nAccept-Encoding: identity\r\nConnection: close\r\n"
        "Content-Type: application/json\r\nContent-Length: %u\r\n%s%s%s%s\r\n",
        method == CP_V3_HTTP_GET ? "GET" : "POST", path, s_origin.authority, s_token, (unsigned)length,
        method == CP_V3_HTTP_POST ? "X-Body-SHA256: " : "", hash, method == CP_V3_HTTP_POST ? "\r\n" : "",
        receipt_only?"X-Receipt-Only: 1\r\n":"");
    if (n <= 0 || (size_t)n >= sizeof headers) { wipe(headers, sizeof headers); result = ESP_ERR_INVALID_SIZE; goto done; }
    out->stage = CP_V3_TRANSPORT_REQUEST_HEADERS;
    result = write_all(tls, headers, (size_t)n, deadline, out); wipe(headers, sizeof headers);
    if (result != ESP_OK) goto done;
    if (length) {
        out->stage = CP_V3_TRANSPORT_REQUEST_BODY;
        result = write_all(tls, body, length, deadline, out); if (result != ESP_OK) goto done;
    }
    cp_v3_http_response_t parsed; cp_v3_http_init(&parsed, response, capacity);
    uint8_t chunk[512];
    out->stage = CP_V3_TRANSPORT_RESPONSE_HEADERS;
    while (before(deadline) && !parsed.complete) {
        ssize_t count = esp_tls_conn_read(tls, chunk, sizeof chunk);
        out->last_read = (int32_t)count;
        if (want_io(count)) { pause_io(); continue; }
        if (count < 0) { out->io_error = (int32_t)count; result = ESP_FAIL; break; }
        if (!count) { result = cp_v3_http_eof(&parsed) ? ESP_OK : ESP_ERR_INVALID_RESPONSE; break; }
        out->received_bytes += (uint32_t)count;
        bool parsed_ok = cp_v3_http_feed(&parsed, chunk, (size_t)count);
        if (parsed.headers_done) out->stage = CP_V3_TRANSPORT_RESPONSE_BODY;
        if (!parsed_ok) { result = ESP_ERR_INVALID_RESPONSE; break; }
    }
    if (!before(deadline)) result = cancelled_or_timeout();
    if (result == ESP_OK && !parsed.complete) result = ESP_ERR_INVALID_RESPONSE;
    if (result == ESP_OK) {
        out->stage = CP_V3_TRANSPORT_COMPLETE;
        out->http_status = parsed.parser.status_code; out->body_bytes = parsed.used; out->complete = true;
        uint64_t elapsed = now_ms() - started;
        uint64_t uncertainty = (elapsed + 1u) / 2u + 500u + s_config.server_clock_error_ms;
        if (parsed.date_valid && uncertainty <= 5000 && out->http_status >= 200 && out->http_status < 300) {
            s_date = (cp_v3_time_t){.mono_ms = started + elapsed / 2u, .utc_ms = parsed.date_ms + 500u,
                .clock_epoch = s_anchor.clock_epoch, .uncertainty_ms = (uint32_t)uncertainty};
            s_date_known = out->date_known = true; out->server_time = s_date;
        }
        /* Redirects are returned as status/body only; no Location is followed. */
    }
    wipe(chunk, sizeof chunk);
done:
    if (result != ESP_OK) {
        response[0] = 0; cp_v3_transport_clear_response(out);
        if (!out->io_error) out->io_error = result;
        esp_tls_error_handle_t handle;
        if (esp_tls_get_error_handle(tls, &handle) == ESP_OK) {
            int code = 0, flags = 0;
            out->tls_esp_error = esp_tls_get_and_clear_last_error(handle, &code, &flags);
            out->tls_stack_error = code; out->tls_verify_flags = flags;
        }
    }
    (void)esp_tls_conn_destroy(tls);
    return result;
}
esp_err_t cp_v3_transport_request(cp_v3_http_method_t method,const char *path,
    const void *body,size_t length,char *response,size_t capacity,cp_v3_transport_response_t *out) {
    return request_mode(method,path,body,length,response,capacity,out,false);
}
esp_err_t cp_v3_transport_request_receipt_only(cp_v3_http_method_t method,const char *path,
    const void *body,size_t length,char *response,size_t capacity,cp_v3_transport_response_t *out) {
    return request_mode(method,path,body,length,response,capacity,out,true);
}
