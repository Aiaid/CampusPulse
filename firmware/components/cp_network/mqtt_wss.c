#include "mqtt_wss.h"
#if CONFIG_CP_NETWORK_MQTT_WSS
#include "mqtt_rpc.h"
#include "mqtt_client.h"
#include "esp_crt_bundle.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_timer.h"
#if !CONFIG_CP_NETWORK_MQTT_NATIVE_TLS
#include "esp_transport_ws.h"
#endif
#include "esp_transport_ssl.h"
#include "esp_transport.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include <stdlib.h>
#include <string.h>

/* The owner holds network.c's memory gate through start, RPC and confirmed
 * cleanup. SDK auto-reconnect is disabled: background work can never start a
 * second TLS handshake while the collector encoder owns that gate. */
static cp_mqtt_lease_t s_lease;
static portMUX_TYPE s_mux=portMUX_INITIALIZER_UNLOCKED;
static struct {
    cp_mqtt_rpc_t rpc;
    bool connected,error;
    int suback,suback_qos,tls_error,tls_flags,socket_error;
    esp_err_t transport_error;
    uint64_t connected_ms;
    uint32_t callback_stack_min;
#if !CONFIG_CP_NETWORK_MQTT_NATIVE_TLS
    char headers[CP_SETTINGS_TOKEN_SIZE+32u];
#endif
    char subscription[CP_MQTT_TOPIC_CAP];
    char client_id[54];
} s;
static uint32_t s_rpc_sequence;
static size_t s_upload_body_bytes;
static uint64_t s_last_admission_log;
static uint32_t s_admission_denials;
static StaticSemaphore_t s_signal_storage;
static SemaphoreHandle_t s_signal;
/* Separate from network.c's owner gate: that gate remains held while an RPC
 * waits for callbacks, so the MQTT task must never acquire it. Lock order is
 * owner gate -> SDK API (released) -> IO gate; while owning IO, memory work
 * calls no SDK API, including the locking get_outbox_size(). */
static StaticSemaphore_t s_io_storage;
static SemaphoreHandle_t s_io;
static esp_transport_handle_t s_tls;
static bool s_memory_work;
static bool io_init(void)
{if(!s_io)s_io=xSemaphoreCreateMutexStatic(&s_io_storage);return s_io!=NULL;}
int __real_esp_transport_read(esp_transport_handle_t,char *,int,int);
int __real_esp_transport_write(esp_transport_handle_t,const char *,int,int);
int __wrap_esp_transport_read(esp_transport_handle_t transport,char *buffer,int length,int timeout_ms)
{
    if(transport!=__atomic_load_n(&s_tls,__ATOMIC_ACQUIRE)||!transport)
        return __real_esp_transport_read(transport,buffer,length,timeout_ms);
    /* ssl_read itself polls before allocation. Wait outside our gate, retaining
     * the cold WebSocket HTTP-upgrade read timeout. MQTT's idle reads pass zero;
     * partial TLS records retain the SDK socket timeout after this poll. */
    int readable=esp_transport_poll_read(transport,0);
    if(!readable&&timeout_ms!=0)readable=esp_transport_poll_read(transport,timeout_ms);
    if(readable<=0)return readable<0?ERR_TCP_TRANSPORT_CONNECTION_FAILED:0;
    if(!s_io||xSemaphoreTake(s_io,portMAX_DELAY)!=pdTRUE)return ERR_TCP_TRANSPORT_NO_MEM;
    int result=__real_esp_transport_read(transport,buffer,length,timeout_ms);
    xSemaphoreGive(s_io);return result;
}
int __wrap_esp_transport_write(esp_transport_handle_t transport,const char *buffer,int length,int timeout_ms)
{
    if(transport!=__atomic_load_n(&s_tls,__ATOMIC_ACQUIRE)||!transport)
        return __real_esp_transport_write(transport,buffer,length,timeout_ms);
    if(!s_io||xSemaphoreTake(s_io,portMAX_DELAY)!=pdTRUE)return ERR_TCP_TRANSPORT_NO_MEM;
    int result=__real_esp_transport_write(transport,buffer,length,timeout_ms);
    xSemaphoreGive(s_io);return result;
}
/* Permanent callback and stop-job storage is intentional. A timed-out stop
 * worker may still access the client; no stack userdata or caller body escapes. */
static struct { void *client;esp_err_t result;unsigned done;bool pending; } s_stop;
static uint64_t mono_ms(void){return (uint64_t)esp_timer_get_time()/1000u;}
static void take(void){portENTER_CRITICAL(&s_mux);}
static void give(void){portEXIT_CRITICAL(&s_mux);}
static size_t free_internal(void){return heap_caps_get_free_size(MALLOC_CAP_INTERNAL|MALLOC_CAP_8BIT);}
static size_t largest_internal(void){return heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL|MALLOC_CAP_8BIT);}
static void admission_denied(unsigned phase)
{
    if(s_admission_denials<UINT32_MAX)++s_admission_denials;
    uint64_t now=mono_ms();
    if(s_admission_denials==1||now-s_last_admission_log>=1000u){
        s_last_admission_log=now;
        ESP_LOGW("cp_mqtt","admission phase=%u denials=%lu free=%u largest=%u retained=%u",
            phase,(unsigned long)s_admission_denials,(unsigned)free_internal(),
            (unsigned)largest_internal(),(unsigned)s_lease.retained);
    }
}
static void wake(void){if(s_signal)xSemaphoreGive(s_signal);}
static void wait_event(void){if(s_signal)xSemaphoreTake(s_signal,pdMS_TO_TICKS(20));else vTaskDelay(pdMS_TO_TICKS(20));}
static bool healthy(void){take();bool ok=s.connected&&!s.error;give();return ok;}
static void event(void *context,esp_event_base_t base,int32_t id,void *data)
{
    (void)context;(void)base;esp_mqtt_event_handle_t e=data;
    if(!e)return;
    /* Explicit bounded cold-start exception: IDF creates transport inside its
     * task, immediately before this event. get_transport does not lock; only
     * WSS's header setter makes one <=225-byte strdup. Native TLS never reads
     * the Cloudflare token or accesses a WebSocket transport. The owner holds the memory gate
     * and cannot leave it until stop is confirmed (or admissions fail closed).
     * No DATA/ACK callback allocates, parses JSON, accesses Flash or blocks. */
    if(id==MQTT_EVENT_BEFORE_CONNECT) {
#if CONFIG_CP_NETWORK_MQTT_NATIVE_TLS
        esp_err_t result=ESP_OK;
#else
        esp_transport_handle_t ws=esp_mqtt_client_get_transport(e->client,"wss");
        esp_err_t result=ws?esp_transport_ws_set_headers(ws,s.headers):ESP_ERR_INVALID_STATE;
#endif
        esp_transport_handle_t tls=esp_mqtt_client_get_transport(e->client,MQTT_OVER_SSL_SCHEME);
        if(!tls)result=ESP_ERR_INVALID_STATE;
        /* Leave the SDK dynamic RX default intact. Only this private parent is
         * interposed; HTTP, provisioning and every other transport pass through. */
        else __atomic_store_n(&s_tls,tls,__ATOMIC_RELEASE);
        if(result!=ESP_OK){take();s.error=true;s.transport_error=result;give();wake();}
        return;
    }
    uint32_t watermark=(uint32_t)uxTaskGetStackHighWaterMark(NULL);
    take();
    if(!s.callback_stack_min||watermark<s.callback_stack_min)s.callback_stack_min=watermark;
    switch(id) {
    case MQTT_EVENT_CONNECTED:s.connected=true;s.connected_ms=mono_ms();break;
    case MQTT_EVENT_DISCONNECTED:s.connected=false;s.error=true;cp_mqtt_rpc_fail(&s.rpc);break;
    case MQTT_EVENT_ERROR:
        s.error=true;cp_mqtt_rpc_fail(&s.rpc);
        if(e->error_handle){s.transport_error=e->error_handle->esp_tls_last_esp_err;
            s.tls_error=e->error_handle->esp_tls_stack_err;
            s.tls_flags=e->error_handle->esp_tls_cert_verify_flags;
            s.socket_error=e->error_handle->esp_transport_sock_errno;}
        break;
    case MQTT_EVENT_SUBSCRIBED:
        s.suback=e->msg_id;s.suback_qos=e->data&&e->data_len==1?(unsigned char)e->data[0]:-1;
        if(s.suback_qos!=0)s.error=true;
        break;
    case MQTT_EVENT_PUBLISHED:cp_mqtt_rpc_puback(&s.rpc,e->msg_id);break;
    case MQTT_EVENT_DATA:
        cp_mqtt_rpc_data(&s.rpc,e->topic,e->topic_len,e->data,e->data_len,
            e->current_data_offset,e->total_data_len,e->qos,e->retain);
        break;
    default:break;
    }
    give();wake();
}
static void stop_task(void *unused)
{
    (void)unused;s_stop.result=esp_mqtt_client_stop(s_stop.client);
    __atomic_store_n(&s_stop.done,1u,__ATOMIC_RELEASE);vTaskDelete(NULL);
}
static int stop_confirm(void *client)
{
    if(s_stop.pending)return ESP_ERR_INVALID_STATE;
    s_stop.client=client;s_stop.result=ESP_FAIL;s_stop.pending=true;
    __atomic_store_n(&s_stop.done,0u,__ATOMIC_RELEASE);
    /* Never call the pinned SDK's potentially unbounded stop on the caller.
     * The helper priority cannot starve the owner timeout if SDK spins. */
    if(xTaskCreate(stop_task,"cp_mq_stop",4096,NULL,tskIDLE_PRIORITY,NULL)!=pdPASS) {
        s_stop.pending=false;return ESP_ERR_NO_MEM;
    }
    uint64_t deadline=mono_ms()+10000u;
    while(!__atomic_load_n(&s_stop.done,__ATOMIC_ACQUIRE)&&mono_ms()<deadline)
        vTaskDelay(pdMS_TO_TICKS(10));
    if(!__atomic_load_n(&s_stop.done,__ATOMIC_ACQUIRE))return ESP_ERR_TIMEOUT;
    s_stop.pending=false;return s_stop.result;
}
static int destroy_client(void *client){return esp_mqtt_client_destroy(client);}
esp_err_t cp_mqtt_wss_stop(void)
{
    if(s_memory_work)return ESP_ERR_INVALID_STATE;
    take();cp_mqtt_rpc_cancel(&s.rpc);give();
    /* A late successful stop may safely complete a prior retained lease. Never
     * retry or destroy after an explicit SDK stop failure. */
    if(s_lease.retained&&s_stop.pending&&__atomic_load_n(&s_stop.done,__ATOMIC_ACQUIRE)&&
       s_stop.result==ESP_OK){s_stop.pending=false;s_lease.started=false;s_lease.retained=false;}
    const cp_mqtt_lease_ops_t ops={stop_confirm,destroy_client};
    int result=cp_mqtt_lease_release(&s_lease,&ops);
    if(!result){__atomic_store_n(&s_tls,NULL,__ATOMIC_RELEASE);take();memset(&s,0,sizeof(s));give();}
    if(result)ESP_LOGW("cp_mqtt","stop error=%d retained=1",result);
    return result==0?ESP_OK:result<0?ESP_FAIL:(esp_err_t)result;
}
bool cp_mqtt_wss_established(void){return s_lease.client&&!s_lease.retained&&healthy();}
static bool late_stop_succeeded(void)
{
    return s_lease.retained&&s_stop.pending&&
        __atomic_load_n(&s_stop.done,__ATOMIC_ACQUIRE)&&s_stop.result==ESP_OK;
}
bool cp_mqtt_wss_memory_safe(void)
{
    if(s_memory_work)return false; /* Never take SDK API lock while owning IO. */
    /* Owner holds the transport gate. A completed stop need not emit a
     * DISCONNECTED event, so the callback's healthy bit can remain stale. */
    if(late_stop_succeeded()&&cp_mqtt_wss_stop()!=ESP_OK)return false;
    if(s_lease.retained)return false;
    if(s_lease.client&&!healthy()&&cp_mqtt_wss_stop()!=ESP_OK)return false;
    /* Request owner never returns with an outstanding outbox unless cleanup
     * failed. This additionally rejects any unexpected SDK backlog. */
    return !s_lease.client||esp_mqtt_client_get_outbox_size(s_lease.client)==0;
}
static bool begin_memory(uint32_t timeout_ms)
{
    if(s_memory_work||!cp_mqtt_wss_memory_safe()||!io_init()||
       xSemaphoreTake(s_io,pdMS_TO_TICKS(timeout_ms))!=pdTRUE)return false;
    /* No SDK calls below: background read/write may own SDK API while waiting
     * for this gate. Owner gate excludes another publisher/reconnect/stop;
     * auto-reconnect is disabled and the checked outbox was empty. */
    s_memory_work=true;
    if(s_lease.retained||(s_lease.client&&!healthy())){cp_mqtt_wss_end_memory_work();return false;}
    return true;
}
void cp_mqtt_wss_end_memory_work(void)
{if(s_memory_work){s_memory_work=false;xSemaphoreGive(s_io);}}
bool cp_mqtt_wss_encode_ready(uint32_t timeout_ms)
{
    /* The incremental address codec retains one <=8197-byte body plus only
     * one bounded item's JSON tree/string. Host allocation tests cover 16 bins
     * below the existing 14 KiB temporary-JSON budget; allocator/runtime costs
     * and physical acceptance remain separate. Retain the existing 10 KiB
     * reserve for other runtime work. RX/TX cannot
     * allocate while this gate is held; already cached TLS bytes are included
     * in the fresh heap sample. Largest >=14 KiB preserves the existing floor.
     * This admission estimate is
     * separate from physical acceptance and does not force per-window TLS drops. */
    if(!begin_memory(timeout_ms)){admission_denied(3);return false;}
    bool ready=!s_lease.client||
        (free_internal()>=24u*1024u&&largest_internal()>=14u*1024u);
    if(!ready){cp_mqtt_wss_end_memory_work();admission_denied(3);}
    return ready;
}
bool cp_mqtt_wss_allocation_ready(size_t bytes,uint32_t timeout_ms)
{
    if(!begin_memory(timeout_ms)){admission_denied(4);return false;}
    bool ready=!s_lease.client||cp_mqtt_allocation_budget(free_internal(),largest_internal(),bytes);
    if(ready)s_upload_body_bytes=bytes?bytes-1u:0u;
    else {cp_mqtt_wss_end_memory_work();admission_denied(4);}
    return ready;
}
bool cp_mqtt_wss_upload_ready(bool allocated)
{
    bool ready=s_memory_work&&allocated&&!s_lease.retained&&(!s_lease.client||
        (healthy()&&cp_mqtt_hot_budget(free_internal(),largest_internal(),s_upload_body_bytes)));
    if(!ready)admission_denied(5);
    return ready;
}
void cp_mqtt_wss_idle(bool usable)
{if(late_stop_succeeded()||(s_lease.client&&(!usable||!healthy())))(void)cp_mqtt_wss_stop();}
static bool error_seen(void){take();bool result=s.error;give();return result;}
static esp_err_t connect_client(const cp_settings_t *settings,const char *node,const char *boot,
    bool (*active)(void))
{
    if(cp_mqtt_wss_established())return ESP_OK;
    esp_err_t result=cp_mqtt_wss_stop();if(result!=ESP_OK)return result;
    uint64_t connect_started=mono_ms();size_t free_before=free_internal(),largest_before=largest_internal();
    if(!cp_mqtt_cold_budget(free_internal(),largest_internal())){admission_denied(1);return ESP_ERR_NO_MEM;}
#if CONFIG_CP_NETWORK_MQTT_NATIVE_TLS
    if(!cp_settings_mqtt_ready(settings))return ESP_ERR_INVALID_ARG;
#else
    if(!cp_mqtt_uri_valid(CONFIG_CP_NETWORK_MQTT_WSS_URI))return ESP_ERR_INVALID_ARG;
#endif
    if(!io_init())return ESP_ERR_NO_MEM;
    if(!s_signal)s_signal=xSemaphoreCreateBinaryStatic(&s_signal_storage);
    if(!s_signal)return ESP_ERR_NO_MEM;
    while(xSemaphoreTake(s_signal,0)==pdTRUE){}
    snprintf(s.client_id,sizeof(s.client_id),"%s:%s",node,boot);
    const char *topic_namespace=node;
#if CONFIG_CP_NETWORK_MQTT_NATIVE_TLS
    topic_namespace=settings->mqtt_namespace;
#endif
    snprintf(s.subscription,sizeof(s.subscription),"cp/v1/%s/%s/rep/+/+",topic_namespace,boot);
#if !CONFIG_CP_NETWORK_MQTT_NATIVE_TLS
    snprintf(s.headers,sizeof(s.headers),"Authorization: Bearer %s\r\n",settings->device_token);
    /* IDF transport_ws logs its entire Authorization-bearing request on write
     * failure even at ERROR. Suppress only that vendor tag. Own logs below are
     * bounded numeric evidence. Never log URI, topics, headers or payloads. */
    esp_log_level_set("transport_ws",ESP_LOG_NONE);
#endif
    /* Pinned IDF 5.5.3's MQTT 3.1.1 encoder does not log CONNECT credentials.
     * Its URI parse error can log the URI, so only the validated credential-free
     * authority reaches init. Own logs remain numeric, including auth failures. */
    esp_mqtt_client_config_t config={
#if CONFIG_CP_NETWORK_MQTT_NATIVE_TLS
        .broker={.address.uri=settings->mqtt_uri,
            .verification={.crt_bundle_attach=esp_crt_bundle_attach,.skip_cert_common_name_check=false}},
        .credentials={.client_id=s.client_id,.username=settings->mqtt_username,
            .authentication.password=settings->mqtt_password},
#else
        .broker={.address.uri=CONFIG_CP_NETWORK_MQTT_WSS_URI,
            .verification={.crt_bundle_attach=esp_crt_bundle_attach,.skip_cert_common_name_check=false}},
        .credentials={.client_id=s.client_id,.username=node},
#endif
        .session={.protocol_ver=MQTT_PROTOCOL_V_3_1_1,.keepalive=60,
            .disable_clean_session=false,.message_retransmit_timeout=60000},
        /* Preserve the existing public-path cold-connect budget. Three seconds
         * also capped TLS and the authenticated HTTP upgrade, before a reusable
         * session existed. The owner still bounds its own wait and stop. */
        .network={.disable_auto_reconnect=true,.timeout_ms=12000,.refresh_connection_after_ms=0},
        .task={.stack_size=CP_MQTT_TASK_STACK,.priority=4},
        .buffer={.size=CP_MQTT_IO_BUFFER,.out_size=CP_MQTT_IO_BUFFER},
        .outbox.limit=CP_MQTT_OUTBOX_LIMIT,
    };
    s_lease.client=esp_mqtt_client_init(&config);
    if(!s_lease.client){
#if !CONFIG_CP_NETWORK_MQTT_NATIVE_TLS
        memset(s.headers,0,sizeof(s.headers));
#endif
        return ESP_ERR_NO_MEM;
    }
    result=esp_mqtt_client_register_event(s_lease.client,ESP_EVENT_ANY_ID,event,NULL);
    if(result==ESP_OK){result=esp_mqtt_client_start(s_lease.client);s_lease.started=result==ESP_OK;}
    uint64_t deadline=mono_ms()+12000u;
    while(result==ESP_OK&&!healthy()&&!error_seen()&&active()&&mono_ms()<deadline)wait_event();
    if(result==ESP_OK&&!active())result=ESP_ERR_INVALID_STATE;
    if(result==ESP_OK&&!healthy())result=error_seen()?ESP_FAIL:ESP_ERR_TIMEOUT;
    if(result==ESP_OK) {
        int subscription=esp_mqtt_client_subscribe(s_lease.client,s.subscription,0);
        if(subscription<=0)result=ESP_FAIL;
        while(result==ESP_OK&&healthy()&&active()&&mono_ms()<deadline){
            take();bool subscribed=s.suback==subscription&&s.suback_qos==0;give();
            if(subscribed)break;
            wait_event();
        }
        take();bool subscribed=s.suback==subscription&&s.suback_qos==0;give();
        if(result==ESP_OK&&(!subscribed||!healthy()||!active()))result=ESP_ERR_TIMEOUT;
        if(result==ESP_OK&&esp_mqtt_client_get_outbox_size(s_lease.client)!=0)result=ESP_ERR_INVALID_STATE;
    }
    take();int tls_error=s.tls_error,tls_flags=s.tls_flags,socket_error=s.socket_error;
    uint32_t stack_min=s.callback_stack_min;give();
    int upgrade_status=0;
#if !CONFIG_CP_NETWORK_MQTT_NATIVE_TLS
    esp_transport_handle_t ws=esp_mqtt_client_get_transport(s_lease.client,"wss");
    upgrade_status=ws?esp_transport_ws_get_upgrade_request_status(ws):0;
#endif
    ESP_LOGI("cp_mqtt","session error=%d elapsed_ms=%llu free_before=%u largest_before=%u free_after=%u largest_after=%u tls=%d flags=%d errno=%d upgrade_http=%d callback_stack_min=%lu rx_static=0 io_gate=1 task_stack=%u io_each=%u outbox_limit=%u",
        result,(unsigned long long)(mono_ms()-connect_started),(unsigned)free_before,(unsigned)largest_before,
        (unsigned)free_internal(),(unsigned)largest_internal(),tls_error,tls_flags,socket_error,upgrade_status,
        (unsigned long)stack_min,CP_MQTT_TASK_STACK,CP_MQTT_IO_BUFFER,CP_MQTT_OUTBOX_LIMIT);
    if(result!=ESP_OK){
        take();if(s.transport_error==ESP_ERR_NO_MEM)result=ESP_ERR_NO_MEM;give();
        esp_err_t cleanup=cp_mqtt_wss_stop();if(cleanup!=ESP_OK)result=cleanup;
    }
    return result;
}
esp_err_t cp_mqtt_wss_request(const cp_settings_t *settings,const char *node,const char *boot,
    const char *op,const char *body,size_t length,cp_http_response_t *response,int *status,
    bool (*active)(void))
{
    if(s_memory_work)return ESP_ERR_INVALID_STATE;
    if(!settings||!node||!boot||!op||!response||!status||!active||length>CP_MQTT_BODY_MAX||
       (length&&!body))return ESP_ERR_INVALID_ARG;
    *status=0;uint64_t started=mono_ms();bool reused=cp_mqtt_wss_established();
    esp_err_t result=connect_client(settings,node,boot,active);
    if(result!=ESP_OK)return result;
    if(!cp_mqtt_hot_budget(free_internal(),largest_internal(),length)){admission_denied(2);return ESP_ERR_NO_MEM;}
    if(s_rpc_sequence==UINT32_MAX)return ESP_ERR_INVALID_STATE;
    uint32_t sequence=++s_rpc_sequence;
    char topic[CP_MQTT_TOPIC_CAP],reply_topic[CP_MQTT_TOPIC_CAP];
    const char *topic_namespace=node;
#if CONFIG_CP_NETWORK_MQTT_NATIVE_TLS
    topic_namespace=settings->mqtt_namespace;
#endif
    int n=snprintf(topic,sizeof(topic),"cp/v1/%s/%s/req/%s/%lu",topic_namespace,boot,op,(unsigned long)sequence);
    int r=snprintf(reply_topic,sizeof(reply_topic),"cp/v1/%s/%s/rep/%s/%lu",topic_namespace,boot,op,(unsigned long)sequence);
    if(n<0||(size_t)n>=sizeof(topic)||r<0||(size_t)r>=sizeof(reply_topic))return ESP_ERR_INVALID_SIZE;
    take();bool begun=cp_mqtt_rpc_begin(&s.rpc,reply_topic);give();
    if(!begun)return ESP_ERR_INVALID_STATE;
    uint64_t deadline=mono_ms()+20000u;
    /* publish copies the entire QoS1 message into SDK-owned outbox storage
     * before returning. Subsequent fragments also read caller bytes only inside
     * this call. Neither our callback nor SDK retains caller body afterwards. */
    uint64_t publish_at=mono_ms();
    int id=esp_mqtt_client_publish(s_lease.client,topic,length?body:NULL,(int)length,1,0);
    uint32_t publish_ms=(uint32_t)(mono_ms()-publish_at);
    take();cp_mqtt_rpc_publish_id(&s.rpc,id);give();
    size_t outbox=0;bool done=false;
    while(active()&&mono_ms()<deadline){
        outbox=(size_t)esp_mqtt_client_get_outbox_size(s_lease.client);
        take();done=cp_mqtt_rpc_done(&s.rpc,outbox);bool failed=s.rpc.failed;give();
        if(done||failed||!healthy())break;
        wait_event();
    }
    if(!done)result=!active()?ESP_ERR_INVALID_STATE:id<=0?ESP_FAIL:ESP_ERR_TIMEOUT;
    if(done) {
        /* A second owned copy lets cancellation/reset happen without exposing
         * callback storage to the protocol parser. Bounded malloc runs in owner. */
        take();size_t bytes=s.rpc.total-2u;give();
        char *copy=malloc(bytes+1u);
        if(!copy)result=ESP_ERR_NO_MEM;
        else {
            take();memcpy(copy,s.rpc.reply+2u,bytes);copy[bytes]=0;
            *status=((unsigned)s.rpc.reply[0]<<8)|s.rpc.reply[1];
            response->connected_ms=s.connected_ms;give();
            response->body=copy;response->used=bytes;response->capacity=bytes+1u;
            response->connected_seen=response->response_seen=true;
            response->connect_events=reused?0:1;response->first_response_ms=mono_ms();
        }
    }
    take();cp_mqtt_rpc_cancel(&s.rpc);int tls=s.tls_error,flags=s.tls_flags,sock=s.socket_error;
    uint32_t stack=s.callback_stack_min;give();
    /* Missing app reply after a valid PUBACK is not a reason to discard TLS.
     * Cancel only correlation; next RPC gets a new id and same frozen body.
     * Unacknowledged SDK-owned QoS1 data must be cleared by confirmed stop before
     * the encoder can allocate. No second outbox record may accumulate. */
    outbox=(size_t)esp_mqtt_client_get_outbox_size(s_lease.client);
    if(!healthy()||outbox!=0||!active()) {
        esp_err_t cleanup=cp_mqtt_wss_stop();if(cleanup!=ESP_OK)result=cleanup;
    }
    ESP_LOGI("cp_mqtt","rpc reused=%u error=%d status=%d body_bytes=%u reply_bytes=%u publish_ms=%lu total_ms=%llu outbox=%u tls=%d flags=%d errno=%d free=%u largest=%u callback_stack_min=%lu retained=%u",
        (unsigned)reused,result,*status,(unsigned)length,(unsigned)response->used,(unsigned long)publish_ms,
        (unsigned long long)(mono_ms()-started),(unsigned)outbox,tls,flags,sock,(unsigned)free_internal(),
        (unsigned)largest_internal(),(unsigned long)stack,(unsigned)s_lease.retained);
    return result;
}
#endif
