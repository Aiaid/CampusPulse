/* Synthetic transport receipts only. No production API, BLE, journal or UI. */
#include <errno.h>
#include <inttypes.h>
#include <stdio.h>
#include <string.h>
#include <sys/time.h>
#include <time.h>
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "esp_crt_bundle.h"
#include "esp_heap_caps.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_netif_sntp.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "esp_websocket_client.h"
#include "esp_wifi.h"
#include "mbedtls/sha256.h"
#include "probe_wire.h"
#include "link_config.h"

esp_err_t probe_wifi_start_saved(uint32_t timeout_ms);
#define HEAP_CAPS (MALLOC_CAP_INTERNAL|MALLOC_CAP_8BIT)
#define REQUEST_US 12000000LL
static int64_t end_us;
static uint8_t run_bytes[16],payload[8192];
static char run_hex[33];
static uint32_t sequence;
static unsigned failures,successes;
static int remaining_ms(int cap)
{
    int64_t remaining=(end_us-esp_timer_get_time())/1000;
    return remaining<1?0:remaining<cap?(int)remaining:cap;
}
static bool available(void){return remaining_ms(1)>0;}
static void digest(size_t bytes,char hash[65])
{
    uint8_t sha[32];mbedtls_sha256(payload,bytes,sha,0);probe_hex(sha,32,hash);
}
static bool clock_prepare(void)
{
    struct timeval start={.tv_sec=CFG_epoch};
    if(settimeofday(&start,NULL)!=0)return false;
    esp_sntp_config_t cfg=ESP_NETIF_SNTP_DEFAULT_CONFIG("time.cloudflare.com");
    cfg.start=true;
    esp_err_t init=esp_netif_sntp_init(&cfg);
    esp_err_t sync=init==ESP_OK?esp_netif_sntp_sync_wait(pdMS_TO_TICKS(10000)):init;
    if(init==ESP_OK)esp_netif_sntp_deinit();
    time_t now=time(NULL);
    bool valid=now>=CFG_epoch-300&&now<=CFG_epoch+86400&&now>=1735689600;
    printf("CF_CLOCK configured_epoch=%lld now=%lld sntp_result=%d guard=%u\n",
        (long long)CFG_epoch,(long long)now,sync,valid);
    return valid;
}

typedef struct {
    bool open,overflow;
    unsigned connects,headers;
    int64_t start,connect_us,first_us;
    size_t used;
    char response[PROBE_RECEIPT_CAP];
} http_state_t;
static esp_err_t http_event(esp_http_client_event_t *event)
{
    http_state_t *s=event->user_data;
    switch(event->event_id){
    case HTTP_EVENT_ON_CONNECTED:
        s->open=true;s->connects++;s->connect_us=esp_timer_get_time()-s->start;
        esp_http_client_set_timeout_ms(event->client,1000);break;
    case HTTP_EVENT_DISCONNECTED:s->open=false;break;
    case HTTP_EVENT_HEADERS_SENT:s->headers++;break;
    case HTTP_EVENT_ON_DATA:
        if(s->first_us<0)s->first_us=esp_timer_get_time()-s->start;
        if(event->data_len<0||(size_t)event->data_len>sizeof(s->response)-1-s->used)s->overflow=true;
        else if(!s->overflow){memcpy(s->response+s->used,event->data,event->data_len);s->used+=event->data_len;}
        break;
    default:break;
    }return ESP_OK;
}
static esp_http_client_handle_t http_new(http_state_t *state)
{
    esp_http_client_config_t cfg={.url=cfg_https_origin,.crt_bundle_attach=esp_crt_bundle_attach,
        .tls_version=ESP_HTTP_CLIENT_TLS_VER_TLS_1_2,.skip_cert_common_name_check=false,
        .disable_auto_redirect=true,.max_authorization_retries=-1,.timeout_ms=12000,.is_async=true,
        .event_handler=http_event,.user_data=state,.buffer_size=1024,.buffer_size_tx=1024,
        .keep_alive_enable=true,.addr_type=HTTP_ADDR_TYPE_INET};
    return esp_http_client_init(&cfg);
}
static bool http_request(esp_http_client_handle_t client,http_state_t *s,const char *mode,
    size_t bytes,unsigned sample,char previous_id[37])
{
    bool open=s->open;memset(s,0,sizeof(*s));s->open=open;s->connect_us=s->first_us=-1;
    uint32_t seq=++sequence;probe_payload(payload,bytes,run_bytes,seq);
    char hash[65],url[320];digest(bytes,hash);snprintf(url,sizeof(url),"%s/benchmark",cfg_https_origin);
    esp_err_t err=esp_http_client_set_url(client,url);
    if(err==ESP_OK)err=esp_http_client_set_method(client,HTTP_METHOD_POST);
    if(err==ESP_OK)err=esp_http_client_set_header(client,"Authorization",cfg_authorization);
    if(err==ESP_OK)err=esp_http_client_set_header(client,"Content-Type","application/octet-stream");
    if(err==ESP_OK)err=esp_http_client_set_post_field(client,(const char*)payload,(int)bytes);
    size_t free_start=heap_caps_get_free_size(HEAP_CAPS),largest=heap_caps_get_largest_free_block(HEAP_CAPS);
    bool monitor=heap_caps_monitor_local_minimum_free_size_start()==ESP_OK;
    s->start=esp_timer_get_time();
    int cap=remaining_ms(12000);int64_t deadline=s->start+(int64_t)cap*1000;
    if(!cap)err=ESP_ERR_TIMEOUT;
    while(err==ESP_OK||err==ESP_ERR_HTTP_EAGAIN){
        int left=(int)((deadline-esp_timer_get_time())/1000);
        if(left<=0){err=ESP_ERR_TIMEOUT;break;}
        int slice=s->open?1000:12000;if(slice>left)slice=left;
        esp_http_client_set_timeout_ms(client,slice);errno=0;
        err=esp_http_client_perform(client);
        if(err!=ESP_ERR_HTTP_EAGAIN)break;
        vTaskDelay(pdMS_TO_TICKS(20));
    }
    int64_t elapsed=esp_timer_get_time()-s->start;
    int status=esp_http_client_get_status_code(client),tls_error=0,tls_flags=0;
    esp_http_client_get_and_clear_last_tls_error(client,&tls_error,&tls_flags);
    probe_receipt_t receipt={0};
    bool valid=err==ESP_OK&&status==200&&!s->overflow&&elapsed<=REQUEST_US
        &&esp_http_client_is_complete_data_received(client)
        &&probe_receipt(s->response,s->used,run_hex,seq,bytes,hash,&receipt);
    // HTTP Worker receipts have request-scoped IDs. Socket reuse is observed
    // locally through retained SDK open state and absence of connect events.
    bool reused=valid&&open&&s->connects==0&&previous_id[0];
    const char *stage=err!=ESP_OK?(s->connects||s->open?"io":"connect"):
        status!=200?"status":!valid?"receipt":"none";
    size_t minimum=monitor?heap_caps_get_minimum_free_size(HEAP_CAPS):0;
    if(monitor)heap_caps_monitor_local_minimum_free_size_stop();
    printf("CF_HTTP mode=%s sample=%u seq=%"PRIu32" bytes=%u valid=%u err=%d stage=%s status=%d "
        "connects=%u connect_us=%"PRId64" first_body_us=%"PRId64" elapsed_us=%"PRId64" "
        "reuse_verified=%u response_bytes=%u overflow=%u tls_error=%d tls_flags=%d "
        "free_start=%u free_min=%u free_end=%u largest_start=%u largest_end=%u connection_id=%s colo=%s\n",
        mode,sample,seq,(unsigned)bytes,valid,err,stage,status,s->connects,s->connect_us,s->first_us,elapsed,
        reused,(unsigned)s->used,s->overflow,tls_error,tls_flags,(unsigned)free_start,
        (unsigned)minimum,(unsigned)heap_caps_get_free_size(HEAP_CAPS),(unsigned)largest,
        (unsigned)heap_caps_get_largest_free_block(HEAP_CAPS),valid?receipt.connection_id:"none",valid?receipt.colo:"none");
    if(valid){successes++;strcpy(previous_id,receipt.connection_id);}else{failures++;previous_id[0]=0;esp_http_client_close(client);}
    return valid;
}
static void http_phase(bool reuse,size_t bytes)
{
    http_state_t state={0};esp_http_client_handle_t client=NULL;char previous[37]={0};
    unsigned count=reuse?CFG_reuseSamples:CFG_freshSamples;
    for(unsigned i=0;i<count&&available();i++){
        if(!client){client=http_new(&state);previous[0]=0;}
        if(!client){failures++;printf("CF_HTTP_ALLOC valid=0\n");break;}
        bool valid=http_request(client,&state,reuse?"reuse":"fresh",bytes,i,previous);
        if(!reuse||!valid){esp_http_client_cleanup(client);client=NULL;state.open=false;}
        vTaskDelay(pdMS_TO_TICKS(30));
    }
    if(client)esp_http_client_cleanup(client);
}

typedef struct { size_t length;char data[PROBE_RECEIPT_CAP]; } ws_message_t;
typedef struct {
    QueueHandle_t messages;
    unsigned connected,disconnected,closed,errors,pongs,invalid,queue_losses;
    int tls_error,tls_flags,handshake_status,close_code;
    probe_assembly_t assembly;
    int64_t connected_at;
} ws_state_t;
static unsigned counter(unsigned *p){return __atomic_load_n(p,__ATOMIC_ACQUIRE);}
static void increment(unsigned *p){__atomic_add_fetch(p,1,__ATOMIC_RELEASE);}
static void ws_event(void *arg,esp_event_base_t base,int32_t id,void *data)
{
    (void)base;ws_state_t *s=arg;esp_websocket_event_data_t *e=data;
    if(id==WEBSOCKET_EVENT_CONNECTED){s->connected_at=esp_timer_get_time();increment(&s->connected);}
    else if(id==WEBSOCKET_EVENT_DISCONNECTED)increment(&s->disconnected);
    else if(id==WEBSOCKET_EVENT_CLOSED)increment(&s->closed);
    else if(id==WEBSOCKET_EVENT_ERROR){
        s->tls_error=e->error_handle.esp_tls_stack_err;s->tls_flags=e->error_handle.esp_tls_cert_verify_flags;
        s->handshake_status=e->error_handle.esp_ws_handshake_status_code;increment(&s->errors);
    }else if(id==WEBSOCKET_EVENT_DATA){
        if(e->op_code==0xa){increment(&s->pongs);return;}
        if(e->op_code==0x8){if(e->data_len>=2)s->close_code=((uint8_t)e->data_ptr[0]<<8)|(uint8_t)e->data_ptr[1];return;}
        int result=probe_fragment(&s->assembly,e->op_code,e->fin,e->payload_offset,e->payload_len,e->data_ptr,e->data_len);
        if(result<0)increment(&s->invalid);
        else if(result==1){ws_message_t message={.length=s->assembly.used};memcpy(message.data,s->assembly.buffer,message.length);
            if(xQueueSend(s->messages,&message,0)!=pdTRUE)increment(&s->queue_losses);}
    }
}
static esp_websocket_client_handle_t ws_connect(ws_state_t *state,const char *phase)
{
    esp_websocket_client_config_t cfg={.uri=cfg_ws_url,.headers=cfg_ws_headers,
        .disable_auto_reconnect=true,.enable_close_reconnect=false,.crt_bundle_attach=esp_crt_bundle_attach,
        .skip_cert_common_name_check=false,.transport=WEBSOCKET_TRANSPORT_OVER_SSL,
        .network_timeout_ms=remaining_ms(12000),.buffer_size=1024,.task_stack=6144,
        .ping_interval_sec=10,.pingpong_timeout_sec=10,.disable_pingpong_discon=false,
        .keep_alive_enable=true};
    unsigned before=counter(&state->connected),errors=counter(&state->errors);int64_t start=esp_timer_get_time();
    esp_websocket_client_handle_t client=esp_websocket_client_init(&cfg);
    esp_err_t err=client?esp_websocket_register_events(client,WEBSOCKET_EVENT_ANY,ws_event,state):ESP_ERR_NO_MEM;
    if(err==ESP_OK)err=esp_websocket_client_start(client);
    int timeout=remaining_ms(12000);
    while(err==ESP_OK&&counter(&state->connected)==before&&counter(&state->errors)==errors&&
        esp_timer_get_time()-start<(int64_t)timeout*1000)vTaskDelay(pdMS_TO_TICKS(20));
    bool valid=err==ESP_OK&&counter(&state->connected)==before+1&&esp_websocket_client_is_connected(client);
    printf("CF_WS_CONNECT phase=%s valid=%u err=%d elapsed_us=%"PRId64" connects=%u errors=%u "
        "tls_error=%d tls_flags=%d handshake_status=%d free=%u largest=%u\n",phase,valid,err,
        esp_timer_get_time()-start,counter(&state->connected),counter(&state->errors),state->tls_error,
        state->tls_flags,state->handshake_status,(unsigned)heap_caps_get_free_size(HEAP_CAPS),
        (unsigned)heap_caps_get_largest_free_block(HEAP_CAPS));
    if(!valid){failures++;if(client){esp_websocket_client_stop(client);esp_websocket_client_destroy(client);}return NULL;}
    return client;
}
static bool ws_request(esp_websocket_client_handle_t client,ws_state_t *state,size_t bytes,
    const char *phase,unsigned sample,char connection_id[37])
{
    uint32_t seq=++sequence;probe_payload(payload,bytes,run_bytes,seq);char hash[65];digest(bytes,hash);
    unsigned connects=counter(&state->connected),drops=counter(&state->disconnected),errors=counter(&state->errors);
    int64_t start=esp_timer_get_time();int cap=remaining_ms(12000);
    size_t free_start=heap_caps_get_free_size(HEAP_CAPS);
    bool monitor=heap_caps_monitor_local_minimum_free_size_start()==ESP_OK;
    // The SDK applies timeout per frame and lock acquisition. Send explicit
    // <=1024-byte frames, recomputing one eighth of remaining total per call
    // for nested SDK lock, poll and header/payload TLS write timeouts.
    // This prevents eight 12-second waits from masquerading as one 12s send.
    int sent=0;
    while((size_t)sent<bytes){
        int left=cap-(int)((esp_timer_get_time()-start)/1000);if(left<8){sent=-1;break;}
        int chunk=(int)(bytes-sent);if(chunk>1024)chunk=1024;
        int slice=left/8;if(slice>1000)slice=1000;
        int count=sent?esp_websocket_client_send_cont_msg(client,(char*)payload+sent,chunk,pdMS_TO_TICKS(slice)):
            esp_websocket_client_send_bin_partial(client,(char*)payload,chunk,pdMS_TO_TICKS(slice));
        if(count!=chunk){sent=-1;break;}sent+=count;
    }
    if(sent==(int)bytes){int left=cap-(int)((esp_timer_get_time()-start)/1000);int slice=left/8;if(slice>1000)slice=1000;
        if(left<8||esp_websocket_client_send_fin(client,pdMS_TO_TICKS(slice))<0)sent=-1;}
    ws_message_t response={0};
    int left=cap-(int)((esp_timer_get_time()-start)/1000);
    bool received=sent==(int)bytes&&left>0&&xQueueReceive(state->messages,&response,pdMS_TO_TICKS(left))==pdTRUE;
    probe_receipt_t receipt={0};
    bool valid=received&&probe_receipt(response.data,response.length,run_hex,seq,bytes,hash,&receipt)
        &&counter(&state->connected)==connects&&counter(&state->disconnected)==drops
        &&counter(&state->errors)==errors&&counter(&state->invalid)==0&&counter(&state->queue_losses)==0
        &&esp_timer_get_time()-start<=REQUEST_US;
    bool stable=valid&&(!connection_id[0]||strcmp(connection_id,receipt.connection_id)==0);
    valid=valid&&stable;
    size_t minimum=monitor?heap_caps_get_minimum_free_size(HEAP_CAPS):0;
    if(monitor)heap_caps_monitor_local_minimum_free_size_stop();
    printf("CF_WS_MSG phase=%s sample=%u seq=%"PRIu32" bytes=%u sent=%d received=%u valid=%u "
        "stage=%s elapsed_us=%"PRId64" connects=%u disconnected=%u errors=%u queue_losses=%u malformed=%u "
        "free_start=%u free_min=%u free_end=%u largest_end=%u connection_id=%s colo=%s\n",
        phase,sample,seq,(unsigned)bytes,sent,received,valid,sent!=(int)bytes?"send":!received?"receipt_timeout":
        !valid?"receipt":"none",esp_timer_get_time()-start,counter(&state->connected),counter(&state->disconnected),
        counter(&state->errors),counter(&state->queue_losses),counter(&state->invalid),(unsigned)free_start,
        (unsigned)minimum,(unsigned)heap_caps_get_free_size(HEAP_CAPS),(unsigned)heap_caps_get_largest_free_block(HEAP_CAPS),
        valid?receipt.connection_id:"none",valid?receipt.colo:"none");
    if(valid){successes++;strcpy(connection_id,receipt.connection_id);}else failures++;
    return valid;
}
static void ws_phase(void)
{
    ws_state_t state={0};state.messages=xQueueCreate(2,sizeof(ws_message_t));
    if(!state.messages){failures++;return;}
    char connection_id[37]={0};
    esp_websocket_client_handle_t client=ws_connect(&state,"initial");
    if(!client)goto done;
    for(unsigned size=0;size<2;size++)for(unsigned i=0;i<CFG_wsSamples&&available();i++)
        if(!ws_request(client,&state,size?8192:1024,"steady",i,connection_id))goto cleanup;
    {
        unsigned pongs=counter(&state.pongs),drops=counter(&state.disconnected),errors=counter(&state.errors);
        int64_t start=esp_timer_get_time();
        while(available()&&esp_timer_get_time()-start<45000000LL&&esp_websocket_client_is_connected(client))
            vTaskDelay(pdMS_TO_TICKS(100));
        bool idle=esp_timer_get_time()-start>=45000000LL&&esp_websocket_client_is_connected(client)
            &&counter(&state.pongs)>pongs&&counter(&state.disconnected)==drops&&counter(&state.errors)==errors;
        printf("CF_WS_IDLE valid=%u elapsed_us=%"PRId64" pongs=%u disconnected=%u errors=%u\n",idle,
            esp_timer_get_time()-start,counter(&state.pongs)-pongs,counter(&state.disconnected),counter(&state.errors));
        if(!idle){failures++;goto cleanup;}
        if(!ws_request(client,&state,1024,"post_idle",0,connection_id))goto cleanup;
    }
    {
        unsigned before=counter(&state.closed);int cap=remaining_ms(12000);int64_t start=esp_timer_get_time();
        int slice=cap/8;if(slice>1000)slice=1000;
        int sent=slice?esp_websocket_client_send_text(client,"close-for-test",14,pdMS_TO_TICKS(slice)):-1;
        while(available()&&counter(&state.closed)==before&&esp_timer_get_time()-start<REQUEST_US)
            vTaskDelay(pdMS_TO_TICKS(20));
        bool closed=sent==14&&counter(&state.closed)==before+1&&state.close_code==1000;
        printf("CF_WS_FORCED_CLOSE valid=%u sent=%d closed=%u disconnected=%u close_code=%d elapsed_us=%"PRId64"\n",
            closed,sent,counter(&state.closed),counter(&state.disconnected),state.close_code,esp_timer_get_time()-start);
        if(!closed){failures++;goto cleanup;}
    }
    esp_websocket_client_stop(client);esp_websocket_client_destroy(client);client=NULL;
    {
        char old_id[37];strcpy(old_id,connection_id);connection_id[0]=0;
        xQueueReset(state.messages);memset(&state.assembly,0,sizeof(state.assembly));
        client=ws_connect(&state,"explicit_reconnect");
        if(!client)goto done;
        for(unsigned i=0;i<CFG_reconnectSamples&&available();i++){
            if(!ws_request(client,&state,i%2?8192:1024,"reconnected",i,connection_id))break;
            if(strcmp(old_id,connection_id)==0){failures++;printf("CF_WS_RECONNECT_ID valid=0\n");break;}
        }
    }
cleanup:
    if(client){esp_websocket_client_stop(client);esp_websocket_client_destroy(client);}
done:
    printf("CF_WS_SUMMARY connects=%u closed=%u disconnected=%u errors=%u pongs=%u queue_losses=%u malformed=%u\n",
        counter(&state.connected),counter(&state.closed),counter(&state.disconnected),counter(&state.errors),
        counter(&state.pongs),counter(&state.queue_losses),counter(&state.invalid));
    vQueueDelete(state.messages);
}
void app_main(void)
{
    // Suppress third-party URI/header/body diagnostics, including connection errors.
    esp_log_level_set("*",ESP_LOG_NONE);
    int64_t start=esp_timer_get_time();
    // Reserve teardown time inside the configured overall budget.
    end_us=start+(CFG_budgetSeconds-20)*1000000LL;
    printf("CF_START protocol=cp-link-probe/1 build=%s %s budget_seconds=%lld synthetic=1\n",__DATE__,__TIME__,(long long)CFG_budgetSeconds);
    esp_err_t wifi=probe_wifi_start_saved(30000);
    if(wifi!=ESP_OK){failures++;printf("CF_ABORT stage=wifi err=%d\n",wifi);goto done;}
    if(!clock_prepare()){failures++;printf("CF_ABORT stage=clock\n");goto done;}
    esp_fill_random(run_bytes,sizeof(run_bytes));probe_hex(run_bytes,sizeof(run_bytes),run_hex);
    printf("CF_RUN run_id=%s\n",run_hex);
    for(unsigned size=0;size<2&&available();size++){
        http_phase(false,size?8192:1024);http_phase(true,size?8192:1024);
    }
    if(available())ws_phase();
done:
    esp_wifi_stop();
    unsigned expected=2*(CFG_freshSamples+CFG_reuseSamples)+2*CFG_wsSamples+1+CFG_reconnectSamples;
    printf("CF_DONE success=%u expected=%u failed=%u complete=%u budget_exhausted=%u elapsed_us=%"PRId64" free=%u minimum=%u\n",
        successes,expected,failures,successes==expected&&!failures,!available(),esp_timer_get_time()-start,(unsigned)heap_caps_get_free_size(HEAP_CAPS),
        (unsigned)heap_caps_get_minimum_free_size(HEAP_CAPS));
}
