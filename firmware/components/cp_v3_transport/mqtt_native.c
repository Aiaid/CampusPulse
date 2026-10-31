/* Native V3 transport only. Reuses the repository's bounded MQTT callback,
 * RPC correlation, admission and confirmed-stop design; no cp_network owner. */
#include "mqtt_native.h"
#include "mqtt_protocol.h"
#include "mqtt_rpc.h"
#include "mqtt_client.h"
#include "esp_crt_bundle.h"
#include "esp_heap_caps.h"
#include "esp_timer.h"
#include "esp_log.h"
#include "esp_transport.h"
#include "esp_transport_ssl.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include <string.h>

typedef struct {
    cp_v3_mqtt_rpc_t rpc;
    cp_settings_t settings;
    uint8_t frame[CP_V3_MQTT_FRAME_MAX];
    char boot[37],client_id[54],subscription[CP_V3_MQTT_TOPIC_BYTES];
    bool configured,connected,subscribed,error;
    int suback,suback_qos,tls_esp,tls_stack,tls_flags,socket_error,connect_code;
    uint32_t timeout,callback_stack_min;
} mqtt_state_t;
static mqtt_state_t *s;
static cp_mqtt_lease_t lease;
static cp_v3_mqtt_identity_t identity;
static portMUX_TYPE mux=portMUX_INITIALIZER_UNLOCKED;
static StaticSemaphore_t signal_storage;
static SemaphoreHandle_t s_signal;
static StaticSemaphore_t io_storage;
static SemaphoreHandle_t io;
static bool memory_work;
static esp_transport_handle_t tls_transport;
static struct {void *client;esp_err_t result;unsigned done;bool pending;} stop_job;
static uint64_t now(void){return (uint64_t)esp_timer_get_time()/1000u;}
static void take(void){portENTER_CRITICAL(&mux);}
static void give(void){portEXIT_CRITICAL(&mux);}
static void wake(void){if(s_signal)xSemaphoreGive(s_signal);}
static void wait_event(void){xSemaphoreTake(s_signal,pdMS_TO_TICKS(20));}
static bool healthy(void){take();bool okay=s&&s->connected&&!s->error;give();return okay;}
int __real_esp_transport_read(esp_transport_handle_t,char *,int,int);
int __real_esp_transport_write(esp_transport_handle_t,const char *,int,int);
int __wrap_esp_transport_read(esp_transport_handle_t transport,char *buffer,int bytes,int timeout){
    if(!transport||transport!=__atomic_load_n(&tls_transport,__ATOMIC_ACQUIRE))return __real_esp_transport_read(transport,buffer,bytes,timeout);
    int ready=esp_transport_poll_read(transport,0);
    if(!ready&&timeout)ready=esp_transport_poll_read(transport,timeout);
    if(ready<=0)return ready<0?ERR_TCP_TRANSPORT_CONNECTION_FAILED:0;
    if(!io||xSemaphoreTake(io,portMAX_DELAY)!=pdTRUE)return ERR_TCP_TRANSPORT_NO_MEM;
    int result=__real_esp_transport_read(transport,buffer,bytes,timeout);xSemaphoreGive(io);return result;
}
int __wrap_esp_transport_write(esp_transport_handle_t transport,const char *buffer,int bytes,int timeout){
    if(!transport||transport!=__atomic_load_n(&tls_transport,__ATOMIC_ACQUIRE))return __real_esp_transport_write(transport,buffer,bytes,timeout);
    if(!io||xSemaphoreTake(io,portMAX_DELAY)!=pdTRUE)return ERR_TCP_TRANSPORT_NO_MEM;
    int result=__real_esp_transport_write(transport,buffer,bytes,timeout);xSemaphoreGive(io);return result;
}
static void phase(unsigned id){
    ESP_LOGI("cp_v3_mqtt","phase=%u internal=%u largest=%u psram=%u psram_largest=%u state_bytes=%u task_stack=%u io_each=%u retained=%u",id,
        (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL|MALLOC_CAP_8BIT),(unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL|MALLOC_CAP_8BIT),
        (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT),(unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT),
        (unsigned)sizeof(mqtt_state_t),CP_MQTT_TASK_STACK,CP_MQTT_IO_BUFFER,lease.retained);
}
static bool memory(bool cold,size_t frame){
    size_t internal=heap_caps_get_free_size(MALLOC_CAP_INTERNAL|MALLOC_CAP_8BIT),largest=heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL|MALLOC_CAP_8BIT);
    /* External state/reply/frame are already charged in these fresh samples.
     * TLS buffers/outbox use PSRAM on the S3 profile; do not remove internal
     * cold/hot floors or treat this admission snapshot as hardware acceptance. */
    return (cold?cp_mqtt_cold_budget(internal,largest):
        internal>=CP_MQTT_HOT_RESERVE+frame+CP_MQTT_PACKET_ALLOWANCE&&largest>=CP_MQTT_HOT_LARGEST)&&
        heap_caps_get_free_size(MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT)>=512u*1024&&
        heap_caps_get_largest_free_block(MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT)>=128u*1024;
}
static void event(void *context,esp_event_base_t base,int32_t id,void *data){
    (void)context;(void)base;esp_mqtt_event_handle_t e=data;if(!s||!e||e->client!=lease.client)return;
    /* Bounded copies/scalar accounting plus s_signal only. No JSON, heap, Flash,
     * SDK network call or blocking lock is reachable from this callback. */
    /* Callback stack watermark stays unknown (0); do not add a stack scan or
     * any other SDK work to this copy/signal-only path. */
    take();
    switch(id){
    case MQTT_EVENT_CONNECTED:s->connected=true;break;
    case MQTT_EVENT_DISCONNECTED:s->connected=s->subscribed=false;s->error=true;s->rpc.failed=s->rpc.active;break;
    case MQTT_EVENT_ERROR:
        s->error=true;s->rpc.failed=s->rpc.active;
        if(e->error_handle){s->tls_esp=e->error_handle->esp_tls_last_esp_err;s->tls_stack=e->error_handle->esp_tls_stack_err;
            s->tls_flags=e->error_handle->esp_tls_cert_verify_flags;s->socket_error=e->error_handle->esp_transport_sock_errno;
            s->connect_code=e->error_handle->error_type==MQTT_ERROR_TYPE_CONNECTION_REFUSED?e->error_handle->connect_return_code:0;}
        break;
    case MQTT_EVENT_SUBSCRIBED:s->suback=e->msg_id;s->suback_qos=e->data&&e->data_len==1?(unsigned char)e->data[0]:-1;s->subscribed=s->suback_qos==0;if(!s->subscribed)s->error=true;break;
    case MQTT_EVENT_PUBLISHED:cp_v3_mqtt_puback(&s->rpc,e->msg_id);break;
    case MQTT_EVENT_DATA:cp_v3_mqtt_data(&s->rpc,e->topic,e->topic_len,e->data,e->data_len,e->current_data_offset,e->total_data_len,e->qos,e->retain);break;
    default:break;
    }
    give();wake();
}
static void stop_task(void *unused){(void)unused;stop_job.result=esp_mqtt_client_stop(stop_job.client);__atomic_store_n(&stop_job.done,1u,__ATOMIC_RELEASE);vTaskDelete(NULL);}
static int stop_confirm(void *client){
    if(stop_job.pending)return ESP_ERR_INVALID_STATE;
    stop_job.client=client;stop_job.result=ESP_FAIL;stop_job.pending=true;__atomic_store_n(&stop_job.done,0u,__ATOMIC_RELEASE);
    if(xTaskCreate(stop_task,"v3_mq_stop",4096,NULL,tskIDLE_PRIORITY,NULL)!=pdPASS){stop_job.pending=false;return ESP_ERR_NO_MEM;}
    uint64_t deadline=now()+10000;
    while(!__atomic_load_n(&stop_job.done,__ATOMIC_ACQUIRE)&&now()<deadline)vTaskDelay(pdMS_TO_TICKS(10));
    if(!__atomic_load_n(&stop_job.done,__ATOMIC_ACQUIRE))return ESP_ERR_TIMEOUT;
    stop_job.pending=false;return stop_job.result;
}
static int destroy(void *client){return esp_mqtt_client_destroy(client);}
esp_err_t cp_v3_mqtt_stop(void){
    if(memory_work)return ESP_ERR_INVALID_STATE;
    if(s){take();s->rpc.active=s->rpc.assembling=false;give();}
    if(lease.retained&&stop_job.pending&&__atomic_load_n(&stop_job.done,__ATOMIC_ACQUIRE)&&stop_job.result==ESP_OK){
        stop_job.pending=false;lease.started=lease.retained=false;
    }
    const cp_mqtt_lease_ops_t ops={stop_confirm,destroy};int result=cp_mqtt_lease_release(&lease,&ops);
    if(!result&&s){__atomic_store_n(&tls_transport,NULL,__ATOMIC_RELEASE);take();s->connected=s->subscribed=false;s->error=false;memset(&s->rpc,0,sizeof s->rpc);give();}
    return result==0?ESP_OK:result<0?ESP_FAIL:(esp_err_t)result;
}
void cp_v3_mqtt_clear(void){
    if(lease.client||lease.retained||stop_job.pending||!s)return;
    volatile uint8_t *p=(volatile uint8_t *)s;for(size_t i=0;i<sizeof *s;i++)p[i]=0;
}
esp_err_t cp_v3_mqtt_begin_memory(uint32_t timeout,cp_v3_transport_memory_t *phase_out){
    if(!phase_out||!s||memory_work||lease.retained||timeout>10000)return ESP_ERR_INVALID_STATE;
    if(lease.client&&(!healthy()||!s->subscribed||esp_mqtt_client_get_outbox_size(lease.client)!=0))return ESP_ERR_INVALID_STATE;
    if(!io||xSemaphoreTake(io,pdMS_TO_TICKS(timeout))!=pdTRUE)return ESP_ERR_TIMEOUT;
    /* Below this point no MQTT SDK API may be called until end_memory. */
    if(lease.retained||(lease.client&&!healthy())){xSemaphoreGive(io);return ESP_ERR_INVALID_STATE;}
    memory_work=true;bool hot=lease.client!=NULL;
    *phase_out=(cp_v3_transport_memory_t){hot,hot?CP_MQTT_HOT_RESERVE+CP_V3_MQTT_FRAME_MAX+CP_MQTT_PACKET_ALLOWANCE:CP_MQTT_COLD_FREE,
        hot?CP_MQTT_HOT_LARGEST:CP_MQTT_COLD_LARGEST,sizeof(mqtt_state_t)};
    phase(5);return ESP_OK;
}
void cp_v3_mqtt_end_memory(void){if(memory_work){phase(6);memory_work=false;xSemaphoreGive(io);}}
esp_err_t cp_v3_mqtt_configure(const cp_settings_t *settings,const char *boot,uint32_t timeout){
    if(!settings||!boot||!cp_settings_mqtt_ready(settings)||strcmp(settings->mqtt_uri,CP_MQTT_PRODUCTION_URI)||
       !cp_mqtt_native_uri_valid(settings->mqtt_uri)||!cp_v3_mqtt_boot_valid(boot)||timeout<1000||timeout>30000||lease.client||lease.retained)return ESP_ERR_INVALID_ARG;
    if(!cp_v3_mqtt_identity_bind(&identity,settings->node_id,settings->mqtt_namespace,boot))return ESP_ERR_INVALID_STATE;
    if(!s)s=heap_caps_aligned_calloc(8,1,sizeof *s,MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT);
    if(!s)return ESP_ERR_NO_MEM;
    memset(s,0,sizeof *s);s->settings=*settings;strcpy(s->boot,boot);s->timeout=timeout;s->configured=true;
    if(!s_signal)s_signal=xSemaphoreCreateBinaryStatic(&signal_storage);
    if(!io)io=xSemaphoreCreateMutexStatic(&io_storage);
    if(!s_signal||!io)return ESP_ERR_NO_MEM;
    while(xSemaphoreTake(s_signal,0)==pdTRUE){}
    phase(0);return ESP_OK;
}
static esp_err_t connect_client(bool (*active)(void),cp_v3_transport_response_t *out){
    if(lease.retained)return ESP_ERR_INVALID_STATE;
    if(lease.client&&healthy()&&s->subscribed){
        out->tls_connected=1;out->mqtt_session_ready=true;
        take();out->mqtt_callback_stack_min=s->callback_stack_min;give();return ESP_OK;
    }
    esp_err_t result=cp_v3_mqtt_stop();if(result!=ESP_OK)return result;
    if(!memory(true,0)){phase(1);return ESP_ERR_NO_MEM;}
    take();s->connected=s->subscribed=s->error=false;s->suback=0;s->suback_qos=-1;s->tls_esp=s->tls_stack=s->tls_flags=s->socket_error=s->connect_code=0;give();
    snprintf(s->client_id,sizeof s->client_id,"%s:%s",s->settings.node_id,s->boot);
    snprintf(s->subscription,sizeof s->subscription,"cp/v1/%s/%s/rep/ingest/+",s->settings.mqtt_namespace,s->boot);
    /* Auto reconnect is disabled. QoS retransmission is placed far beyond this
     * bounded request/stop lifetime; unsettled data always forces confirmed
     * stop before another application attempt can spend a fresh budget. */
    esp_mqtt_client_config_t config={
        .broker={.address.uri=s->settings.mqtt_uri,.verification={.crt_bundle_attach=esp_crt_bundle_attach,.skip_cert_common_name_check=false}},
        .credentials={.client_id=s->client_id,.username=s->settings.mqtt_username,.authentication.password=s->settings.mqtt_password},
        .session={.protocol_ver=MQTT_PROTOCOL_V_3_1_1,.keepalive=60,.disable_clean_session=false,.message_retransmit_timeout=1200000},
        .network={.disable_auto_reconnect=true,.timeout_ms=12000,.refresh_connection_after_ms=0},
        .task={.stack_size=CP_MQTT_TASK_STACK,.priority=4},.buffer={.size=CP_MQTT_IO_BUFFER,.out_size=CP_MQTT_IO_BUFFER},.outbox.limit=CP_MQTT_OUTBOX_LIMIT};
    esp_log_level_set("mqtt_client",ESP_LOG_NONE);esp_log_level_set("esp-tls",ESP_LOG_NONE);esp_log_level_set("esp-tls-mbedtls",ESP_LOG_NONE);
    phase(2);lease.client=esp_mqtt_client_init(&config);if(!lease.client)return ESP_ERR_NO_MEM;
    result=esp_mqtt_client_register_event(lease.client,ESP_EVENT_ANY_ID,event,NULL);
    if(result==ESP_OK){result=esp_mqtt_client_start(lease.client);lease.started=result==ESP_OK;}
    uint64_t deadline=now()+s->timeout;
    while(result==ESP_OK&&!healthy()&&active()&&now()<deadline){take();bool error=s->error;give();if(error)break;wait_event();}
    if(result==ESP_OK&&!healthy()){
        take();int refused=s->connect_code;give();
        result=!active()||refused?ESP_ERR_INVALID_STATE:ESP_ERR_TIMEOUT;
    }
    if(result==ESP_OK){
        /* Owner-side getter only after CONNECTED: the transport list is fully
         * initialized, auto-reconnect is off and only this owner destroys it.
         * The event callback itself never calls any SDK network getter. */
        esp_transport_handle_t tls=esp_mqtt_client_get_transport(lease.client,MQTT_OVER_SSL_SCHEME);
        if(!tls)result=ESP_ERR_INVALID_STATE;else __atomic_store_n(&tls_transport,tls,__ATOMIC_RELEASE);
    }
    if(result==ESP_OK){int id=esp_mqtt_client_subscribe(lease.client,s->subscription,0);if(id<=0)result=ESP_FAIL;
        bool subscribed=false;
        while(result==ESP_OK&&healthy()&&active()&&now()<deadline){take();subscribed=s->suback==id&&s->suback_qos==0;give();if(subscribed)break;wait_event();}
        if(!subscribed)result=active()?ESP_ERR_TIMEOUT:ESP_ERR_INVALID_STATE;
        if(result==ESP_OK&&esp_mqtt_client_get_outbox_size(lease.client)!=0)result=ESP_ERR_INVALID_STATE;
    }
    take();out->tls_esp_error=s->tls_esp;out->tls_stack_error=s->tls_stack;out->tls_verify_flags=s->tls_flags;out->io_error=s->socket_error;
    out->mqtt_connect_code=s->connect_code;out->mqtt_callback_stack_min=s->callback_stack_min;give();
    out->mqtt_session_ready=result==ESP_OK;out->tls_connected=result==ESP_OK?1:0;phase(3);
    if(result!=ESP_OK){esp_err_t stopped=cp_v3_mqtt_stop();out->mqtt_stop_confirmed=stopped==ESP_OK;out->mqtt_retained=lease.retained;if(stopped!=ESP_OK)return ESP_ERR_INVALID_STATE;}
    return result;
}
esp_err_t cp_v3_mqtt_request(cp_v3_http_method_t method,const char *path,const void *body,size_t bytes,bool receipt_only,
    char *response,size_t capacity,cp_v3_transport_response_t *out,bool (*active)(void)){
    if(!s||!s->configured||!out||!response||!capacity||!active||memory_work)return ESP_ERR_INVALID_STATE;
    if(lease.retained||stop_job.pending){out->mqtt_retained=true;return ESP_ERR_INVALID_STATE;}
    if(lease.client&&esp_mqtt_client_get_outbox_size(lease.client)!=0){
        out->mqtt_outbox_bytes=(uint32_t)esp_mqtt_client_get_outbox_size(lease.client);
        esp_err_t stopped=cp_v3_mqtt_stop();out->mqtt_stop_confirmed=stopped==ESP_OK;out->mqtt_retained=lease.retained;
        return ESP_ERR_INVALID_STATE;
    }
    unsigned op=cp_v3_mqtt_subop(method,path,receipt_only);size_t frame_bytes=0;
    if(!op||!cp_v3_mqtt_frame(op,receipt_only,body,bytes,s->frame,sizeof s->frame,&frame_bytes))return ESP_ERR_INVALID_ARG;
    if(op==2){char expected[96];snprintf(expected,sizeof expected,"/api/v3/device/config?boot_id=%s",s->boot);if(strcmp(path,expected))return ESP_ERR_INVALID_ARG;}
    out->stage=CP_V3_TRANSPORT_TLS;esp_err_t result=connect_client(active,out);if(result!=ESP_OK)return result;
    if(!memory(false,frame_bytes)){phase(4);return ESP_ERR_NO_MEM;}
    char topic[CP_V3_MQTT_TOPIC_BYTES],reply_topic[CP_V3_MQTT_TOPIC_BYTES];uint32_t rpc;
    if(!cp_v3_mqtt_identity_next(&identity,&rpc))return ESP_ERR_INVALID_STATE;
    int n=snprintf(topic,sizeof topic,"cp/v1/%s/%s/req/ingest/%lu",s->settings.mqtt_namespace,s->boot,(unsigned long)rpc);
    int r=snprintf(reply_topic,sizeof reply_topic,"cp/v1/%s/%s/rep/ingest/%lu",s->settings.mqtt_namespace,s->boot,(unsigned long)rpc);
    if(n<0||(size_t)n>=sizeof topic||r<0||(size_t)r>=sizeof reply_topic)return ESP_ERR_INVALID_SIZE;
    take();bool begun=cp_v3_mqtt_begin(&s->rpc,reply_topic);give();if(!begun)return ESP_ERR_INVALID_STATE;
    if(esp_mqtt_client_get_outbox_size(lease.client)!=0){
        esp_err_t stopped=cp_v3_mqtt_stop();out->mqtt_stop_confirmed=stopped==ESP_OK;out->mqtt_retained=lease.retained;return ESP_ERR_INVALID_STATE;
    }
    uint64_t deadline=now()+s->timeout;out->stage=CP_V3_TRANSPORT_REQUEST_BODY;
    int id=esp_mqtt_client_publish(lease.client,topic,(const char *)s->frame,(int)frame_bytes,1,0);
    take();s->rpc.publish_id=id;if(id<=0)s->rpc.failed=true;give();out->mqtt_publish_id=id;
    if(id>0)out->written_bytes=(uint32_t)frame_bytes;
    bool done=false,protocol_failed=false;size_t outbox=0;
    while(active()&&now()<deadline){outbox=(size_t)esp_mqtt_client_get_outbox_size(lease.client);
        take();done=cp_v3_mqtt_done(&s->rpc,outbox);bool failed=s->rpc.failed;protocol_failed=failed&&!s->error;give();if(done||failed||!healthy())break;wait_event();}
    result=done?ESP_OK:!active()?ESP_ERR_INVALID_STATE:protocol_failed?ESP_ERR_INVALID_RESPONSE:id<=0?ESP_FAIL:ESP_ERR_TIMEOUT;
    take();out->mqtt_puback_id=s->rpc.puback_id;out->mqtt_response_received=s->rpc.complete;out->received_bytes=(uint32_t)s->rpc.used;
    out->mqtt_callback_stack_min=s->callback_stack_min;out->tls_esp_error=s->tls_esp;out->tls_stack_error=s->tls_stack;out->tls_verify_flags=s->tls_flags;out->io_error=s->socket_error;
    if(s->rpc.complete)out->parsed_http_status=((unsigned)s->rpc.reply[0]<<8)|s->rpc.reply[1];
    if(done){size_t length=s->rpc.total-2;
        if(length>=capacity)result=ESP_ERR_INVALID_SIZE;
        else {memcpy(response,s->rpc.reply+2,length);response[length]=0;out->body_bytes=length;out->http_status=out->parsed_http_status;out->complete=true;out->stage=CP_V3_TRANSPORT_COMPLETE;}
    }
    s->rpc.active=s->rpc.assembling=false;give();
    outbox=(size_t)esp_mqtt_client_get_outbox_size(lease.client);out->mqtt_outbox_bytes=(uint32_t)outbox;
    if(result!=ESP_OK||outbox||!healthy()||!active()){
        esp_err_t stopped=cp_v3_mqtt_stop();out->mqtt_stop_confirmed=stopped==ESP_OK;out->mqtt_retained=lease.retained;
        if(stopped!=ESP_OK)result=ESP_ERR_INVALID_STATE;
    }
    if(result!=ESP_OK){response[0]=0;out->complete=false;out->http_status=0;out->body_bytes=0;}
    return result;
}
