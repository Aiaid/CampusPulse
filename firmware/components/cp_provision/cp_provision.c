#include "cp_provision.h"
#include "cp_provision_guard.h"
#include "protocomm.h"
#include "protocomm_ble.h"
#include "cp_provision_security2.h"
#include "esp_event.h"
#include "esp_http_server.h"
#include "esp_netif.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "esp_bt.h"
#include "esp_app_desc.h"
#include "cJSON.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <ctype.h>

#define REQUEST_MAX 1024
#define SESSION_US (5LL * 60 * 1000000)
#define MAX_FAILURES 5
static cp_provision_snapshot_t state;
static portMUX_TYPE lock = portMUX_INITIALIZER_UNLOCKED;
static protocomm_t *pc;
static protocomm_security2_params_t srp;
static SemaphoreHandle_t session_mutex;
static bool security_fatal;
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
static char diagnostic_boot_id[37],diagnostic_attempt_id[37];
static uint32_t diagnostic_reset_reason;
static cp_network_diagnostic_t diagnostic;
static cp_network_attempt_t previous_attempt;
static bool have_previous_attempt;
static esp_err_t diagnostic_history_error;
static cp_provision_credential_resolver_fn credential_resolver;
static void *credential_context;
static const char *str(const cJSON *obj, const char *key) {
    const cJSON *item = cJSON_GetObjectItemCaseSensitive(obj, key);
    return cJSON_IsString(item) ? item->valuestring : NULL;
}
static bool same(const char *a, const char *b) {
    if (!a || !b || strlen(a) != strlen(b)) return false;
    unsigned diff = 0; for (size_t i = 0; a[i]; i++) diff |= (unsigned char)a[i] ^ (unsigned char)b[i]; return diff == 0;
}
static void wipe(void *p, size_t n) { volatile unsigned char *v = p; while (n--) *v++ = 0; }
static bool take_session(void) {
    SemaphoreHandle_t mutex=__atomic_load_n(&session_mutex,__ATOMIC_ACQUIRE);
    if(!mutex) {
        SemaphoreHandle_t created=xSemaphoreCreateMutex();if(!created)return false;
        SemaphoreHandle_t expected=NULL;
        if(!__atomic_compare_exchange_n(&session_mutex,&expected,created,false,__ATOMIC_ACQ_REL,__ATOMIC_ACQUIRE))vSemaphoreDelete(created);
        mutex=__atomic_load_n(&session_mutex,__ATOMIC_ACQUIRE);
    }
    return xSemaphoreTake(mutex,0)==pdTRUE;
}
static void give_session(void){xSemaphoreGive(session_mutex);}
static bool session_allowed(void) {
    if(!state.active || security_fatal)return false;
    if(proof_failures>=MAX_FAILURES || esp_timer_get_time()>=expires) {
        cp_provision_set_status(proof_failures>=MAX_FAILURES?"locked":"expired","Start a new setup session");
        portENTER_CRITICAL(&lock);wipe(state.proof,sizeof state.proof);wipe(state.ap_password,sizeof state.ap_password);portEXIT_CRITICAL(&lock);
        return false;
    }
    return true;
}
static void authentication_failure(void){if(proof_failures<MAX_FAILURES)proof_failures++;(void)session_allowed();}
static bool security_enter(void){if(!take_session())return false;if(state.mode!=CP_PROVISION_BLE||!session_allowed()){give_session();return false;}return true;}
static void security_failure(void){authentication_failure();}
static void security_broken(void){security_fatal=true;teardown_fault=ESP_FAIL;cp_provision_set_status("failed","Security context failed; restart required");}
void cp_provision_snapshot(cp_provision_snapshot_t *out) {
    if(!out)return;
    if(take_session()){(void)session_allowed();give_session();}
    portENTER_CRITICAL(&lock);*out=state;portEXIT_CRITICAL(&lock);
}
void cp_provision_set_status(const char *value, const char *reason) { portENTER_CRITICAL(&lock); snprintf(state.state, sizeof(state.state), "%s", value ? value : "unknown"); snprintf(state.reason, sizeof(state.reason), "%s", reason ? reason : ""); portEXIT_CRITICAL(&lock); }
esp_err_t cp_provision_bind_context(const char *node,const char *boot,uint32_t reset,
    cp_provision_credential_resolver_fn resolver,void *context) {
    if(!node||strlen(node)!=15||strncmp(node,"cp_",3)||!cp_provision_uuid_v4(boot))return ESP_ERR_INVALID_ARG;
    if(!take_session())return ESP_ERR_INVALID_STATE;
    if(state.active){give_session();return ESP_ERR_INVALID_STATE;}
    portENTER_CRITICAL(&lock);snprintf(state.node_id,sizeof state.node_id,"%s",node);
    snprintf(diagnostic_boot_id,sizeof diagnostic_boot_id,"%s",boot);diagnostic_reset_reason=reset;
    if(!state.state[0])snprintf(state.state,sizeof state.state,"idle");
    portEXIT_CRITICAL(&lock);
    credential_resolver=resolver;credential_context=context;give_session();return ESP_OK;
}
void cp_provision_set_diagnostic(const cp_network_diagnostic_t *value,const char *attempt) {
    if(!cp_network_diag_valid(value)||(attempt&&!cp_provision_uuid_v4(attempt)))return;
    portENTER_CRITICAL(&lock);diagnostic=*value;
    if(attempt)memcpy(diagnostic_attempt_id,attempt,37);
    portEXIT_CRITICAL(&lock);
}
void cp_provision_set_previous_attempt(const cp_network_attempt_t *value,esp_err_t history_error) {
    bool valid=cp_network_attempt_valid(value);
    portENTER_CRITICAL(&lock);have_previous_attempt=valid;
    if(valid)previous_attempt=*value;else memset(&previous_attempt,0,sizeof previous_attempt);
    diagnostic_history_error=history_error;portEXIT_CRITICAL(&lock);
}
static bool saved_credential(const char *node,char *token,size_t capacity,uint32_t *generation) {
    return credential_resolver&&credential_resolver(node,token,capacity,generation,credential_context);
}
static cJSON *diagnostic_json(const cp_network_diagnostic_t *d) {
    cJSON *o=cJSON_CreateObject();if(!o)return NULL;
    bool ok=cJSON_AddStringToObject(o,"stage",cp_network_diag_stage_name(d->stage)) &&
        cJSON_AddStringToObject(o,"code",cp_network_diag_code_name(d->code)) &&
        cJSON_AddNumberToObject(o,"esp_err",d->esp_err) && cJSON_AddNumberToObject(o,"http_status",d->http_status) &&
        cJSON_AddNumberToObject(o,"wifi_reason",d->wifi_reason) && cJSON_AddNumberToObject(o,"tls_code",d->tls_code) &&
        cJSON_AddNumberToObject(o,"tls_flags",d->tls_flags) && cJSON_AddNumberToObject(o,"elapsed_ms",d->elapsed_ms) &&
        cJSON_AddBoolToObject(o,"retryable",d->retryable!=0);
    if(!ok){cJSON_Delete(o);return NULL;}return o;
}
static bool copy_field(char *dest, size_t cap, const cJSON *obj, const char *key) { const char *v = str(obj, key); if (!v || strlen(v) >= cap) return false; memcpy(dest, v, strlen(v) + 1); return true; }
static cJSON *parse_request(const char *data, size_t len) {
    /* All v1 fields are scalar. Bound nesting before cJSON recursion. */
    unsigned depth = 0; bool quoted = false, escaped = false;
    for (size_t i = 0; i < len; i++) {
        unsigned char ch = data[i]; if (!ch) return NULL;
        if (quoted) { if (escaped) { if(ch=='u'&&i+4<len&&!memcmp(data+i+1,"0000",4))return NULL; escaped = false; } else if (ch == 92) escaped = true; else if (ch == 34) quoted = false; }
        else if (ch == 34) quoted = true;
        else if (ch == '{' || ch == '[') { if (++depth > 2) return NULL; }
        else if (ch == '}' || ch == ']') { if (!depth) return NULL; --depth; }
    }
    if (quoted || depth) return NULL;
    const char *end = NULL; cJSON *r = cJSON_ParseWithLengthOpts(data, len, &end, false);
    while (end && end < data + len && isspace((unsigned char)*end)) ++end;
    if (!cJSON_IsObject(r) || end != data + len) { cJSON_Delete(r); return NULL; }
    for(cJSON *a=r->child;a;a=a->next){
        if(cJSON_IsArray(a)||cJSON_IsObject(a)){cJSON_Delete(r);return NULL;}
        for(cJSON *b=a->next;b;b=b->next)if(!strcmp(a->string,b->string)){cJSON_Delete(r);return NULL;}
    }
    return r;
}
static void delete_request(cJSON *request) {
    const char *keys[] = { "password", "device_token", "proof", "eap_username", "eap_identity", "eap_password" };
    for (unsigned i = 0; request && i < sizeof(keys)/sizeof(keys[0]); i++) { cJSON *v = cJSON_GetObjectItemCaseSensitive(request, keys[i]); if (cJSON_IsString(v)) wipe(v->valuestring, strlen(v->valuestring)); }
    cJSON_Delete(request);
}
static cJSON *reply(bool ok, const char *reason) { cJSON *r = cJSON_CreateObject(); if (!r) return NULL; cJSON_AddNumberToObject(r, "v", 1); cJSON_AddBoolToObject(r, "ok", ok); if (reason) cJSON_AddStringToObject(r, "reason", reason); return r; }
/* JSON is already decrypted by protocomm, or arrived over the strong WPA2 AP
 * after Host/Origin/content-type checks. Never return/log submitted secrets. */
static cJSON *handle(const cJSON *request, cp_provision_mode_t transport) {
    const cJSON *version=cJSON_GetObjectItemCaseSensitive(request,"v");
    if(!cJSON_IsNumber(version)||version->valuedouble!=1)return reply(false,"unsupported_version");
    const char *op=str(request,"op");if(!op)return reply(false,"invalid_operation");
    /* Physical USB status is intentionally available after radio handoff. */
    bool usb_status=transport==CP_PROVISION_USB&&!strcmp(op,"status");
    if(usb_status&&state.active)(void)session_allowed();
    if(!usb_status && (!state.active||state.mode!=transport))return reply(false,"setup_not_ready");
    if(!usb_status && !session_allowed())return reply(false,proof_failures>=MAX_FAILURES?"setup_locked":"setup_expired");
    if(transport==CP_PROVISION_SOFTAP && (!same(str(request,"nonce"),nonce)||!same(str(request,"proof"),state.proof))){authentication_failure();return reply(false,proof_failures>=MAX_FAILURES?"setup_locked":"invalid_setup_pin");}
    if(!strcmp(op,"info")||!strcmp(op,"status")) {
        cp_provision_snapshot_t snapshot;cp_network_diagnostic_t current;
        cp_network_attempt_t previous;bool have_previous;char boot[37],attempt[37];uint32_t reset;esp_err_t history;
        portENTER_CRITICAL(&lock);snapshot=state;current=diagnostic;previous=previous_attempt;have_previous=have_previous_attempt;
        memcpy(boot,diagnostic_boot_id,sizeof boot);memcpy(attempt,diagnostic_attempt_id,sizeof attempt);
        reset=diagnostic_reset_reason;history=diagnostic_history_error;portEXIT_CRITICAL(&lock);
        cJSON *r=reply(true,NULL);if(!r)return NULL;
        bool has_saved=saved_credential(snapshot.node_id,NULL,0,NULL);
        bool ok=cJSON_AddStringToObject(r,"node_id",snapshot.node_id)&&cJSON_AddStringToObject(r,"boot_id",boot)&&
            cJSON_AddStringToObject(r,"state",snapshot.state)&&cJSON_AddBoolToObject(r,"active",snapshot.active)&&
            cJSON_AddBoolToObject(r,"has_saved_credential",has_saved)&&
            cJSON_AddNumberToObject(r,"uptime_ms",(double)(esp_timer_get_time()/1000))&&cJSON_AddNumberToObject(r,"reset_reason",reset);
        if(!strcmp(op,"info")) {
            ok=ok&&cJSON_AddStringToObject(r,"board","FoloToy AI Passport / ESP32-C3")&&
                cJSON_AddStringToObject(r,"firmware_version",esp_app_get_description()->version)&&cJSON_AddNumberToObject(r,"wifi_modes",7)&&
                cJSON_AddStringToObject(r,"transport",transport==CP_PROVISION_USB?"usb":transport==CP_PROVISION_SOFTAP?"ap":"ble")&&
                cJSON_AddStringToObject(r,"security",transport==CP_PROVISION_USB?"physical-usb":transport==CP_PROVISION_SOFTAP?"wpa2-local":"security2");
            if(transport==CP_PROVISION_USB)ok=ok&&cJSON_AddStringToObject(r,"nonce",nonce);
            int64_t left=expires-esp_timer_get_time();ok=ok&&cJSON_AddNumberToObject(r,"session_expires_in_ms",left>0?left/1000:0);
        } else {
            ok=ok&&cJSON_AddStringToObject(r,"attempt_id",snapshot.attempt_id[0]?snapshot.attempt_id:attempt);
            if(current.stage==CP_DIAG_IDLE)ok=ok&&cJSON_AddStringToObject(r,"reason",snapshot.reason);
            cJSON *d=diagnostic_json(&current);
            if(!d||!cJSON_AddItemToObject(r,"diagnostic",d)){cJSON_Delete(d);ok=false;}
            /* Full previous-boot evidence is exposed on the 1024-byte physical
             * USB status channel; BLE has only 496 plaintext bytes per reply. */
            if(transport==CP_PROVISION_USB) {
                ok=ok&&cJSON_AddNumberToObject(r,"history_error",history);
                if(have_previous) {
                    cJSON *old=cJSON_CreateObject(),*detail=diagnostic_json(&previous.diagnostic);
                    bool old_ok=old&&detail&&cJSON_AddStringToObject(old,"attempt_id",previous.attempt_id)&&
                        cJSON_AddStringToObject(old,"boot_id",previous.boot_id)&&
                        cJSON_AddStringToObject(old,"state",previous.state==CP_ATTEMPT_SAVED?"saved":previous.state==CP_ATTEMPT_FAILED?"failed":"interrupted");
                    if(old_ok)old_ok=cJSON_AddItemToObject(old,"diagnostic",detail);
                    if(!old_ok){cJSON_Delete(detail);cJSON_Delete(old);ok=false;}
                    else if(!cJSON_AddItemToObject(r,"previous_attempt",old)){cJSON_Delete(old);ok=false;}
                }
            }
        }
        if(!ok){cJSON_Delete(r);return NULL;}return r;
    }
    if(transport==CP_PROVISION_USB&&!same(str(request,"nonce"),nonce))return reply(false,"invalid_session_nonce");
    if (strcmp(op, "configure")) return reply(false, "invalid_operation");
    const char *attempt = str(request, "attempt_id");
    if (!cp_provision_uuid_v4(attempt)) return reply(false, "invalid_attempt_id");
    const cJSON *reuse_field=cJSON_GetObjectItemCaseSensitive(request,"reuse_saved_credential");
    bool reuse=cJSON_IsTrue(reuse_field);
    if((reuse_field&&!reuse)||(reuse&&cJSON_GetObjectItemCaseSensitive(request,"device_token")))return reply(false,"invalid_credential_mode");
    for(const cJSON *field=request->child;field;field=field->next) {
        const char *allowed[]={"v","op","nonce","proof","node_id","attempt_id","ssid","password","device_token","reuse_saved_credential","wifi_security","eap_username","eap_identity","eap_password"};bool known=false;
        for(unsigned i=0;i<sizeof allowed/sizeof allowed[0];++i)if(!strcmp(field->string,allowed[i]))known=true;
        if(!known)return reply(false,"invalid_settings");
    }
    cp_settings_t candidate = { .version = CP_SETTINGS_VERSION };
    snprintf(candidate.node_id, sizeof(candidate.node_id), "%s", state.node_id);
    snprintf(candidate.api_origin, sizeof(candidate.api_origin), "%s", CP_API_ORIGIN);
    const char *security=str(request,"wifi_security");
    if(!security) {
        if(cJSON_GetObjectItemCaseSensitive(request,"wifi_security"))return reply(false,"invalid_wifi_security");
        security="wpa2";
    }
    if(!strcmp(security,"open"))candidate.wifi_security=CP_WIFI_OPEN;
    else if(!strcmp(security,"enterprise"))candidate.wifi_security=CP_WIFI_ENTERPRISE_PEAP;
    else if(strcmp(security,"wpa2"))return reply(false,"invalid_wifi_security");
    if(candidate.wifi_security==CP_WIFI_ENTERPRISE_PEAP) {
        if(!copy_field(candidate.eap_username,sizeof candidate.eap_username,request,"eap_username")||
           !copy_field(candidate.eap_password,sizeof candidate.eap_password,request,"eap_password")) {
            wipe(&candidate,sizeof candidate);return reply(false,"invalid_enterprise_settings");
        }
        if(cJSON_GetObjectItemCaseSensitive(request,"eap_identity")) {
            if(!copy_field(candidate.eap_identity,sizeof candidate.eap_identity,request,"eap_identity")){wipe(&candidate,sizeof candidate);return reply(false,"invalid_enterprise_settings");}
        } else memcpy(candidate.eap_identity,candidate.eap_username,sizeof candidate.eap_identity);
    } else if(cJSON_GetObjectItemCaseSensitive(request,"eap_username")||cJSON_GetObjectItemCaseSensitive(request,"eap_password")||cJSON_GetObjectItemCaseSensitive(request,"eap_identity"))return reply(false,"invalid_wifi_security");
    uint32_t saved_generation=0;
    bool credential_ok=reuse?saved_credential(state.node_id,candidate.device_token,sizeof candidate.device_token,&saved_generation):
        copy_field(candidate.device_token,sizeof candidate.device_token,request,"device_token");
    if(reuse&&!credential_ok){wipe(&candidate,sizeof candidate);return reply(false,"saved_credential_unavailable");}
    if (!copy_field(candidate.ssid, sizeof(candidate.ssid), request, "ssid") ||
        !copy_field(candidate.password, sizeof(candidate.password), request, "password") ||
        !credential_ok ||
        !same(str(request, "node_id"), state.node_id) || !cp_settings_validate(&candidate)) {
        wipe(&candidate, sizeof(candidate)); return reply(false, "invalid_settings");
    }
    uint8_t digest[32];
    if (!cp_provision_candidate_digest(&candidate,reuse,saved_generation,digest)) { wipe(&candidate, sizeof(candidate)); return reply(false, "settings_hash_failed"); }
    if (state.attempt_id[0]) {
        bool same_id = !strcmp(attempt, state.attempt_id);
        bool same_body = cp_provision_digest_equal(attempt_digest, digest);
        wipe(&candidate, sizeof(candidate)); wipe(digest, sizeof(digest));
        if (!same_id) return reply(false, "attempt_in_progress");
        if (!same_body) return reply(false, "attempt_payload_changed");
        cJSON *r = reply(true, NULL); if (!r) return NULL;
        char status[24];portENTER_CRITICAL(&lock);memcpy(status,state.state,sizeof status);portEXIT_CRITICAL(&lock);
        cJSON_AddStringToObject(r,"state",status);cJSON_AddStringToObject(r,"attempt_id",attempt);return r;
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
    cJSON *result;
    if(!request)result=reply(false,"invalid_json");
    else if(!take_session())result=reply(false,"session_busy");
    else {result=handle(request,CP_PROVISION_BLE);give_session();}
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
    return true;
}
static void headers(httpd_req_t *req) {
    httpd_resp_set_hdr(req, "Cache-Control", "no-store"); httpd_resp_set_hdr(req, "X-Content-Type-Options", "nosniff");
    httpd_resp_set_hdr(req, "Referrer-Policy", "no-referrer");
    httpd_resp_set_hdr(req, "Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
}
#include "setup_page.h"
static esp_err_t page_handler(httpd_req_t *req) {
    if (!local_request(req, false)) return httpd_resp_send_err(req, HTTPD_403_FORBIDDEN, "Local setup only");
    if(!take_session()){httpd_resp_set_status(req,"503 Service Unavailable");return httpd_resp_sendstr(req,"Setup busy");}
    if(state.mode!=CP_PROVISION_SOFTAP||!session_allowed()){give_session();return httpd_resp_send_err(req,HTTPD_403_FORBIDDEN,"Setup expired or locked");}
    char node[16],session_nonce[33];memcpy(node,state.node_id,sizeof node);memcpy(session_nonce,nonce,sizeof session_nonce);give_session();
    headers(req); httpd_resp_set_type(req, "text/html; charset=utf-8");
    httpd_resp_sendstr_chunk(req, CP_SETUP_HEAD); httpd_resp_sendstr_chunk(req, node);
    httpd_resp_sendstr_chunk(req, CP_SETUP_MID); httpd_resp_sendstr_chunk(req, session_nonce);
    httpd_resp_sendstr_chunk(req, CP_SETUP_END); return httpd_resp_send_chunk(req, NULL, 0);
}
static esp_err_t configure_handler(httpd_req_t *req) {
    if (!local_request(req, true)) return httpd_resp_send_err(req, HTTPD_403_FORBIDDEN, "Local setup only");
    if (req->content_len <= 0 || req->content_len > REQUEST_MAX) return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Invalid size");
    char *body = calloc(1, req->content_len + 1); if (!body) return ESP_ERR_NO_MEM;
    int pos = 0; while (pos < req->content_len) { int n = httpd_req_recv(req, body + pos, req->content_len - pos); if (n <= 0) { wipe(body, req->content_len + 1); free(body); return ESP_FAIL; } pos += n; }
    cJSON *request = parse_request(body, (size_t)pos); wipe(body, req->content_len + 1); free(body);
    cJSON *result;
    if(!request)result=reply(false,"invalid_json");
    else if(!take_session())result=reply(false,"session_busy");
    else {result=handle(request,CP_PROVISION_SOFTAP);give_session();}
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
static esp_err_t stop_locked(void);
esp_err_t cp_provision_usb_exchange(const uint8_t *request,size_t length,uint8_t **response,size_t *response_length) {
    if(!response||!response_length)return ESP_ERR_INVALID_ARG;
    *response=NULL;*response_length=0;
    if(!request||!length||length>REQUEST_MAX)return ESP_ERR_INVALID_SIZE;
    cJSON *object=parse_request((const char *)request,length),*result;
    if(!object)result=reply(false,"invalid_json");
    else if(!take_session())result=reply(false,"session_busy");
    else {result=handle(object,CP_PROVISION_USB);give_session();}
    delete_request(object);char *encoded=result?cJSON_PrintUnformatted(result):NULL;cJSON_Delete(result);
    if(!encoded)return ESP_ERR_NO_MEM;
    *response=(uint8_t *)encoded;*response_length=strlen(encoded);return ESP_OK;
}
esp_err_t cp_provision_start(cp_provision_mode_t mode,const char *node,const char *master,cp_provision_submit_fn submit,void *ctx) {
    if(!node||strlen(node)!=15||strncmp(node,"cp_",3)||!master||strlen(master)!=32||!submit||mode<CP_PROVISION_BLE||mode>CP_PROVISION_USB)return ESP_ERR_INVALID_ARG;
    for(unsigned i=3;i<15;i++)if(!((node[i]>='0'&&node[i]<='9')||(node[i]>='a'&&node[i]<='f')))return ESP_ERR_INVALID_ARG;
    if(!take_session())return ESP_ERR_INVALID_STATE;
    if(state.active||security_fatal||teardown_fault!=ESP_OK){give_session();return ESP_ERR_INVALID_STATE;}
    cp_provision_snapshot_t next={.active=true,.mode=mode};snprintf(next.node_id,sizeof next.node_id,"%s",node);snprintf(next.service_name,sizeof next.service_name,"CampusPulse-%s",node+9);
    uint8_t context[44],srp_salt[16];esp_fill_random(context,32);uint64_t now=(uint64_t)esp_timer_get_time();uint32_t seq=++session_sequence;
    for(unsigned i=0;i<8;i++)context[32+i]=(uint8_t)(now>>(56-8*i));
    for(unsigned i=0;i<4;i++)context[40+i]=(uint8_t)(seq>>(24-8*i));
    bool derived=cp_provision_session_secrets(master,context,sizeof context,next.proof,next.ap_password,nonce,srp_salt);wipe(context,sizeof context);wipe(attempt_digest,sizeof attempt_digest);
    if(!derived){give_session();return ESP_FAIL;}
    if(mode==CP_PROVISION_USB){wipe(next.proof,sizeof next.proof);wipe(next.ap_password,sizeof next.ap_password);}
    snprintf(next.state,sizeof next.state,"waiting");portENTER_CRITICAL(&lock);state=next;portEXIT_CRITICAL(&lock);wipe(&next,sizeof next);
    submit_fn=submit;submit_ctx=ctx;expires=esp_timer_get_time()+SESSION_US;proof_failures=0;
    if(mode==CP_PROVISION_USB){wipe(srp_salt,sizeof srp_salt);give_session();return ESP_OK;}
    esp_err_t err=esp_event_loop_create_default();if(err!=ESP_OK&&err!=ESP_ERR_INVALID_STATE)goto fail;
    if(mode==CP_PROVISION_SOFTAP){wipe(srp_salt,sizeof srp_salt);err=start_ap();if(err!=ESP_OK)goto fail;give_session();return ESP_OK;}
    uint8_t *salt=malloc(16),*verifier=malloc(384);
    if(!salt||!verifier){free(salt);free(verifier);err=ESP_ERR_NO_MEM;goto fail;}
    memcpy(salt,srp_salt,16);wipe(srp_salt,sizeof srp_salt);
    srp=(protocomm_security2_params_t){.salt=(const char *)salt,.salt_len=16,.verifier=(const char *)verifier,.verifier_len=384};
    if(!cp_provision_sec2_verifier(state.proof,salt,verifier)){err=ESP_FAIL;goto fail;}
    pc=protocomm_new();if(!pc){err=ESP_ERR_NO_MEM;goto fail;}
    /* Install security before advertising so GAP_CONNECT can never miss it. */
    const cp_provision_security_hooks_t hooks={security_enter,give_session,security_failure,security_broken};
    if((err=protocomm_set_security(pc,"prov-session",cp_provision_security2(&hooks),&srp))!=ESP_OK||(err=protocomm_add_endpoint(pc,"cp-setup",app_handler,NULL))!=ESP_OK)goto fail;
    static protocomm_ble_name_uuid_t lookup[]={{"prov-session",0xff51},{"cp-setup",0xff52}};
    protocomm_ble_config_t ble={.service_uuid={0x01,0x7a,0xc6,0x42,0xaf,0x8b,0x48,0xa8,0x1d,0x4f,0x3a,0x7b,0x00,0x00,0xc0,0xf0},.nu_lookup_count=2,.nu_lookup=lookup};
    snprintf(ble.device_name,sizeof ble.device_name,"%s",state.service_name);
    if((err=protocomm_ble_start(pc,&ble))!=ESP_OK){if(esp_bt_controller_get_status()!=ESP_BT_CONTROLLER_STATUS_IDLE){teardown_fault=err;cp_provision_set_status("stop_failed","Bluetooth start incomplete; restart required");give_session();return err;}goto fail;}
    ble_started=true;
    give_session();return ESP_OK;
fail:{wipe(srp_salt,sizeof srp_salt);esp_err_t stopped=stop_locked();give_session();return stopped==ESP_OK?err:stopped;}
}
static esp_err_t stop_locked(void) {
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
    wipe(nonce,sizeof nonce);
    if(srp.salt){wipe((void *)srp.salt,srp.salt_len);free((void *)srp.salt);}
    if(srp.verifier){wipe((void *)srp.verifier,srp.verifier_len);free((void *)srp.verifier);}
    memset(&srp,0,sizeof srp);return ESP_OK;
failed:
    /* Preserve our handles and active ownership. Upstream BLE failure is
     * irrecoverable in this boot; AP shutdown may be retried by the supervisor. */
    cp_provision_set_status("stop_failed", "Transport shutdown failed; restart required");
    return err;
}

esp_err_t cp_provision_stop(void){if(!take_session())return ESP_ERR_INVALID_STATE;esp_err_t err=stop_locked();give_session();return err;}
