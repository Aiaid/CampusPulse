#include "cp_v3_clock_bootstrap.h"
#include "sdkconfig.h"
#include "esp_crt_bundle.h"
#include "esp_event.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_random.h"
#include "esp_sntp.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "mbedtls/ecdsa.h"
#include "mbedtls/pk.h"
#include "mbedtls/sha256.h"
#include <string.h>
#include <strings.h>
#include <stdio.h>
#include <sys/time.h>

#if !CONFIG_MBEDTLS_HAVE_TIME || !CONFIG_MBEDTLS_HAVE_TIME_DATE || !CONFIG_MBEDTLS_CERTIFICATE_BUNDLE
#error "signed clock probe requires full certificate chain, hostname and date checks"
#endif

static TaskHandle_t owner;
static esp_netif_t *station;
static esp_event_handler_instance_t wifi_handler,ip_handler;
static bool wifi_initialized,wifi_started,sntp_started,link_up,hint_ready;
static bool (*cancel_check)(void);
static struct timeval previous_wall;
static uint64_t previous_mono;
static bool wall_saved;
static esp_http_client_handle_t http;
static uint64_t probe_deadline,probe_started;
static char response[CP_V3_CLOCK_RESPONSE_MAX+1];
static char request_body[80];
static size_t response_bytes;
static bool response_bad,response_finished;

static uint64_t mono(void){return (uint64_t)esp_timer_get_time()/1000u;}
static bool cancelled(void){return cancel_check&&cancel_check();}
static void wipe(void *p,size_t n){volatile uint8_t *b=p;while(n--)*b++=0;}
static void wait_tick(void){vTaskDelay(pdMS_TO_TICKS(20));}
static void wifi_event(void *arg,esp_event_base_t base,int32_t id,void *data){
    (void)arg;(void)data;
    if(base==IP_EVENT&&id==IP_EVENT_STA_GOT_IP)__atomic_store_n(&link_up,true,__ATOMIC_RELEASE);
    else if((base==WIFI_EVENT&&id==WIFI_EVENT_STA_DISCONNECTED)||
            (base==IP_EVENT&&id==IP_EVENT_STA_LOST_IP))__atomic_store_n(&link_up,false,__ATOMIC_RELEASE);
}
static void hint_received(struct timeval *tv){
    /* The SDK has only set a tentative wall clock. It grants no device trust. */
    bool plausible=tv&&tv->tv_sec>=1704067200LL&&tv->tv_sec<=7258118400LL;
    __atomic_store_n(&hint_ready,plausible,__ATOMIC_RELEASE);
}
static esp_err_t http_event(esp_http_client_event_t *e){
    if(cancelled()||mono()>probe_deadline){response_bad=true;return ESP_FAIL;}
    if(e->event_id==HTTP_EVENT_HEADERS_SENT){
        /* IDF dispatches this immediately before sending post_data. No nonce
         * is in the URL/headers; every later retransmission is rejected. */
        if(probe_started)response_bad=true;
        else {probe_started=mono();probe_deadline=probe_started+CP_V3_CLOCK_RTT_MAX_MS;}
    }else if(e->event_id==HTTP_EVENT_ON_HEADER){
        if(e->header_key&&!strcasecmp(e->header_key,"Content-Encoding")&&
           (!e->header_value||strcasecmp(e->header_value,"identity")))response_bad=true;
    }else if(e->event_id==HTTP_EVENT_ON_DATA){
        if(e->data_len<0||(size_t)e->data_len>CP_V3_CLOCK_RESPONSE_MAX-response_bytes)response_bad=true;
        else if(!response_bad){memcpy(response+response_bytes,e->data,(size_t)e->data_len);response_bytes+=(size_t)e->data_len;}
    }else if(e->event_id==HTTP_EVENT_ON_FINISH)response_finished=true;
    else if(e->event_id==HTTP_EVENT_REDIRECT)response_bad=true;
    return response_bad?ESP_FAIL:ESP_OK;
}
static bool signature_verify(void *ctx,const uint8_t spki[91],const uint8_t sig[64],const void *data,size_t bytes){
    (void)ctx;mbedtls_pk_context key;mbedtls_pk_init(&key);
    mbedtls_mpi r,s;mbedtls_mpi_init(&r);mbedtls_mpi_init(&s);uint8_t digest[32];
    bool okay=mbedtls_pk_parse_public_key(&key,spki,91)==0&&
        mbedtls_pk_can_do(&key,MBEDTLS_PK_ECDSA)&&mbedtls_sha256(data,bytes,digest,0)==0;
    if(okay){
        mbedtls_ecp_keypair *ec=mbedtls_pk_ec(key);
        okay=ec->MBEDTLS_PRIVATE(grp).id==MBEDTLS_ECP_DP_SECP256R1&&
            mbedtls_ecp_check_pubkey(&ec->MBEDTLS_PRIVATE(grp),&ec->MBEDTLS_PRIVATE(Q))==0&&
            mbedtls_mpi_read_binary(&r,sig,32)==0&&mbedtls_mpi_read_binary(&s,sig+32,32)==0&&
            mbedtls_ecdsa_verify(&ec->MBEDTLS_PRIVATE(grp),digest,sizeof digest,&ec->MBEDTLS_PRIVATE(Q),&r,&s)==0;
    }
    mbedtls_mpi_free(&r);mbedtls_mpi_free(&s);mbedtls_pk_free(&key);wipe(digest,sizeof digest);return okay;
}
esp_err_t cp_v3_clock_stop(void){
    if(!__atomic_load_n(&owner,__ATOMIC_ACQUIRE))return ESP_OK;
    if(owner!=xTaskGetCurrentTaskHandle())return ESP_ERR_INVALID_STATE;
    if(sntp_started){esp_sntp_stop();esp_sntp_set_time_sync_notification_cb(NULL);sntp_started=false;}
    if(http){esp_err_t e=esp_http_client_cleanup(http);if(e!=ESP_OK)return e;http=NULL;}
    /* Restore the previous wall-clock mapping before giving up ownership.
     * Neither tentative SNTP nor a failed probe survives into another client. */
    if(wall_saved){
        uint64_t elapsed=mono()-previous_mono;
        struct timeval tv=previous_wall;tv.tv_sec+=(time_t)(elapsed/1000u);
        tv.tv_usec+=(suseconds_t)(elapsed%1000u)*1000;
        if(tv.tv_usec>=1000000){tv.tv_sec++;tv.tv_usec-=1000000;}
        if(settimeofday(&tv,NULL)!=0)return ESP_FAIL;
        wall_saved=false;
    }
    if(wifi_started){esp_err_t e=esp_wifi_stop();if(e!=ESP_OK&&e!=ESP_ERR_WIFI_NOT_STARTED)return e;wifi_started=false;}
    if(wifi_initialized){esp_err_t e=esp_wifi_deinit();if(e!=ESP_OK)return e;wifi_initialized=false;}
    if(wifi_handler){esp_err_t e=esp_event_handler_instance_unregister(WIFI_EVENT,ESP_EVENT_ANY_ID,wifi_handler);if(e!=ESP_OK)return e;wifi_handler=NULL;}
    if(ip_handler){esp_err_t e=esp_event_handler_instance_unregister(IP_EVENT,ESP_EVENT_ANY_ID,ip_handler);if(e!=ESP_OK)return e;ip_handler=NULL;}
    if(station){esp_netif_destroy_default_wifi(station);station=NULL;}
    wipe(response,sizeof response);wipe(request_body,sizeof request_body);response_bytes=0;cancel_check=NULL;
    __atomic_store_n(&link_up,false,__ATOMIC_RELEASE);__atomic_store_n(&hint_ready,false,__ATOMIC_RELEASE);
    __atomic_store_n(&owner,NULL,__ATOMIC_RELEASE);return ESP_OK;
}
esp_err_t cp_v3_clock_bootstrap(const cp_settings_t *settings,const uint8_t spki[91],
    const char *key_id,bool (*cancel_fn)(void),cp_v3_time_t *out){
    if(!out)return ESP_ERR_INVALID_ARG;
    memset(out,0,sizeof *out);
    if(!settings||!spki||!key_id||!cp_settings_validate(settings)||
       strcmp(settings->api_origin,CP_API_ORIGIN)||settings->wifi_security==CP_WIFI_ENTERPRISE_PEAP||
       !*key_id||strnlen(key_id,33)>32)return ESP_ERR_INVALID_ARG;
    TaskHandle_t expected=NULL;
    if(!__atomic_compare_exchange_n(&owner,&expected,xTaskGetCurrentTaskHandle(),false,__ATOMIC_ACQ_REL,__ATOMIC_ACQUIRE))return ESP_ERR_INVALID_STATE;
    wifi_mode_t mode;esp_err_t result=esp_wifi_get_mode(&mode);
    if(result!=ESP_ERR_WIFI_NOT_INIT||esp_sntp_enabled()){
        __atomic_store_n(&owner,NULL,__ATOMIC_RELEASE);return ESP_ERR_INVALID_STATE;
    }
    cancel_check=cancel_fn;previous_mono=mono();
    if(gettimeofday(&previous_wall,NULL)!=0){result=ESP_FAIL;goto done;}wall_saved=true;
    esp_log_level_set("wifi",ESP_LOG_WARN);esp_log_level_set("esp-tls",ESP_LOG_NONE);
    esp_log_level_set("esp-tls-mbedtls",ESP_LOG_NONE);esp_log_level_set("mbedtls",ESP_LOG_NONE);
    esp_log_level_set("HTTP_CLIENT",ESP_LOG_NONE);
    result=esp_netif_init();if(result!=ESP_OK)goto done;
    result=esp_event_loop_create_default();if(result!=ESP_OK&&result!=ESP_ERR_INVALID_STATE)goto done;
    if(esp_netif_get_handle_from_ifkey("WIFI_STA_DEF")){result=ESP_ERR_INVALID_STATE;goto done;}
    station=esp_netif_create_default_wifi_sta();if(!station){result=ESP_ERR_NO_MEM;goto done;}
    wifi_init_config_t init=WIFI_INIT_CONFIG_DEFAULT();
    result=esp_wifi_init(&init);if(result!=ESP_OK)goto done;wifi_initialized=true;
    result=esp_wifi_set_storage(WIFI_STORAGE_RAM);if(result!=ESP_OK)goto done;
    result=esp_event_handler_instance_register(WIFI_EVENT,ESP_EVENT_ANY_ID,wifi_event,NULL,&wifi_handler);if(result!=ESP_OK)goto done;
    result=esp_event_handler_instance_register(IP_EVENT,ESP_EVENT_ANY_ID,wifi_event,NULL,&ip_handler);if(result!=ESP_OK)goto done;
    wifi_config_t wifi={0};memcpy(wifi.sta.ssid,settings->ssid,strlen(settings->ssid));
    memcpy(wifi.sta.password,settings->password,strlen(settings->password));
    wifi.sta.threshold.authmode=settings->wifi_security==CP_WIFI_OPEN?WIFI_AUTH_OPEN:WIFI_AUTH_WPA2_PSK;wifi.sta.pmf_cfg.capable=true;
    result=esp_wifi_set_mode(WIFI_MODE_STA);if(result==ESP_OK)result=esp_wifi_set_config(WIFI_IF_STA,&wifi);wipe(&wifi,sizeof wifi);if(result!=ESP_OK)goto done;
    result=esp_wifi_start();if(result!=ESP_OK)goto done;wifi_started=true;
    result=esp_wifi_connect();if(result!=ESP_OK)goto done;
    uint64_t deadline=mono()+30000;
    while(!cancelled()&&mono()<deadline&&!__atomic_load_n(&link_up,__ATOMIC_ACQUIRE))wait_tick();
    if(cancelled()||!__atomic_load_n(&link_up,__ATOMIC_ACQUIRE)){result=ESP_ERR_TIMEOUT;goto done;}
    esp_sntp_setoperatingmode(ESP_SNTP_OPMODE_POLL);esp_sntp_set_sync_mode(SNTP_SYNC_MODE_IMMED);
    esp_sntp_setservername(0,"ntp.aliyun.com");
    esp_sntp_set_time_sync_notification_cb(hint_received);esp_sntp_set_sync_status(SNTP_SYNC_STATUS_RESET);
    sntp_started=true;esp_sntp_init();deadline=mono()+20000;
    while(!cancelled()&&mono()<deadline&&!__atomic_load_n(&hint_ready,__ATOMIC_ACQUIRE))wait_tick();
    esp_sntp_stop();esp_sntp_set_time_sync_notification_cb(NULL);sntp_started=false;
    if(cancelled()||!__atomic_load_n(&hint_ready,__ATOMIC_ACQUIRE)){result=ESP_ERR_TIMEOUT;goto done;}
    result=ESP_ERR_INVALID_RESPONSE;
    for(unsigned attempt=0;attempt<3&&!cancelled();attempt++){
        uint8_t random[32];char nonce[65];esp_fill_random(random,sizeof random);
        static const char hex[]="0123456789abcdef";
        for(size_t i=0;i<sizeof random;i++){nonce[i*2]=hex[random[i]>>4];nonce[i*2+1]=hex[random[i]&15];}nonce[64]=0;wipe(random,sizeof random);
        int body_bytes=snprintf(request_body,sizeof request_body,"{\"nonce\":\"%s\"}",nonce);
        /* DNS/TLS and request headers carry no nonce. Only the actual body
         * write starts the freshness interval; handshake latency cannot make
         * a previously unknowable challenge stale. */
        probe_started=0;probe_deadline=mono()+30000;
        response_bytes=0;response_bad=false;response_finished=false;
        esp_http_client_config_t config={.url=CP_API_ORIGIN "/api/v3/clock",.method=HTTP_METHOD_POST,
            .timeout_ms=6000,.is_async=true,.disable_auto_redirect=true,.event_handler=http_event,
            .crt_bundle_attach=esp_crt_bundle_attach,.skip_cert_common_name_check=false,
            .buffer_size=1024,.buffer_size_tx=512};
        http=esp_http_client_init(&config);if(!http){result=ESP_ERR_NO_MEM;break;}
        result=esp_http_client_set_header(http,"Content-Type","application/json");
        if(result==ESP_OK)result=esp_http_client_set_header(http,"Accept","application/json");
        if(result==ESP_OK)result=esp_http_client_set_header(http,"Cache-Control","no-store");
        if(result==ESP_OK)result=esp_http_client_set_post_field(http,request_body,body_bytes);
        if(result==ESP_OK){
            do {
                result=esp_http_client_perform(http);
                if(result!=ESP_ERR_HTTP_EAGAIN)break;
                wait_tick();
            }while(!response_bad&&!cancelled()&&mono()<=probe_deadline);
        }
        uint64_t ended=mono();
        bool verified=result==ESP_OK&&!cancelled()&&!response_bad&&response_finished&&probe_started&&
            esp_http_client_get_status_code(http)==200&&esp_http_client_is_complete_data_received(http)&&
            cp_v3_clock_verify(response,response_bytes,spki,key_id,nonce,probe_started,ended,1,signature_verify,NULL,out);
        esp_err_t cleanup=esp_http_client_cleanup(http);
        if(cleanup==ESP_OK)http=NULL;
        wipe(nonce,sizeof nonce);
        if(cleanup!=ESP_OK){result=cleanup;break;}
        if(verified){result=ESP_OK;break;}
        result=ESP_ERR_INVALID_RESPONSE;
        if(attempt<2)vTaskDelay(pdMS_TO_TICKS(200));
    }
done: {
        esp_err_t cleanup=cp_v3_clock_stop();
        if(cleanup!=ESP_OK)result=cleanup;
        if(result!=ESP_OK)memset(out,0,sizeof *out);
        return result;
    }
}
