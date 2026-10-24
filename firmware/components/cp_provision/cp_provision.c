#include "cp_provision.h"
#include "cp_provision_guard.h"
#include "protocomm.h"
#include "protocomm_ble.h"
#include "protocomm_security1.h"
#include "esp_event.h"
#include "esp_http_server.h"
#include "esp_netif.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "esp_bt.h"
#include "cJSON.h"
#include "freertos/FreeRTOS.h"
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <ctype.h>

#define REQUEST_MAX 1024
#define SESSION_US (10LL * 60 * 1000000)
static cp_provision_snapshot_t state;
static portMUX_TYPE lock = portMUX_INITIALIZER_UNLOCKED;
static protocomm_t *pc;
static protocomm_security1_params_t pop;
static httpd_handle_t http;
static esp_netif_t *ap_netif;
static bool wifi_initialized;
static bool ble_started;
static esp_err_t teardown_fault;
static cp_provision_submit_fn submit_fn;
static void *submit_ctx;
static char nonce[33];
static int64_t expires;
static unsigned proof_failures;
static uint32_t session_sequence;
static uint8_t attempt_digest[32];
static const char *str(const cJSON *obj, const char *key) {
    const cJSON *item = cJSON_GetObjectItemCaseSensitive(obj, key);
    return cJSON_IsString(item) ? item->valuestring : NULL;
}
static bool same(const char *a, const char *b) {
    if (!a || !b || strlen(a) != strlen(b)) return false;
    unsigned diff = 0; for (size_t i = 0; a[i]; i++) diff |= (unsigned char)a[i] ^ (unsigned char)b[i]; return diff == 0;
}
static void wipe(void *p, size_t n) { volatile unsigned char *v = p; while (n--) *v++ = 0; }
void cp_provision_snapshot(cp_provision_snapshot_t *out) { if (!out) return; portENTER_CRITICAL(&lock); *out = state; portEXIT_CRITICAL(&lock); }
void cp_provision_set_status(const char *value, const char *reason) { portENTER_CRITICAL(&lock); snprintf(state.state, sizeof(state.state), "%s", value ? value : "unknown"); snprintf(state.reason, sizeof(state.reason), "%s", reason ? reason : ""); portEXIT_CRITICAL(&lock); }
static bool copy_field(char *dest, size_t cap, const cJSON *obj, const char *key) { const char *v = str(obj, key); if (!v || strlen(v) >= cap) return false; memcpy(dest, v, strlen(v) + 1); return true; }
static cJSON *parse_request(const char *data, size_t len) {
    /* All v1 fields are scalar. Bound nesting before cJSON recursion. */
    unsigned depth = 0; bool quoted = false, escaped = false;
    for (size_t i = 0; i < len; i++) {
        unsigned char ch = data[i]; if (!ch) return NULL;
        if (quoted) { if (escaped) escaped = false; else if (ch == 92) escaped = true; else if (ch == 34) quoted = false; }
        else if (ch == 34) quoted = true;
        else if (ch == '{' || ch == '[') { if (++depth > 2) return NULL; }
        else if (ch == '}' || ch == ']') { if (!depth) return NULL; --depth; }
    }
    if (quoted || depth) return NULL;
    const char *end = NULL; cJSON *r = cJSON_ParseWithLengthOpts(data, len, &end, false);
    while (end && end < data + len && isspace((unsigned char)*end)) ++end;
    if (!cJSON_IsObject(r) || end != data + len) { cJSON_Delete(r); return NULL; }
    return r;
}
static void delete_request(cJSON *request) {
    const char *keys[] = { "password", "device_token", "proof" };
    for (unsigned i = 0; request && i < 3; i++) { cJSON *v = cJSON_GetObjectItemCaseSensitive(request, keys[i]); if (cJSON_IsString(v)) wipe(v->valuestring, strlen(v->valuestring)); }
    cJSON_Delete(request);
}
static cJSON *reply(bool ok, const char *reason) { cJSON *r = cJSON_CreateObject(); if (!r) return NULL; cJSON_AddNumberToObject(r, "v", 1); cJSON_AddBoolToObject(r, "ok", ok); if (reason) cJSON_AddStringToObject(r, "reason", reason); return r; }
/* JSON is already decrypted by protocomm, or arrived over the strong WPA2 AP
 * after Host/Origin/content-type checks. Never return/log submitted secrets. */
static cJSON *handle(const cJSON *request, bool local_ap) {
    if (!state.active || esp_timer_get_time() > expires) return reply(false, "setup_expired");
    const cJSON *version = cJSON_GetObjectItemCaseSensitive(request, "v");
    if (!cJSON_IsNumber(version) || version->valuedouble != 1) return reply(false, "unsupported_version");
    if (local_ap && (!same(str(request, "nonce"), nonce) || !same(str(request, "proof"), state.proof))) {
        if (++proof_failures >= 8) expires = 0;
        return reply(false, "invalid_setup_proof");
    }
    const char *op = str(request, "op"); if (!op) return reply(false, "invalid_operation");
    if (!strcmp(op, "info") || !strcmp(op, "status")) {
        cp_provision_snapshot_t s; cp_provision_snapshot(&s);
        cJSON *r = reply(true, NULL); if (!r) return NULL;
        cJSON_AddStringToObject(r, "node_id", s.node_id); cJSON_AddStringToObject(r, "board", "FoloToy AI Passport / ESP32-C3");
        cJSON_AddStringToObject(r, "state", s.state); cJSON_AddStringToObject(r, "attempt_id", s.attempt_id); return r;
    }
    if (strcmp(op, "configure")) return reply(false, "invalid_operation");
    const char *attempt = str(request, "attempt_id");
    if (!cp_provision_uuid_v4(attempt)) return reply(false, "invalid_attempt_id");
    cp_settings_t candidate = { .version = CP_SETTINGS_VERSION };
    snprintf(candidate.node_id, sizeof(candidate.node_id), "%s", state.node_id);
    snprintf(candidate.api_origin, sizeof(candidate.api_origin), "%s", CP_API_ORIGIN);
    if (!copy_field(candidate.ssid, sizeof(candidate.ssid), request, "ssid") ||
        !copy_field(candidate.password, sizeof(candidate.password), request, "password") ||
        !copy_field(candidate.device_token, sizeof(candidate.device_token), request, "device_token") ||
        !same(str(request, "node_id"), state.node_id) || !cp_settings_validate(&candidate)) {
        wipe(&candidate, sizeof(candidate)); return reply(false, "invalid_settings");
    }
    uint8_t digest[32];
    if (!cp_provision_settings_digest(&candidate, digest)) { wipe(&candidate, sizeof(candidate)); return reply(false, "settings_hash_failed"); }
    if (state.attempt_id[0]) {
        bool same_id = !strcmp(attempt, state.attempt_id);
        bool same_body = cp_provision_digest_equal(attempt_digest, digest);
        wipe(&candidate, sizeof(candidate)); wipe(digest, sizeof(digest));
        if (!same_id) return reply(false, "attempt_in_progress");
        if (!same_body) return reply(false, "attempt_payload_changed");
        cJSON *r = reply(true, NULL); if (!r) return NULL;
        cJSON_AddStringToObject(r, "state", state.state); cJSON_AddStringToObject(r, "attempt_id", attempt); return r;
    }
    esp_err_t err = submit_fn(&candidate, attempt, submit_ctx); wipe(&candidate, sizeof(candidate));
    if (err != ESP_OK) { wipe(digest, sizeof(digest)); return reply(false, "supervisor_busy"); }
    memcpy(attempt_digest, digest, sizeof(attempt_digest)); wipe(digest, sizeof(digest));
    portENTER_CRITICAL(&lock); snprintf(state.attempt_id, sizeof(state.attempt_id), "%s", attempt); snprintf(state.state, sizeof(state.state), "received"); portEXIT_CRITICAL(&lock);
    cJSON *r = reply(true, NULL); cJSON_AddStringToObject(r, "state", "received"); cJSON_AddStringToObject(r, "attempt_id", attempt); return r;
}
static esp_err_t app_handler(uint32_t session_id, const uint8_t *in, ssize_t len, uint8_t **out, ssize_t *out_len, void *ctx) {
    (void)session_id; (void)ctx;
    if (len <= 0 || len > 512) return ESP_ERR_INVALID_SIZE;
    cJSON *request = parse_request((const char *)in, (size_t)len);
    cJSON *result = request ? handle(request, false) : reply(false, "invalid_json");
    delete_request(request);
    char *encoded = result ? cJSON_PrintUnformatted(result) : NULL; cJSON_Delete(result);
    if (!encoded) return ESP_ERR_NO_MEM;
    *out = (uint8_t *)encoded; *out_len = strlen(encoded); return ESP_OK;
}
static bool local_request(httpd_req_t *req, bool post) {
    char host[48], origin[64], content[48];
    if (httpd_req_get_hdr_value_str(req, "Host", host, sizeof(host)) != ESP_OK ||
        (strcmp(host, "192.168.4.1") && strcmp(host, "192.168.4.1:80"))) return false;
    if (httpd_req_get_hdr_value_len(req, "Origin") &&
        (httpd_req_get_hdr_value_str(req, "Origin", origin, sizeof(origin)) != ESP_OK || strcmp(origin, "http://192.168.4.1"))) return false;
    if (post && (httpd_req_get_hdr_value_str(req, "Content-Type", content, sizeof(content)) != ESP_OK || strcmp(content, "application/json"))) return false;
    return state.active && esp_timer_get_time() <= expires;
}
static void headers(httpd_req_t *req) {
    httpd_resp_set_hdr(req, "Cache-Control", "no-store"); httpd_resp_set_hdr(req, "X-Content-Type-Options", "nosniff");
    httpd_resp_set_hdr(req, "Referrer-Policy", "no-referrer");
    httpd_resp_set_hdr(req, "Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
}
#include "setup_page.h"
static esp_err_t page_handler(httpd_req_t *req) {
    if (!local_request(req, false)) return httpd_resp_send_err(req, HTTPD_403_FORBIDDEN, "Local setup only");
    headers(req); httpd_resp_set_type(req, "text/html; charset=utf-8");
    httpd_resp_sendstr_chunk(req, CP_SETUP_HEAD); httpd_resp_sendstr_chunk(req, state.node_id);
    httpd_resp_sendstr_chunk(req, CP_SETUP_MID); httpd_resp_sendstr_chunk(req, nonce);
    httpd_resp_sendstr_chunk(req, CP_SETUP_END); return httpd_resp_send_chunk(req, NULL, 0);
}
static esp_err_t configure_handler(httpd_req_t *req) {
    if (!local_request(req, true)) return httpd_resp_send_err(req, HTTPD_403_FORBIDDEN, "Local setup only");
    if (req->content_len <= 0 || req->content_len > REQUEST_MAX) return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Invalid size");
    char *body = calloc(1, req->content_len + 1); if (!body) return ESP_ERR_NO_MEM;
    int pos = 0; while (pos < req->content_len) { int n = httpd_req_recv(req, body + pos, req->content_len - pos); if (n <= 0) { wipe(body, req->content_len + 1); free(body); return ESP_FAIL; } pos += n; }
    cJSON *request = parse_request(body, (size_t)pos); wipe(body, req->content_len + 1); free(body);
    cJSON *result = request ? handle(request, true) : reply(false, "invalid_json");
    delete_request(request); char *encoded = result ? cJSON_PrintUnformatted(result) : NULL; cJSON_Delete(result);
    if (!encoded) return ESP_ERR_NO_MEM;
    headers(req); httpd_resp_set_type(req, "application/json"); esp_err_t err = httpd_resp_sendstr(req, encoded); free(encoded); return err;
}
static esp_err_t start_ap(void) {
    esp_err_t err = esp_netif_init(); if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) return err;
    ap_netif = esp_netif_create_default_wifi_ap(); if (!ap_netif) return ESP_ERR_NO_MEM;
    wifi_init_config_t init = WIFI_INIT_CONFIG_DEFAULT(); if ((err = esp_wifi_init(&init)) != ESP_OK) return err; wifi_initialized = true;
    wifi_config_t cfg = { 0 }; memcpy(cfg.ap.ssid, state.service_name, strlen(state.service_name)); cfg.ap.ssid_len = strlen(state.service_name);
    memcpy(cfg.ap.password, state.ap_password, strlen(state.ap_password)); cfg.ap.authmode = WIFI_AUTH_WPA2_PSK; cfg.ap.max_connection = 1; cfg.ap.channel = 1;
    if ((err = esp_wifi_set_storage(WIFI_STORAGE_RAM)) != ESP_OK || (err = esp_wifi_set_mode(WIFI_MODE_AP)) != ESP_OK ||
        (err = esp_wifi_set_config(WIFI_IF_AP, &cfg)) != ESP_OK || (err = esp_wifi_start()) != ESP_OK) { wipe(&cfg, sizeof(cfg)); return err; }
    wipe(&cfg, sizeof(cfg)); httpd_config_t config = HTTPD_DEFAULT_CONFIG(); config.max_uri_handlers = 2; config.max_open_sockets = 2; config.stack_size = 6144; config.recv_wait_timeout = 5; config.send_wait_timeout = 5;
    if ((err = httpd_start(&http, &config)) != ESP_OK) return err;
    httpd_uri_t root = { .uri = "/", .method = HTTP_GET, .handler = page_handler };
    httpd_uri_t setup = { .uri = "/configure", .method = HTTP_POST, .handler = configure_handler };
    if ((err = httpd_register_uri_handler(http, &root)) != ESP_OK) return err;
    return httpd_register_uri_handler(http, &setup);
}
esp_err_t cp_provision_start(cp_provision_mode_t mode, const char *node, const char *proof, cp_provision_submit_fn submit, void *ctx) {
    if (state.active || !node || strlen(node) != 15 || !proof || strlen(proof) != 32 || !submit || mode > CP_PROVISION_SOFTAP) return ESP_ERR_INVALID_ARG;
    for (unsigned i = 0; i < 32; i++) if (!isxdigit((unsigned char)proof[i])) return ESP_ERR_INVALID_ARG;
    memset(&state, 0, sizeof(state)); state.active = true; state.mode = mode;
    snprintf(state.node_id, sizeof(state.node_id), "%s", node); snprintf(state.proof, sizeof(state.proof), "%s", proof);
    snprintf(state.service_name, sizeof(state.service_name), "CampusPulse-%s", node + 9);
    /* RF may still be off: random bytes provide variation, never the security
     * claim. HMAC is keyed by the persistent proof generated with true entropy. */
    uint8_t context[44]; esp_fill_random(context, 32);
    uint64_t now = (uint64_t)esp_timer_get_time(); uint32_t seq = ++session_sequence;
    for (unsigned i = 0; i < 8; i++) context[32+i] = (uint8_t)(now >> (56-8*i));
    for (unsigned i = 0; i < 4; i++) context[40+i] = (uint8_t)(seq >> (24-8*i));
    bool derived = cp_provision_session_secrets(state.proof, context, sizeof(context), state.ap_password, nonce);
    wipe(context, sizeof(context)); wipe(attempt_digest, sizeof(attempt_digest));
    if (!derived) { cp_provision_stop(); return ESP_FAIL; }
    submit_fn = submit; submit_ctx = ctx; expires = esp_timer_get_time() + SESSION_US; proof_failures = 0; cp_provision_set_status("waiting", "");
    esp_err_t err = esp_event_loop_create_default(); if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) goto fail;
    if (mode == CP_PROVISION_SOFTAP) { err = start_ap(); if (err != ESP_OK) goto fail; return ESP_OK; }
    pc = protocomm_new(); if (!pc) { err = ESP_ERR_NO_MEM; goto fail; }
    static protocomm_ble_name_uuid_t lookup[] = { {"prov-session", 0xff51}, {"cp-setup", 0xff52} };
    protocomm_ble_config_t ble = { .service_uuid = {0x01,0x7a,0xc6,0x42,0xaf,0x8b,0x48,0xa8,0x1d,0x4f,0x3a,0x7b,0x00,0x00,0xc0,0xf0}, .nu_lookup_count = 2, .nu_lookup = lookup };
    snprintf(ble.device_name, sizeof(ble.device_name), "%s", state.service_name);
    if ((err = protocomm_ble_start(pc, &ble)) != ESP_OK) {
        /* IDF can fail after controller initialization and free its private
         * transport state. Do not retry or assume ownership was released. */
        if (esp_bt_controller_get_status() != ESP_BT_CONTROLLER_STATUS_IDLE) {
            teardown_fault = err; cp_provision_set_status("stop_failed", "Bluetooth start incomplete; restart required"); return err;
        }
        goto fail;
    }
    ble_started = true;
    pop.data = (const uint8_t *)state.proof; pop.len = 32;
    if ((err = protocomm_set_security(pc, "prov-session", &protocomm_security1, &pop)) != ESP_OK ||
        (err = protocomm_add_endpoint(pc, "cp-setup", app_handler, NULL)) != ESP_OK) goto fail;
    return ESP_OK;
fail: { esp_err_t stopped = cp_provision_stop(); return stopped == ESP_OK ? err : stopped; }
}
esp_err_t cp_provision_stop(void) {
    if (teardown_fault != ESP_OK) return teardown_fault;
    esp_err_t err;
    if (http) { if ((err = httpd_stop(http)) != ESP_OK) goto failed; http = NULL; }
    if (pc) {
        if (ble_started) {
            err = protocomm_ble_stop(pc);
            /* ESP-IDF 5.5.3 discards nimble_port_deinit's return. Verify the
             * controller reached IDLE, which follows host teardown. */
            if (err == ESP_OK && esp_bt_controller_get_status() != ESP_BT_CONTROLLER_STATUS_IDLE) err = ESP_ERR_INVALID_STATE;
            if (err != ESP_OK) { teardown_fault = err; goto failed; }
            ble_started = false;
        }
        protocomm_delete(pc); pc = NULL;
    }
    if (wifi_initialized) {
        err = esp_wifi_stop();
        if (err != ESP_OK && err != ESP_ERR_WIFI_NOT_STARTED) goto failed;
        if ((err = esp_wifi_deinit()) != ESP_OK) goto failed;
        wifi_initialized = false;
    }
    if (ap_netif) { esp_netif_destroy_default_wifi(ap_netif); ap_netif = NULL; }
    portENTER_CRITICAL(&lock); state.active = false; wipe(state.proof, sizeof(state.proof)); wipe(state.ap_password, sizeof(state.ap_password)); portEXIT_CRITICAL(&lock);
    wipe(nonce, sizeof(nonce)); wipe(attempt_digest, sizeof(attempt_digest)); return ESP_OK;
failed:
    /* Preserve our handles and active ownership. Upstream BLE failure is
     * irrecoverable in this boot; AP shutdown may be retried by the supervisor. */
    cp_provision_set_status("stop_failed", "Transport shutdown failed; restart required");
    return err;
}
