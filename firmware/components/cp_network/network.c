#include "cp_network.h"
#include "protocol_internal.h"
#include "control_json.h"
#include "http_response.h"
#include "cJSON.h"
#include "esp_crt_bundle.h"
#include "esp_event.h"
#include "esp_http_client.h"
#include "esp_netif.h"
#include "esp_netif_sntp.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/time.h>
#include "sdkconfig.h"
#if !CONFIG_MBEDTLS_HAVE_TIME_DATE
#error "CampusPulse requires MBEDTLS_HAVE_TIME_DATE certificate expiry checks"
#endif
#if !CONFIG_MBEDTLS_CERTIFICATE_BUNDLE
#error "CampusPulse requires the ESP certificate bundle"
#endif
#if CONFIG_ESP_TLS_SKIP_SERVER_CERT_VERIFY
#error "CampusPulse requires TLS certificate verification"
#endif

/* One lifecycle owner; event callbacks only update bounded state. Slow IO is
 * confined to the control task and the serialized caller-owned upload worker. */
static SemaphoreHandle_t s_lock, s_http, s_stopped;
static TaskHandle_t s_task;
static esp_netif_t *s_sta;
static esp_event_handler_instance_t s_wifi_handler, s_ip_handler;
static bool s_wifi_initialized, s_sntp_started;
static bool s_running, s_synced, s_link, s_attempting, s_config_verified;
static char s_node[16], s_boot[37], s_capture[16]="unassigned";
static cp_settings_t s_settings;
static cp_network_snapshot_t s_snapshot;
static uint64_t s_request_seq, s_contact_seq, s_apply_seq;
static char *s_pending_contact;
static char *s_pending_activation;
static uint64_t s_pending_apply_seq;
static cp_control_activation_intent_t s_activation_intent;
static uint64_t now_ms(void) { return (uint64_t)esp_timer_get_time()/1000; }
static void lock(void) { xSemaphoreTake(s_lock,portMAX_DELAY); }
static void unlock(void) { xSemaphoreGive(s_lock); }
static bool running(void) { return __atomic_load_n(&s_running,__ATOMIC_ACQUIRE); }
static void wifi_event(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    (void)arg; (void)data;
    lock();
    if (base==IP_EVENT && id==IP_EVENT_STA_GOT_IP) {
        s_link=true; s_attempting=false; s_snapshot.network=CP_NETWORK_READY;
    } else if (base==WIFI_EVENT && id==WIFI_EVENT_STA_DISCONNECTED) {
        s_link=false; s_attempting=false; s_snapshot.network=CP_NETWORK_CONNECTING;
        ++s_snapshot.connection_failures;
    }
    unlock();
}
static void time_synced(struct timeval *tv)
{
    if (!tv || tv->tv_sec<1704067200LL || tv->tv_sec>7258118400LL) return;
    lock();
    s_synced=true;
    s_snapshot.clock_trusted=false; /* verified HTTPS must validate this epoch */
    s_snapshot.clock_mono_ms=now_ms();
    s_snapshot.clock_utc_ms=(uint64_t)tv->tv_sec*1000+(uint64_t)tv->tv_usec/1000;
    ++s_snapshot.clock_epoch;
    /* SNTP provides no measured error bound here. Unknown is explicit, and may
     * not be used as a small uncertainty to qualify public projections. */
    s_snapshot.clock_uncertainty_ms=UINT32_MAX;
    s_snapshot.clock_estimated=false;
    unlock();
}
typedef cp_http_response_t response_t;
static esp_err_t http_event(esp_http_client_event_t *event)
{
    return cp_http_response_event(event,now_ms(),running());
}
/* s_http serializes credentials, HTTP, activation and configuration. */
static esp_err_t request_locked(const char *path, const char *body, size_t length,
    const char *hash, response_t *response, int *status)
{
    *status=0;
    lock(); bool eligible=s_link && s_synced; unlock();
    if (!running() || !eligible) return ESP_ERR_INVALID_STATE;
    response->deadline_ms=now_ms()+12000;
    char url[128], auth[CP_SETTINGS_TOKEN_SIZE+8];
    if (snprintf(url,sizeof(url),"%s%s",s_settings.api_origin,path)>=(int)sizeof(url)) return ESP_ERR_INVALID_SIZE;
    snprintf(auth,sizeof(auth),"Bearer %s",s_settings.device_token);
    esp_http_client_config_t config={
        .url=url, .timeout_ms=12000, .disable_auto_redirect=true, .is_async=true,
        .crt_bundle_attach=esp_crt_bundle_attach,
        .event_handler=http_event, .user_data=response,
        .buffer_size=1024, .buffer_size_tx=1024,
    };
    esp_http_client_handle_t client=esp_http_client_init(&config);
    if (!client) { memset(auth,0,sizeof(auth)); return ESP_ERR_NO_MEM; }
    esp_err_t e=esp_http_client_set_header(client,"Authorization",auth);
    memset(auth,0,sizeof(auth));
    if (e==ESP_OK) e=esp_http_client_set_header(client,"Accept","application/json");
    if (e==ESP_OK && body) e=esp_http_client_set_method(client,HTTP_METHOD_POST);
    if (e==ESP_OK && body) e=esp_http_client_set_header(client,"Content-Type","application/json");
    if (e==ESP_OK && hash) e=esp_http_client_set_header(client,"X-Body-SHA256",hash);
    if (e==ESP_OK && body) e=esp_http_client_set_post_field(client,body,(int)length);
    if (e==ESP_OK) {
        const uint64_t deadline=response->deadline_ms;
        do {
            e=esp_http_client_perform(client);
            if (response->abort_reason!=ESP_OK) { e=response->abort_reason; break; }
            if (e!=ESP_ERR_HTTP_EAGAIN) break;
            if (!running()) { e=ESP_ERR_INVALID_STATE; break; }
            if (now_ms()>=deadline) { e=ESP_ERR_TIMEOUT; break; }
            vTaskDelay(pdMS_TO_TICKS(20));
        } while (true);
    }
    *status=esp_http_client_get_status_code(client);
    cp_http_response_check(response,now_ms(),running());
    esp_http_client_cleanup(client);
    if (response->abort_reason!=ESP_OK) e=response->abort_reason;
    lock();
    s_snapshot.last_http_status=*status; s_snapshot.last_error=e;
    if (e==ESP_OK && *status>=200 && *status<300) {
        s_snapshot.clock_trusted=true;
    } else if (*status==401 || *status==403) {
        s_snapshot.auth=CP_AUTH_REJECTED; s_snapshot.policy_valid=false;
    }
    unlock();
    return e;
}
static char *contact_body(uint64_t seq)
{
    char capture[sizeof(s_capture)], applied[65];
    lock(); strcpy(capture,s_capture); strcpy(applied,s_snapshot.applied_config_id); unlock();
    return cp_control_contact_json(s_boot,seq,now_ms(),capture,applied);
}
static bool contact(void)
{
    if (!s_pending_contact) {
        if (s_contact_seq==UINT32_MAX) return false;
        char *candidate=contact_body(s_contact_seq+1);
        if (!candidate) return false;
        s_pending_contact=candidate; ++s_contact_seq;
    }
    if (!s_pending_contact) return false;
    response_t r={.body=calloc(1,CP_NETWORK_BODY_MAX+1)};
    if (!r.body) return false;
    int status=0;
    esp_err_t e=request_locked("/api/v2/device/contact",s_pending_contact,strlen(s_pending_contact),NULL,&r,&status);
    bool ok=e==ESP_OK && status==200 && cp_network_control_ack_matches(r.body,r.used,s_node,s_boot,s_contact_seq,NULL,NULL,NULL);
    free(r.body);
    if (ok) {
        lock(); s_snapshot.auth=CP_AUTH_VALID; unlock();
        free(s_pending_contact); s_pending_contact=NULL;
    }
    return ok;
}
static void fetch_policy(void)
{
    response_t r={.body=calloc(1,CP_NETWORK_BODY_MAX+1)};
    if (!r.body) return;
    const uint64_t sequence=++s_request_seq;
    int status=0;
    uint64_t started=now_ms();
    esp_err_t e=request_locked("/api/v2/device/config",NULL,0,NULL,&r,&status);
    uint64_t ended=now_ms();
    if (e==ESP_OK && status==200) {
        cp_network_policy_t policy; bool present=false, expired=false;
        uint64_t server_utc=0;
        bool valid=cp_network_parse_policy(r.body,r.used,s_node,&policy,&present,&expired) &&
            cp_network_parse_server_time(r.body,r.used,&server_utc);
        policy.request_sequence=sequence; policy.fetched_mono_ms=now_ms();
        char desired_id[65];
        cp_network_candidate_id(r.body,r.used,s_node,desired_id);
        lock();
        s_config_verified=valid;
        s_snapshot.policy_response_sequence=sequence;
        s_snapshot.policy_rejected=!valid;
        s_snapshot.policy_expired=expired;
        strcpy(s_snapshot.desired_config_id,desired_id);
        if (valid) {
            s_snapshot.auth=CP_AUTH_VALID;
            s_snapshot.clock_mono_ms=started+(ended-started)/2;
            s_snapshot.clock_utc_ms=server_utc;
            ++s_snapshot.clock_epoch;
            s_snapshot.clock_uncertainty_ms=(uint32_t)((ended-started+1)/2+1);
            s_snapshot.clock_estimated=true;
        }
        s_snapshot.policy_present=present;
        s_snapshot.policy_valid=valid && present && !expired;
        if (s_snapshot.policy_valid) s_snapshot.policy=policy;
        else if (!valid) s_snapshot.last_error=ESP_ERR_INVALID_RESPONSE;
        unlock();
    }
    free(r.body);
}
static void send_activation(void)
{
    /* report_activation also holds s_http, so the exact pending attempt remains
     * stable across a request/retry and cannot overtake a newer local outcome. */
    if (!cp_control_prepare_activation(&s_activation_intent,s_boot,&s_apply_seq,
                                       &s_pending_activation,&s_pending_apply_seq)) return;
    if (!s_pending_activation) return;
    response_t r={.body=calloc(1,CP_NETWORK_BODY_MAX+1)};
    if (!r.body) return;
    int status=0;
    esp_err_t e=request_locked("/api/v2/device/config/ack",s_pending_activation,strlen(s_pending_activation),NULL,&r,&status);
    cJSON *sent=cJSON_Parse(s_pending_activation);
    const cJSON *config=cJSON_GetObjectItemCaseSensitive(sent,"capture_config_id"), *state=cJSON_GetObjectItemCaseSensitive(sent,"state"), *message=cJSON_GetObjectItemCaseSensitive(sent,"message");
    bool ok=e==ESP_OK && status==200 && cJSON_IsString(config) && cJSON_IsString(state) &&
        cp_network_control_ack_matches(r.body,r.used,s_node,s_boot,s_pending_apply_seq,config->valuestring,state->valuestring,cJSON_IsString(message)?message->valuestring:NULL);
    if (ok) {
        lock(); s_snapshot.activation_confirmed=true; unlock();
        free(s_pending_activation); s_pending_activation=NULL;
    }
    cJSON_Delete(sent); free(r.body);
}
static void service(void *unused)
{
    (void)unused;
    uint64_t reconnect_at=0, connect_started=0, control_at=0, contact_at=0, activation_at=0;
    uint32_t retry_ms=1000;
    bool registered=false;
    while (running()) {
        uint64_t now=now_ms();
        lock(); bool link=s_link, attempting=s_attempting, synced=s_synced; unlock();
        if (!link) {
            if (attempting && now-connect_started>30000) esp_wifi_disconnect();
            if (!attempting && now>=reconnect_at) {
                lock(); s_attempting=true; unlock(); connect_started=now;
                esp_err_t e=esp_wifi_connect();
                if (e!=ESP_OK) { lock(); s_attempting=false; s_snapshot.last_error=e; ++s_snapshot.connection_failures; unlock(); }
                reconnect_at=now+retry_ms;
                retry_ms=retry_ms<16000?retry_ms*2:30000;
            }
        } else {
            retry_ms=1000;
            if (!s_sntp_started) {
                esp_sntp_config_t config=ESP_NETIF_SNTP_DEFAULT_CONFIG("time.cloudflare.com");
                config.sync_cb=time_synced;
                esp_err_t e=esp_netif_sntp_init(&config);
                if (e==ESP_OK) s_sntp_started=true;
                else { lock(); s_snapshot.last_error=e; unlock(); }
            }
            if (synced) {
                xSemaphoreTake(s_http,portMAX_DELAY);
                if (now>=contact_at && running()) {
                    registered=contact(); contact_at=now_ms()+30000;
                }
                if (registered && now>=control_at && running()) { fetch_policy(); control_at=now_ms()+30000; }
                if (registered && now>=activation_at && running()) { send_activation(); activation_at=now_ms()+10000; }
                xSemaphoreGive(s_http);
            }
        }
        vTaskDelay(pdMS_TO_TICKS(250));
    }
    xSemaphoreGive(s_stopped);
    vTaskDelete(NULL);
}
esp_err_t cp_network_init(const char *node, const char *boot)
{
    if (!cp_network_identity_valid(node,boot)) return ESP_ERR_INVALID_ARG;
    if (s_lock) return !strcmp(node,s_node)&&!strcmp(boot,s_boot)?ESP_OK:ESP_ERR_INVALID_STATE;
    s_lock=xSemaphoreCreateMutex(); s_http=xSemaphoreCreateMutex(); s_stopped=xSemaphoreCreateBinary();
    if (!s_lock||!s_http||!s_stopped) {
        if (s_lock) vSemaphoreDelete(s_lock);
        if (s_http) vSemaphoreDelete(s_http);
        if (s_stopped) vSemaphoreDelete(s_stopped);
        s_lock=NULL; s_http=NULL; s_stopped=NULL;
        return ESP_ERR_NO_MEM;
    }
    strcpy(s_node,node); strcpy(s_boot,boot);
    s_snapshot.network=CP_NETWORK_OFFLINE; s_snapshot.clock_uncertainty_ms=UINT32_MAX;
    return ESP_OK;
}
esp_err_t cp_network_start(const cp_settings_t *settings)
{
    if (!s_lock || !cp_settings_validate(settings) || strcmp(settings->node_id,s_node)) return ESP_ERR_INVALID_ARG;
    if (s_task || s_wifi_initialized) return ESP_ERR_INVALID_STATE;
    s_settings=*settings;
    esp_err_t e=esp_netif_init();
    if (e!=ESP_OK) goto failed;
    e=esp_event_loop_create_default();
    if (e!=ESP_OK && e!=ESP_ERR_INVALID_STATE) goto failed;
    s_sta=esp_netif_create_default_wifi_sta();
    if (!s_sta) { e=ESP_ERR_NO_MEM; goto failed; }
    wifi_init_config_t init=WIFI_INIT_CONFIG_DEFAULT();
    e=esp_wifi_init(&init); if (e!=ESP_OK) goto failed;
    s_wifi_initialized=true;
    e=esp_wifi_set_storage(WIFI_STORAGE_RAM); if (e!=ESP_OK) goto failed;
    e=esp_event_handler_instance_register(WIFI_EVENT,WIFI_EVENT_STA_DISCONNECTED,wifi_event,NULL,&s_wifi_handler); if (e!=ESP_OK) goto failed;
    e=esp_event_handler_instance_register(IP_EVENT,IP_EVENT_STA_GOT_IP,wifi_event,NULL,&s_ip_handler); if (e!=ESP_OK) goto failed;
    wifi_config_t wifi={0};
    memcpy(wifi.sta.ssid,settings->ssid,strlen(settings->ssid));
    memcpy(wifi.sta.password,settings->password,strlen(settings->password));
    wifi.sta.threshold.authmode=WIFI_AUTH_WPA2_PSK;
    wifi.sta.pmf_cfg.capable=true;
    e=esp_wifi_set_mode(WIFI_MODE_STA);
    if (e==ESP_OK) e=esp_wifi_set_config(WIFI_IF_STA,&wifi);
    memset(&wifi,0,sizeof(wifi));
    if (e!=ESP_OK) goto failed;
    e=esp_wifi_start(); if (e!=ESP_OK) goto failed;
    lock(); s_link=false; s_attempting=false; s_synced=false; s_config_verified=false;
    s_snapshot.network=CP_NETWORK_CONNECTING; s_snapshot.auth=CP_AUTH_UNKNOWN;
    s_snapshot.clock_trusted=false; s_snapshot.policy_valid=false; s_snapshot.policy_present=false; s_snapshot.policy_rejected=false; s_snapshot.policy_expired=false; s_snapshot.policy_response_sequence=0; s_snapshot.desired_config_id[0]=0;
    unlock();
    __atomic_store_n(&s_running,true,__ATOMIC_RELEASE);
    if (xTaskCreate(service,"cp_network",8192,NULL,4,&s_task)!=pdPASS) { s_task=NULL; e=ESP_ERR_NO_MEM; goto failed; }
    return ESP_OK;
failed:
    cp_network_stop(); return e;
}
esp_err_t cp_network_stop(void)
{
    if (!s_lock) return ESP_OK;
    __atomic_store_n(&s_running,false,__ATOMIC_RELEASE);
    if (s_task) {
        if (xSemaphoreTake(s_stopped,pdMS_TO_TICKS(20000))!=pdTRUE) return ESP_ERR_TIMEOUT;
        s_task=NULL;
    }
    xSemaphoreTake(s_http,portMAX_DELAY);
    if (s_sntp_started) { esp_netif_sntp_deinit(); s_sntp_started=false; }
    if (s_wifi_handler) { esp_event_handler_instance_unregister(WIFI_EVENT,WIFI_EVENT_STA_DISCONNECTED,s_wifi_handler); s_wifi_handler=NULL; }
    if (s_ip_handler) { esp_event_handler_instance_unregister(IP_EVENT,IP_EVENT_STA_GOT_IP,s_ip_handler); s_ip_handler=NULL; }
    if (s_wifi_initialized) {
        esp_err_t stopped=esp_wifi_stop();
        if (stopped!=ESP_OK && stopped!=ESP_ERR_WIFI_NOT_STARTED) {
            xSemaphoreGive(s_http); return stopped;
        }
        esp_err_t deinitialized=esp_wifi_deinit();
        if (deinitialized!=ESP_OK) { xSemaphoreGive(s_http); return deinitialized; }
        s_wifi_initialized=false;
    }
    if (s_sta) { esp_netif_destroy_default_wifi(s_sta); s_sta=NULL; }
    cp_settings_clear_sensitive(&s_settings);
    /* Same-boot setup/resume must retain uncertain frozen control attempts.
     * They carry no Wi-Fi/bearer secret and remain bound to s_node/s_boot.
     * Fresh reports replace activation only after complete construction. */
    lock(); s_link=false; s_synced=false; s_attempting=false;
    s_snapshot.network=CP_NETWORK_OFFLINE; s_snapshot.auth=CP_AUTH_UNKNOWN;
    s_snapshot.clock_trusted=false; s_snapshot.policy_valid=false;
    unlock();
    xSemaphoreGive(s_http);
    return ESP_OK;
}
void cp_network_snapshot(cp_network_snapshot_t *out)
{
    if (!out) return;
    if (!s_lock) { memset(out,0,sizeof(*out)); return; }
    lock(); *out=s_snapshot; unlock();
}
bool cp_network_get_policy(cp_network_policy_t *out)
{
    if (!out || !s_lock) return false;
    lock(); bool valid=s_snapshot.policy_valid; if (valid) *out=s_snapshot.policy; unlock(); return valid;
}
void cp_network_set_capture_state(const char *state)
{
    if (!s_lock || !state) return;
    const char *states[]={"unassigned","running","paused","expired","failed"};
    bool valid=false;
    for (unsigned i=0;i<sizeof(states)/sizeof(states[0]);++i) if (!strcmp(state,states[i])) valid=true;
    if (valid) { lock(); strcpy(s_capture,state); unlock(); }
}
esp_err_t cp_network_report_activation(const char *config_id, bool applied, const char *reason)
{
    if (!s_lock || !config_id || !config_id[0] || strlen(config_id)>64 || (reason && strlen(reason)>64)) return ESP_ERR_INVALID_ARG;
    for (const char *p=config_id;*p;++p)
        if (!((*p>='a'&&*p<='z')||(*p>='0'&&*p<='9')||*p=='_'||*p=='-')) return ESP_ERR_INVALID_ARG;
    if (reason && reason[0]) {
        if (!((reason[0]>='a'&&reason[0]<='z')||(reason[0]>='0'&&reason[0]<='9'))) return ESP_ERR_INVALID_ARG;
        for (const char *p=reason;*p;++p)
            if (!((*p>='a'&&*p<='z')||(*p>='0'&&*p<='9')||*p=='_'||*p=='-'||*p=='.'||*p==':')) return ESP_ERR_INVALID_ARG;
    }
    xSemaphoreTake(s_http,portMAX_DELAY);
    if (s_apply_seq==UINT32_MAX) { xSemaphoreGive(s_http); return ESP_ERR_INVALID_STATE; }
    /* Fixed intent staging cannot fail from heap exhaustion. Worker lazily builds
     * and retries the complete JSON without losing a previous frozen attempt. */
    if (!cp_control_stage_activation(&s_activation_intent,config_id,applied,reason)) {
        xSemaphoreGive(s_http); return ESP_ERR_INVALID_ARG;
    }
    lock();
    if (applied) strcpy(s_snapshot.applied_config_id,config_id);
    s_snapshot.activation_confirmed=false;
    unlock();
    xSemaphoreGive(s_http); return ESP_OK;
}
esp_err_t cp_network_validate_candidate(const cp_settings_t *settings, uint32_t timeout_ms)
{
    if (timeout_ms<1000 || timeout_ms>120000) return ESP_ERR_INVALID_ARG;
    esp_err_t e=cp_network_start(settings);
    if (e!=ESP_OK) return e;
    uint64_t end=now_ms()+timeout_ms;
    e=ESP_ERR_TIMEOUT;
    while (now_ms()<end) {
        cp_network_snapshot_t s; cp_network_snapshot(&s);
        if (s.auth==CP_AUTH_REJECTED) { e=ESP_ERR_NOT_ALLOWED; break; }
        lock(); bool verified=s_config_verified; unlock();
        if (verified && s.auth==CP_AUTH_VALID && s.clock_trusted) { e=ESP_OK; break; }
        vTaskDelay(pdMS_TO_TICKS(250));
    }
    esp_err_t stop=cp_network_stop();
    return stop==ESP_OK?e:stop;
}
cp_net_upload_result_t cp_network_upload_frozen(const void *body, size_t length,
    const cp_network_batch_t *expected, cp_network_ack_t *ack)
{
    if (ack) memset(ack,0,sizeof(*ack));
    if (!s_lock || !body || !length || length>CP_NETWORK_BODY_MAX || !cp_network_batch_valid(expected) || !ack ||
        strcmp(expected->node_id,s_node)) return CP_NET_UPLOAD_REJECTED;
    char hash[65];
    if (!cp_network_sha256(body,length,hash) || strcmp(hash,expected->body_sha256)) return CP_NET_UPLOAD_REJECTED;
    response_t r={.body=calloc(1,CP_NETWORK_BODY_MAX+1)};
    if (!r.body) return CP_NET_UPLOAD_RETRY;
    xSemaphoreTake(s_http,portMAX_DELAY);
    esp_err_t e=request_locked("/api/v2/ingest",body,length,hash,&r,&ack->http_status);
    cp_net_upload_result_t result=CP_NET_UPLOAD_RETRY;
    if (e==ESP_OK && ack->http_status==200) {
        result=cp_network_parse_ack(r.body,r.used,expected,ack)?CP_NET_UPLOAD_ACKED:CP_NET_UPLOAD_BAD_ACK;
    } else if (ack->http_status==401 || ack->http_status==403) result=CP_NET_UPLOAD_AUTH;
    else if (ack->http_status==410) result=CP_NET_UPLOAD_POLICY;
    else if (ack->http_status>=400 && ack->http_status<500 && ack->http_status!=408 && ack->http_status!=429) result=CP_NET_UPLOAD_REJECTED;
    lock();
    if (result!=CP_NET_UPLOAD_ACKED) ++s_snapshot.upload_failures;
    if (result==CP_NET_UPLOAD_BAD_ACK) ++s_snapshot.ack_failures;
    unlock();
    xSemaphoreGive(s_http); free(r.body); return result;
}
