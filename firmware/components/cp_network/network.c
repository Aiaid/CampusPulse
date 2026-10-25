#include "cp_network.h"
#include "protocol_internal.h"
#include "control_json.h"
#include "http_response.h"
#include "cJSON.h"
#include "esp_crt_bundle.h"
#include "esp_event.h"
#include "esp_http_client.h"
#include "esp_heap_caps.h"
#include "esp_netif.h"
#include "esp_netif_sntp.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "esp_eap_client.h"
#include "esp_tls_errors.h"
#include "freertos/queue.h"
#include "lwip/dns.h"
#include "esp_log.h"
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
static bool s_wifi_initialized, s_sntp_started, s_enterprise_enabled;
static bool s_running, s_synced, s_link, s_attempting, s_associated, s_config_verified;
static bool s_bootstrap_clock, s_candidate_mode, s_candidate_authenticated;
static uint64_t s_diag_started, s_stage_started;
static QueueHandle_t s_events;
static uint32_t s_event_drops;
typedef enum { NET_ASSOCIATED,NET_GOT_IP,NET_LOST_IP,NET_DISCONNECTED,NET_TIME_SYNC } net_event_kind_t;
typedef struct { net_event_kind_t kind; uint16_t reason; uint64_t mono_ms,utc_ms; } net_event_t;
static portMUX_TYPE s_dns_lock=portMUX_INITIALIZER_UNLOCKED;
static uint32_t s_dns_generation;
static int s_dns_result;
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
static uint32_t elapsed_ms(void) {
    uint64_t now=now_ms(),elapsed=now>=s_diag_started?now-s_diag_started:0;
    return elapsed>UINT32_MAX?UINT32_MAX:(uint32_t)elapsed;
}
static void diagnostic_locked(cp_diag_stage_t stage,cp_diag_code_t code,esp_err_t error,bool retryable,bool terminal) {
    if(s_snapshot.diagnostic.terminal)return;
    if(s_snapshot.diagnostic.stage!=stage)s_stage_started=now_ms();
    cp_network_diag_update(&s_snapshot.diagnostic,stage,code,error,elapsed_ms(),retryable,terminal);
}
static void diagnostic(cp_diag_stage_t stage,cp_diag_code_t code,esp_err_t error,bool retryable,bool terminal) {
    lock();diagnostic_locked(stage,code,error,retryable,terminal);unlock();
}
/* Private numeric phases: no URL, credentials, network or device identifiers. */
typedef enum {
    NET_PHASE_DNS=1,NET_PHASE_CLIENT_INIT,NET_PHASE_HTTP_END,
    NET_PHASE_CONTACT_JSON,NET_PHASE_CONTACT_RESPONSE,NET_PHASE_POLICY_RESPONSE,
    NET_PHASE_ACTIVATION_JSON,NET_PHASE_ACTIVATION_RESPONSE,NET_PHASE_ACTIVATION_PARSE,
    NET_PHASE_UPLOAD_RESPONSE,NET_PHASE_START,
} net_phase_t;
static void log_evidence(net_phase_t phase,esp_err_t error,int socket_errno,
    esp_err_t tls_error,int tls_code,int tls_flags,int status,uint64_t started)
{
    lock();cp_diag_stage_t stage=s_snapshot.diagnostic.stage;unlock();
    uint64_t now=now_ms(),elapsed=now>=started?now-started:0;
    ESP_LOG_LEVEL_LOCAL(error==ESP_OK?ESP_LOG_INFO:ESP_LOG_WARN,"cp_network",
        "phase=%u stage=%u free=%u internal_free=%u internal_largest=%u min_heap=%u err=%d errno=%d tls_err=%d tls_code=%d tls_flags=%u http=%d elapsed_ms=%llu",
        (unsigned)phase,(unsigned)stage,
        (unsigned)heap_caps_get_free_size(MALLOC_CAP_8BIT),
        (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL|MALLOC_CAP_8BIT),
        (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL|MALLOC_CAP_8BIT),
        (unsigned)heap_caps_get_minimum_free_size(MALLOC_CAP_8BIT),
        (int)error,socket_errno,(int)tls_error,tls_code,(unsigned)tls_flags,status,
        (unsigned long long)elapsed);
}
static void allocation_failed(net_phase_t phase)
{
    lock();s_snapshot.last_error=ESP_ERR_NO_MEM;
    /* Local allocation failed before a trustworthy cloud result exists. End a
     * candidate immediately so its caller cannot replace this with TLS timeout. */
    diagnostic_locked(CP_DIAG_CLOUD_AUTH,CP_DIAG_RESOURCE_EXHAUSTED,ESP_ERR_NO_MEM,true,s_candidate_mode);
    unlock();
    log_evidence(phase,ESP_ERR_NO_MEM,0,ESP_OK,0,0,0,now_ms());
}
/* Driver/TCPIP callbacks enqueue numeric evidence and return immediately. */
static void wifi_event(void *arg,esp_event_base_t base,int32_t id,void *data) {
    (void)arg;net_event_t event={.mono_ms=now_ms()};
    if(base==IP_EVENT && id==IP_EVENT_STA_GOT_IP)event.kind=NET_GOT_IP;
    else if(base==IP_EVENT && id==IP_EVENT_STA_LOST_IP)event.kind=NET_LOST_IP;
    else if(base==WIFI_EVENT && id==WIFI_EVENT_STA_CONNECTED)event.kind=NET_ASSOCIATED;
    else if(base==WIFI_EVENT && id==WIFI_EVENT_STA_DISCONNECTED) {
        event.kind=NET_DISCONNECTED;
        if(data)event.reason=((wifi_event_sta_disconnected_t *)data)->reason;
    } else return;
    if(xQueueSend(s_events,&event,0)!=pdTRUE)__atomic_add_fetch(&s_event_drops,1u,__ATOMIC_RELAXED);
}
static void time_synced(struct timeval *tv) {
    if(!tv || tv->tv_sec<1704067200LL || tv->tv_sec>7258118400LL)return;
    net_event_t event={.kind=NET_TIME_SYNC,.mono_ms=now_ms(),
        .utc_ms=(uint64_t)tv->tv_sec*1000+(uint64_t)tv->tv_usec/1000};
    if(xQueueSend(s_events,&event,0)!=pdTRUE)__atomic_add_fetch(&s_event_drops,1u,__ATOMIC_RELAXED);
}
static void drain_events(void) {
    net_event_t event;
    while(xQueueReceive(s_events,&event,0)==pdTRUE) {
        lock();
        switch(event.kind) {
        case NET_ASSOCIATED:
            s_associated=true;s_attempting=false;
            diagnostic_locked(CP_DIAG_DHCP,CP_DIAG_DHCP_WAIT,ESP_OK,true,false);break;
        case NET_GOT_IP:
            s_link=true;s_associated=true;s_attempting=false;s_snapshot.network=CP_NETWORK_READY;
            diagnostic_locked(s_synced?CP_DIAG_DNS:CP_DIAG_CLOCK,s_synced?CP_DIAG_DNS_RESOLVING:CP_DIAG_CLOCK_SYNC,ESP_OK,true,false);break;
        case NET_LOST_IP:
            s_link=false;s_snapshot.network=CP_NETWORK_CONNECTING;
            diagnostic_locked(CP_DIAG_DHCP,CP_DIAG_DHCP_WAIT,ESP_OK,true,false);break;
        case NET_DISCONNECTED:
            s_link=false;s_associated=false;s_attempting=false;s_snapshot.network=CP_NETWORK_CONNECTING;
            ++s_snapshot.connection_failures;s_snapshot.diagnostic.wifi_reason=event.reason;
            diagnostic_locked(CP_DIAG_WIFI_CONNECT,cp_network_diag_wifi_reason(event.reason),ESP_FAIL,true,false);break;
        case NET_TIME_SYNC:
            s_synced=true;s_bootstrap_clock=true;s_snapshot.clock_trusted=false;
            s_snapshot.clock_mono_ms=event.mono_ms;s_snapshot.clock_utc_ms=event.utc_ms;
            ++s_snapshot.clock_epoch;s_snapshot.clock_uncertainty_ms=UINT32_MAX;s_snapshot.clock_estimated=false;
            diagnostic_locked(CP_DIAG_DNS,CP_DIAG_DNS_RESOLVING,ESP_OK,true,false);break;
        }
        unlock();
    }
}
static void dns_complete(const char *name,const ip_addr_t *address,void *argument) {
    (void)name;uint32_t generation=(uint32_t)(uintptr_t)argument;
    portENTER_CRITICAL(&s_dns_lock);
    if(generation==s_dns_generation)s_dns_result=address?1:-1;
    portEXIT_CRITICAL(&s_dns_lock);
}
static esp_err_t dns_start(void *argument) {
    ip_addr_t address;
    err_t result=dns_gethostbyname_addrtype("pulse.anend.net",&address,dns_complete,argument,LWIP_DNS_ADDRTYPE_IPV4);
    if(result==ERR_OK)dns_complete(NULL,&address,argument);
    else if(result!=ERR_INPROGRESS)dns_complete(NULL,NULL,argument);
    return ESP_OK;
}
static esp_err_t resolve_api(void) {
    diagnostic(CP_DIAG_DNS,CP_DIAG_DNS_RESOLVING,ESP_OK,true,false);
    portENTER_CRITICAL(&s_dns_lock);
    uint32_t generation=++s_dns_generation;if(!generation)generation=++s_dns_generation;
    s_dns_result=0;portEXIT_CRITICAL(&s_dns_lock);
    esp_err_t result=esp_netif_tcpip_exec(dns_start,(void *)(uintptr_t)generation);
    uint64_t deadline=now_ms()+6000;
    while(result==ESP_OK && running()) {
        portENTER_CRITICAL(&s_dns_lock);int ready=s_dns_result;portEXIT_CRITICAL(&s_dns_lock);
        if(ready){result=ready>0?ESP_OK:ESP_ERR_NOT_FOUND;break;}
        if(now_ms()>=deadline){result=ESP_ERR_TIMEOUT;break;}
        vTaskDelay(pdMS_TO_TICKS(20));
    }
    if(!running())result=ESP_ERR_INVALID_STATE;
    portENTER_CRITICAL(&s_dns_lock);++s_dns_generation;portEXIT_CRITICAL(&s_dns_lock);
    if(result!=ESP_OK) {
        diagnostic(CP_DIAG_DNS,result==ESP_ERR_TIMEOUT?CP_DIAG_DNS_TIMEOUT:CP_DIAG_DNS_FAILED,result,true,false);
        log_evidence(NET_PHASE_DNS,result,0,ESP_OK,0,0,0,deadline-6000);
    }
    return result;
}
typedef cp_http_response_t response_t;
static esp_err_t http_event(esp_http_client_event_t *event)
{
    if(event->event_id==HTTP_EVENT_ON_CONNECTED)
        diagnostic(CP_DIAG_CLOUD_AUTH,CP_DIAG_CLOUD_CHECKING,ESP_OK,true,false);
    return cp_http_response_event(event,now_ms(),running());
}
/* s_http serializes credentials, HTTP, activation and configuration. */
static esp_err_t request_locked(const char *path, const char *body, size_t length,
    const char *hash, response_t *response, int *status)
{
    *status=0;
    const uint64_t started=now_ms();
    lock(); bool eligible=s_link && s_synced; unlock();
    if (!running() || !eligible) return ESP_ERR_INVALID_STATE;
    esp_err_t resolved=resolve_api();
    if(resolved!=ESP_OK)return resolved;
    diagnostic(CP_DIAG_TLS,CP_DIAG_TLS_CONNECTING,ESP_OK,true,false);
    response->deadline_ms=now_ms()+12000;
    char url[128], auth[CP_SETTINGS_TOKEN_SIZE+8];
    if (snprintf(url,sizeof(url),"%s%s",s_settings.api_origin,path)>=(int)sizeof(url)) return ESP_ERR_INVALID_SIZE;
    snprintf(auth,sizeof(auth),"Bearer %s",s_settings.device_token);
    esp_http_client_config_t config={
        .url=url, .timeout_ms=12000, .disable_auto_redirect=true, .is_async=true,
        /* Eligibility and the DNS preflight both require IPv4 GOT_IP. */
        .addr_type=HTTP_ADDR_TYPE_INET,
        .crt_bundle_attach=esp_crt_bundle_attach,
        .event_handler=http_event, .user_data=response,
        .buffer_size=1024, .buffer_size_tx=1024,
    };
    esp_http_client_handle_t client=esp_http_client_init(&config);
    if (!client) { memset(auth,0,sizeof(auth)); allocation_failed(NET_PHASE_CLIENT_INIT); return ESP_ERR_NO_MEM; }
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
    int tls_code=0,tls_flags=0;
    esp_err_t tls_error=esp_http_client_get_and_clear_last_tls_error(client,&tls_code,&tls_flags);
    int socket_errno=esp_http_client_get_errno(client);
    esp_http_client_cleanup(client);
    /* Keep driver evidence queued during the bounded HTTP operation. */
    drain_events();
    if (response->abort_reason!=ESP_OK) e=response->abort_reason;
    lock();
    s_snapshot.last_http_status=*status; s_snapshot.last_error=e;
    s_snapshot.diagnostic.http_status=*status>0&&*status<=599?*status:0;
    s_snapshot.diagnostic.tls_code=tls_code;s_snapshot.diagnostic.tls_flags=(uint32_t)tls_flags;
    if(e!=ESP_OK) {
        cp_diag_stage_t stage=s_snapshot.diagnostic.stage;
        cp_diag_code_t code;
        if(e==ESP_ERR_NO_MEM){stage=CP_DIAG_CLOUD_AUTH;code=CP_DIAG_RESOURCE_EXHAUSTED;}
        else if(tls_error==ESP_ERR_ESP_TLS_CANNOT_RESOLVE_HOSTNAME){stage=CP_DIAG_DNS;code=CP_DIAG_DNS_FAILED;}
        else if(tls_flags){stage=CP_DIAG_TLS;code=CP_DIAG_TLS_CERTIFICATE_FAILED;}
        else if(stage==CP_DIAG_WIFI_CONNECT || stage==CP_DIAG_DHCP)code=s_snapshot.diagnostic.code;
        else if(stage==CP_DIAG_TLS)code=e==ESP_ERR_TIMEOUT?CP_DIAG_TLS_TIMEOUT:CP_DIAG_TLS_FAILED;
        else code=e==ESP_ERR_TIMEOUT?CP_DIAG_CLOUD_TIMEOUT:CP_DIAG_HTTP_FAILED;
        diagnostic_locked(stage,code,e==ESP_ERR_NO_MEM?e:tls_error!=ESP_OK?tls_error:e,true,e==ESP_ERR_NO_MEM&&s_candidate_mode);
    } else if(*status==401||*status==403) {
        diagnostic_locked(CP_DIAG_CLOUD_AUTH,CP_DIAG_CLOUD_AUTH_FAILED,ESP_ERR_NOT_ALLOWED,false,true);
    } else if(*status<200||*status>=300) {
        diagnostic_locked(CP_DIAG_CLOUD_AUTH,CP_DIAG_HTTP_FAILED,ESP_ERR_INVALID_RESPONSE,*status>=500||*status==429,false);
    }
    if (e==ESP_OK && *status>=200 && *status<300) {
        s_snapshot.clock_trusted=true;
    } else if (*status==401 || *status==403) {
        s_snapshot.auth=CP_AUTH_REJECTED; s_snapshot.policy_valid=false;
    }
    unlock();
    log_evidence(NET_PHASE_HTTP_END,e,socket_errno,tls_error,tls_code,tls_flags,*status,started);
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
        if (!candidate) { allocation_failed(NET_PHASE_CONTACT_JSON); return false; }
        s_pending_contact=candidate; ++s_contact_seq;
    }
    if (!s_pending_contact) return false;
    response_t r={.body=calloc(1,CP_NETWORK_BODY_MAX+1)};
    if (!r.body) { allocation_failed(NET_PHASE_CONTACT_RESPONSE); return false; }
    int status=0;
    esp_err_t e=request_locked("/api/v2/device/contact",s_pending_contact,strlen(s_pending_contact),NULL,&r,&status);
    bool ok=e==ESP_OK && status==200 && cp_network_control_ack_matches(r.body,r.used,s_node,s_boot,s_contact_seq,NULL,NULL,NULL);
    free(r.body);
    if (ok) {
        lock();s_snapshot.auth=CP_AUTH_VALID;s_candidate_authenticated=true;
        diagnostic_locked(CP_DIAG_READY,CP_DIAG_NETWORK_VALIDATED,ESP_OK,true,false);unlock();
        free(s_pending_contact); s_pending_contact=NULL;
    } else if(e==ESP_OK&&status==200) {
        diagnostic(CP_DIAG_CLOUD_AUTH,CP_DIAG_INVALID_CLOUD_REPLY,ESP_ERR_INVALID_RESPONSE,false,false);
    }
    return ok;
}
static void fetch_policy(void)
{
    response_t r={.body=calloc(1,CP_NETWORK_BODY_MAX+1)};
    if (!r.body) { allocation_failed(NET_PHASE_POLICY_RESPONSE); return; }
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
                                       &s_pending_activation,&s_pending_apply_seq)) {
        if(s_apply_seq<UINT32_MAX)allocation_failed(NET_PHASE_ACTIVATION_JSON);
        return;
    }
    if (!s_pending_activation) return;
    response_t r={.body=calloc(1,CP_NETWORK_BODY_MAX+1)};
    if (!r.body) { allocation_failed(NET_PHASE_ACTIVATION_RESPONSE); return; }
    int status=0;
    esp_err_t e=request_locked("/api/v2/device/config/ack",s_pending_activation,strlen(s_pending_activation),NULL,&r,&status);
    cJSON *sent=cJSON_Parse(s_pending_activation);
    if(!sent) { allocation_failed(NET_PHASE_ACTIVATION_PARSE);free(r.body);return; }
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
    uint64_t reconnect_at=0,connect_started=0,control_at=0,contact_at=0,activation_at=0,sntp_at=0;
    uint32_t retry_ms=1000,cloud_retry=1000;unsigned sntp_server=0;
    static const char *const time_servers[]={"time.cloudflare.com","pool.ntp.org","time.windows.com"};
    bool registered=false;
    uint32_t reported_event_drops=__atomic_load_n(&s_event_drops,__ATOMIC_RELAXED);
    while(running()) {
        drain_events();uint64_t now=now_ms();
        uint32_t drops=__atomic_load_n(&s_event_drops,__ATOMIC_RELAXED);
        if(drops!=reported_event_drops) {
            ESP_LOGW("cp_network","event queue drops=%lu",(unsigned long)drops);
            reported_event_drops=drops;
        }
        lock();bool link=s_link,attempting=s_attempting,synced=s_synced,associated=s_associated;
        uint64_t stage_age=now>=s_stage_started?now-s_stage_started:0;unlock();
        if(!link) {
            if(associated) {
                if(stage_age>=20000){diagnostic(CP_DIAG_DHCP,CP_DIAG_DHCP_TIMEOUT,ESP_ERR_TIMEOUT,true,s_candidate_mode);esp_wifi_disconnect();}
            } else if(attempting && now-connect_started>20000) {
                esp_wifi_disconnect();
            } else if(!attempting && now>=reconnect_at) {
                lock();s_attempting=true;diagnostic_locked(CP_DIAG_WIFI_CONNECT,CP_DIAG_WIFI_CONNECTING,ESP_OK,true,false);unlock();
                connect_started=now;esp_err_t e=esp_wifi_connect();
                if(e!=ESP_OK){lock();s_attempting=false;s_snapshot.last_error=e;++s_snapshot.connection_failures;diagnostic_locked(CP_DIAG_WIFI_CONNECT,CP_DIAG_WIFI_CONNECT_FAILED,e,true,false);unlock();}
                reconnect_at=now+retry_ms;retry_ms=retry_ms<16000?retry_ms*2:30000;
            }
            if(!associated&&stage_age>=30000) {
                lock();cp_diag_code_t code=cp_network_diag_timeout_code(&s_snapshot.diagnostic);
                diagnostic_locked(CP_DIAG_WIFI_CONNECT,code,ESP_ERR_TIMEOUT,true,s_candidate_mode);unlock();
            }
        } else {
            retry_ms=1000;
            if(!s_sntp_started || (!synced && now-sntp_at>=8000)) {
                if(s_sntp_started){esp_netif_sntp_deinit();s_sntp_started=false;sntp_server=(sntp_server+1)%3;}
                esp_sntp_config_t config=ESP_NETIF_SNTP_DEFAULT_CONFIG(time_servers[sntp_server]);config.sync_cb=time_synced;
                esp_err_t e=esp_netif_sntp_init(&config);sntp_at=now;
                if(e==ESP_OK)s_sntp_started=true;
                else {lock();s_snapshot.last_error=e;diagnostic_locked(CP_DIAG_CLOCK,CP_DIAG_CLOCK_FAILED,e,true,false);unlock();}
            }
            if(!synced&&stage_age>=26000)diagnostic(CP_DIAG_CLOCK,CP_DIAG_CLOCK_TIMEOUT,ESP_ERR_TIMEOUT,true,s_candidate_mode);
            if(synced) {
                xSemaphoreTake(s_http,portMAX_DELAY);
                if(now>=contact_at&&running()) {
                    registered=contact();
                    contact_at=now_ms()+(registered?30000:cloud_retry);
                    if(!registered&&cloud_retry<8000)cloud_retry*=2;else if(registered)cloud_retry=1000;
                }
                if(registered && !s_candidate_mode && now>=control_at&&running()){fetch_policy();control_at=now_ms()+30000;}
                if(registered && !s_candidate_mode && now>=activation_at&&running()){send_activation();activation_at=now_ms()+10000;}
                xSemaphoreGive(s_http);
            }
        }
        vTaskDelay(pdMS_TO_TICKS(100));
    }
    xSemaphoreGive(s_stopped);vTaskDelete(NULL);
}
esp_err_t cp_network_init(const char *node, const char *boot)
{
    if (!cp_network_identity_valid(node,boot)) return ESP_ERR_INVALID_ARG;
    if (s_lock) return !strcmp(node,s_node)&&!strcmp(boot,s_boot)?ESP_OK:ESP_ERR_INVALID_STATE;
    s_lock=xSemaphoreCreateMutex(); s_http=xSemaphoreCreateMutex(); s_stopped=xSemaphoreCreateBinary();
    s_events=xQueueCreate(16,sizeof(net_event_t));
    if (!s_lock||!s_http||!s_stopped||!s_events) {
        if (s_lock) vSemaphoreDelete(s_lock);
        if (s_http) vSemaphoreDelete(s_http);
        if (s_stopped) vSemaphoreDelete(s_stopped);
        if(s_events)vQueueDelete(s_events);
        s_lock=NULL; s_http=NULL; s_stopped=NULL;s_events=NULL;
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
    s_settings=*settings;s_diag_started=s_stage_started=now_ms();xQueueReset(s_events);
    lock();cp_network_diag_reset(&s_snapshot.diagnostic);
    s_link=false;s_associated=false;s_attempting=false;s_synced=s_bootstrap_clock;
    s_candidate_authenticated=false;s_config_verified=false;
    diagnostic_locked(CP_DIAG_WIFI_CONNECT,CP_DIAG_WIFI_CONNECTING,ESP_OK,true,false);unlock();
    /* Vendor INFO association logs contain network identifiers; our safe
     * diagnostic path retains only enum/numeric evidence instead. */
    esp_log_level_set("wifi",ESP_LOG_WARN);
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
    e=esp_event_handler_instance_register(WIFI_EVENT,ESP_EVENT_ANY_ID,wifi_event,NULL,&s_wifi_handler); if (e!=ESP_OK) goto failed;
    e=esp_event_handler_instance_register(IP_EVENT,ESP_EVENT_ANY_ID,wifi_event,NULL,&s_ip_handler); if (e!=ESP_OK) goto failed;
    wifi_config_t wifi={0};
    memcpy(wifi.sta.ssid,settings->ssid,strlen(settings->ssid));
    memcpy(wifi.sta.password,settings->password,strlen(settings->password));
    wifi.sta.threshold.authmode=settings->wifi_security==CP_WIFI_OPEN?WIFI_AUTH_OPEN:settings->wifi_security==CP_WIFI_ENTERPRISE_PEAP?WIFI_AUTH_WPA2_ENTERPRISE:WIFI_AUTH_WPA2_PSK;
    wifi.sta.pmf_cfg.capable=true;
    e=esp_wifi_set_mode(WIFI_MODE_STA);
    if (e==ESP_OK) e=esp_wifi_set_config(WIFI_IF_STA,&wifi);
    memset(&wifi,0,sizeof(wifi));
    if (e!=ESP_OK) goto failed;
    if(settings->wifi_security==CP_WIFI_ENTERPRISE_PEAP) {
        /* Explicit user-selected PEAP without RADIUS CA validation. This is
         * separate from the HTTPS client, whose CA/hostname/date checks remain. */
        esp_eap_client_clear_ca_cert();
        e=esp_eap_client_use_default_cert_bundle(false);
        if(e==ESP_OK)e=esp_eap_client_set_disable_time_check(true);
        if(e==ESP_OK)e=esp_eap_client_set_eap_methods(ESP_EAP_TYPE_PEAP);
        if(e==ESP_OK)e=esp_eap_client_set_identity((const unsigned char *)settings->eap_identity,strlen(settings->eap_identity));
        if(e==ESP_OK)e=esp_eap_client_set_username((const unsigned char *)settings->eap_username,strlen(settings->eap_username));
        if(e==ESP_OK)e=esp_eap_client_set_password((const unsigned char *)settings->eap_password,strlen(settings->eap_password));
        if(e==ESP_OK)e=esp_wifi_sta_enterprise_enable();
        if(e!=ESP_OK)goto failed;
        s_enterprise_enabled=true;
    }
    e=esp_wifi_start(); if (e!=ESP_OK) goto failed;
    lock();
    s_snapshot.network=CP_NETWORK_CONNECTING; s_snapshot.auth=CP_AUTH_UNKNOWN;
    s_snapshot.clock_trusted=false; s_snapshot.policy_valid=false; s_snapshot.policy_present=false; s_snapshot.policy_rejected=false; s_snapshot.policy_expired=false; s_snapshot.policy_response_sequence=0; s_snapshot.desired_config_id[0]=0;
    unlock();
    __atomic_store_n(&s_running,true,__ATOMIC_RELEASE);
    if (xTaskCreate(service,"cp_network",8192,NULL,4,&s_task)!=pdPASS) { s_task=NULL; e=ESP_ERR_NO_MEM; goto failed; }
    return ESP_OK;
failed:
    lock();s_snapshot.last_error=e;unlock();
    diagnostic(CP_DIAG_WIFI_CONNECT,CP_DIAG_NETWORK_START_FAILED,e,true,true);
    log_evidence(NET_PHASE_START,e,0,ESP_OK,0,0,0,s_diag_started);
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
    if (s_wifi_handler) { esp_event_handler_instance_unregister(WIFI_EVENT,ESP_EVENT_ANY_ID,s_wifi_handler); s_wifi_handler=NULL; }
    if (s_ip_handler) { esp_event_handler_instance_unregister(IP_EVENT,ESP_EVENT_ANY_ID,s_ip_handler); s_ip_handler=NULL; }
    drain_events();
    if (s_wifi_initialized) {
        if(s_enterprise_enabled){esp_err_t off=esp_wifi_sta_enterprise_disable();if(off!=ESP_OK){xSemaphoreGive(s_http);return off;}s_enterprise_enabled=false;}
        esp_eap_client_clear_identity();esp_eap_client_clear_username();esp_eap_client_clear_password();esp_eap_client_clear_ca_cert();
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
    lock(); s_link=false; s_synced=false; s_attempting=false;s_associated=false;
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
void cp_network_diagnostic_snapshot(cp_network_diagnostic_t *out) {
    if(!out)return;
    if(!s_lock){cp_network_diag_reset(out);return;}
    lock();*out=s_snapshot.diagnostic;if(!out->terminal)out->elapsed_ms=elapsed_ms();unlock();
}
esp_err_t cp_network_validate_candidate_with_progress(const cp_settings_t *settings,
    uint32_t timeout_ms,cp_network_progress_fn progress,void *context)
{
    if(timeout_ms<1000||timeout_ms>120000)return ESP_ERR_INVALID_ARG;
    s_candidate_mode=true;esp_err_t e=cp_network_start(settings);
    if(e!=ESP_OK){s_candidate_mode=false;cp_network_diagnostic_t d;cp_network_diagnostic_snapshot(&d);if(progress)progress(&d,context);return e;}
    uint64_t end=now_ms()+timeout_ms;e=ESP_ERR_TIMEOUT;
    cp_network_diagnostic_t d;
    while(now_ms()<end) {
        cp_network_diagnostic_snapshot(&d);if(progress)progress(&d,context);
        lock();bool authenticated=s_candidate_authenticated;cp_auth_state_t auth=s_snapshot.auth;bool trusted=s_snapshot.clock_trusted;unlock();
        if(d.terminal){e=d.esp_err?d.esp_err:ESP_FAIL;break;}
        if(auth==CP_AUTH_REJECTED){e=ESP_ERR_NOT_ALLOWED;break;}
        if(authenticated&&auth==CP_AUTH_VALID&&trusted){e=ESP_OK;break;}
        vTaskDelay(pdMS_TO_TICKS(250));
    }
    lock();
    if(e==ESP_OK)diagnostic_locked(CP_DIAG_READY,CP_DIAG_NETWORK_VALIDATED,ESP_OK,true,true);
    else if(!s_snapshot.diagnostic.terminal) {
        if(e==ESP_ERR_NOT_ALLOWED)diagnostic_locked(CP_DIAG_CLOUD_AUTH,CP_DIAG_CLOUD_AUTH_FAILED,e,false,true);
        else cp_network_diag_finish_timeout(&s_snapshot.diagnostic,elapsed_ms());
        if(s_snapshot.diagnostic.esp_err!=ESP_OK)e=s_snapshot.diagnostic.esp_err;
    }
    unlock();
    esp_err_t stopped=cp_network_stop();s_candidate_mode=false;
    if(stopped!=ESP_OK){lock();s_snapshot.diagnostic.terminal=false;diagnostic_locked(CP_DIAG_HANDOFF,CP_DIAG_NETWORK_STOP_FAILED,stopped,true,true);unlock();e=stopped;}
    cp_network_diagnostic_snapshot(&d);if(progress)progress(&d,context);return e;
}
esp_err_t cp_network_validate_candidate(const cp_settings_t *settings,uint32_t timeout_ms)
{return cp_network_validate_candidate_with_progress(settings,timeout_ms,NULL,NULL);}
cp_net_upload_result_t cp_network_upload_frozen(const void *body, size_t length,
    const cp_network_batch_t *expected, cp_network_ack_t *ack)
{
    if (ack) memset(ack,0,sizeof(*ack));
    if (!s_lock || !body || !length || length>CP_NETWORK_BODY_MAX || !cp_network_batch_valid(expected) || !ack ||
        strcmp(expected->node_id,s_node)) return CP_NET_UPLOAD_REJECTED;
    char hash[65];
    if (!cp_network_sha256(body,length,hash) || strcmp(hash,expected->body_sha256)) return CP_NET_UPLOAD_REJECTED;
    response_t r={.body=calloc(1,CP_NETWORK_BODY_MAX+1)};
    if (!r.body) {
        allocation_failed(NET_PHASE_UPLOAD_RESPONSE);
        lock();++s_snapshot.upload_failures;unlock();
        return CP_NET_UPLOAD_RETRY;
    }
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
