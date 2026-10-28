/* Matched LAN HTTPS/MQTTS with real passive BLE + RAM aggregation only. */
#include <errno.h>
#include <inttypes.h>
#include <stdio.h>
#include <string.h>
#include <sys/time.h>
#include <time.h>
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"

#include "esp_heap_caps.h"
#include "esp_http_client.h"
#include "esp_log.h"

#include "esp_random.h"
#include "esp_timer.h"
#include "mqtt_client.h"
#include "ble_load.h"
#include "esp_wifi.h"
#include "mbedtls/sha256.h"
#include "probe_wire.h"
#include "compare_config.h"
#include "mqtt_lifetime.h"
#include "cpu_probe.h"

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
    time_t now=time(NULL);
    bool valid=now>=CFG_epoch-300&&now<=CFG_epoch+86400&&now>=1735689600;
    printf("COMPARE_CLOCK configured_epoch=%lld now=%lld guard=%u\n",
        (long long)CFG_epoch,(long long)now,valid);
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
    esp_http_client_config_t cfg={.url=cfg_https_origin,.cert_pem=cfg_ca_pem,
        .tls_version=ESP_HTTP_CLIENT_TLS_VER_TLS_1_2,.skip_cert_common_name_check=false,
        .disable_auto_redirect=true,.max_authorization_retries=-1,.timeout_ms=12000,.is_async=true,
        .event_handler=http_event,.user_data=state,.buffer_size=1024,.buffer_size_tx=1024,
        .keep_alive_enable=true,.addr_type=HTTP_ADDR_TYPE_INET};
    return esp_http_client_init(&cfg);
}
static bool http_request(esp_http_client_handle_t client,http_state_t *s,const char *mode,
    size_t bytes,unsigned sample,char previous_id[37])
{
    probe_cpu_point_t cpu_before=probe_cpu_begin(false);
    lan_ble_counts_t ble_before;lan_ble_snapshot(&ble_before);
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
    // Both local SDK events and the server's socket-scoped ID must agree.
    bool reused=valid&&open&&s->connects==0&&previous_id[0]&&!strcmp(previous_id,receipt.connection_id);
    if(!strcmp(mode,"warm")&&!reused)valid=false;
    const char *stage=err!=ESP_OK?(s->connects||s->open?"io":"connect"):
        status!=200?"status":!valid?"receipt":"none";
    size_t minimum=monitor?heap_caps_get_minimum_free_size(HEAP_CAPS):0;
    if(monitor)heap_caps_monitor_local_minimum_free_size_stop();
    elapsed=esp_timer_get_time()-s->start;
    probe_cpu_end(&cpu_before,"https",mode,bytes,sample,false,false);
    printf("COMPARE_HTTP mode=%s sample=%u seq=%"PRIu32" bytes=%u valid=%u err=%d stage=%s status=%d "
        "connects=%u connect_us=%"PRId64" first_body_us=%"PRId64" elapsed_us=%"PRId64" "
        "reuse_verified=%u response_bytes=%u overflow=%u tls_error=%d tls_flags=%d "
        "free_start=%u free_min=%u free_end=%u largest_start=%u largest_end=%u connection_id=%s colo=%s\n",
        mode,sample,seq,(unsigned)bytes,valid,err,stage,status,s->connects,s->connect_us,s->first_us,elapsed,
        reused,(unsigned)s->used,s->overflow,tls_error,tls_flags,(unsigned)free_start,
        (unsigned)minimum,(unsigned)heap_caps_get_free_size(HEAP_CAPS),(unsigned)largest,
        (unsigned)heap_caps_get_largest_free_block(HEAP_CAPS),valid?receipt.connection_id:"none",valid?receipt.colo:"none");
    lan_ble_print("request",mode,sample,&ble_before);
    if(valid){successes++;strcpy(previous_id,receipt.connection_id);}else{failures++;previous_id[0]=0;esp_http_client_close(client);}
    return valid;
}
static void group_memory(const char *group)
{
    wifi_ps_type_t ps=WIFI_PS_NONE;esp_wifi_get_ps(&ps);
    printf("COMPARE_HEAP group=%s free=%u largest=%u boot_min=%u wifi_ps=%d\n",group,
        (unsigned)heap_caps_get_free_size(HEAP_CAPS),(unsigned)heap_caps_get_largest_free_block(HEAP_CAPS),
        (unsigned)heap_caps_get_minimum_free_size(HEAP_CAPS),ps);
    lan_ble_print("group",group,0,NULL);
}
static void http_phase(bool reuse,size_t bytes)
{
    http_state_t state={0};esp_http_client_handle_t client=NULL;char previous[37]={0};
    unsigned count=reuse?CFG_reuseSamples+1:CFG_freshSamples;
    group_memory(reuse?"https_reuse_before":"https_fresh_before");
    for(unsigned i=0;i<count&&available();i++){
        if(!client){client=http_new(&state);previous[0]=0;}
        if(!client){failures++;printf("COMPARE_HTTP_ALLOC valid=0\n");break;}
        bool valid=http_request(client,&state,reuse?(i?"warm":"prime"):"fresh",bytes,i,previous);
        if(!reuse||!valid){esp_http_client_cleanup(client);client=NULL;state.open=false;}
        if(reuse&&!valid)break;
        vTaskDelay(pdMS_TO_TICKS(30));
    }
    if(client)esp_http_client_cleanup(client);
    group_memory(reuse?"https_reuse_after":"https_fresh_after");
}

typedef struct { size_t length;int64_t received_at;char data[PROBE_RECEIPT_CAP]; } mqtt_message_t;
typedef struct {
    QueueHandle_t messages;
    unsigned connected,disconnected,errors,subacks,sub_fail,pubacks,invalid,losses;
    int subscription_id,last_puback,tls_error,tls_flags,sock_error;
    int64_t connected_at,subscribed_at,puback_at,connect_elapsed,request_elapsed;
    size_t used,total;bool assembling;
    char response[PROBE_RECEIPT_CAP],client_id[40],data_topic[64],ack_topic[64];
} mqtt_state_t;
/* A failed or timed-out SDK stop can leave callbacks and a task alive. All
 * ownership and userdata are static, and retained clients prohibit new groups. */
static mqtt_state_t mqtt_state;
static probe_mqtt_lease_t mqtt_lease;
static bool transport_retained;
static probe_cpu_point_t mqtt_cpu_before;
static bool mqtt_cpu_pending;
static const char *mqtt_api(void){return CFG_mqttDirectPublish?"publish":"enqueue";}
static struct { esp_mqtt_client_handle_t client; int result; unsigned done; } stop_job;
static void mqtt_stop_task(void *unused)
{
    (void)unused;stop_job.result=esp_mqtt_client_stop(stop_job.client);
    __atomic_store_n(&stop_job.done,1,__ATOMIC_RELEASE);vTaskDelete(NULL);
}
static int mqtt_stop_confirm(void *client)
{
    stop_job.client=client;stop_job.result=ESP_FAIL;__atomic_store_n(&stop_job.done,0,__ATOMIC_RELEASE);
    // Lower priority than the waiting main owner: a normal SDK busy loop in
    // this helper must not prevent its supervisor's timeout from running.
    if(xTaskCreate(mqtt_stop_task,"probe_mq_stop",6144,NULL,tskIDLE_PRIORITY,NULL)!=pdPASS)return ESP_ERR_NO_MEM;
    int64_t start=esp_timer_get_time();
    while(!__atomic_load_n(&stop_job.done,__ATOMIC_ACQUIRE)&&esp_timer_get_time()-start<10000000LL)
        vTaskDelay(pdMS_TO_TICKS(10));
    return __atomic_load_n(&stop_job.done,__ATOMIC_ACQUIRE)?stop_job.result:ESP_ERR_TIMEOUT;
}
static int mqtt_destroy_stopped(void *client){return esp_mqtt_client_destroy(client);}
static void mqtt_delete_queue(void *queue){vQueueDelete(queue);}
static bool mqtt_release(void)
{
    static const probe_mqtt_lifetime_ops_t ops={mqtt_stop_confirm,mqtt_destroy_stopped,mqtt_delete_queue};
    int result=probe_mqtt_release(&mqtt_lease,&ops);
    printf("COMPARE_MQTT_RELEASE valid=%u result=%d retained=%u\n",result==0,result,mqtt_lease.retained);
    if(result){transport_retained=true;failures++;return false;}
    mqtt_state.messages=NULL;return true;
}
static unsigned counter(unsigned *p){return __atomic_load_n(p,__ATOMIC_ACQUIRE);}
static void increment(unsigned *p){__atomic_add_fetch(p,1,__ATOMIC_RELEASE);}
static void mqtt_event(void *arg,esp_event_base_t base,int32_t id,void *data)
{
    (void)base;mqtt_state_t *s=arg;esp_mqtt_event_handle_t e=data;
    switch(id){
    case MQTT_EVENT_CONNECTED:
        s->connected_at=esp_timer_get_time();increment(&s->connected);
        s->subscription_id=esp_mqtt_client_subscribe(e->client,s->ack_topic,1);
        if(s->subscription_id<0){increment(&s->sub_fail);increment(&s->errors);}break;
    case MQTT_EVENT_DISCONNECTED:increment(&s->disconnected);break;
    case MQTT_EVENT_SUBSCRIBED:
        // IDF v5.5.3 also emits SUBSCRIBED on failed 0x80 grants.
        if(e->msg_id==s->subscription_id&&e->data&&e->data_len==1&&
            (unsigned char)e->data[0]==1&&e->error_handle&&e->error_handle->error_type==MQTT_ERROR_TYPE_NONE){
            s->subscribed_at=esp_timer_get_time();increment(&s->subacks);
        }else{increment(&s->sub_fail);increment(&s->errors);}break;
    case MQTT_EVENT_PUBLISHED:
        s->puback_at=esp_timer_get_time();
        __atomic_store_n(&s->last_puback,e->msg_id,__ATOMIC_RELEASE);increment(&s->pubacks);break;
    case MQTT_EVENT_ERROR:
        if(e->error_handle){s->tls_error=e->error_handle->esp_tls_stack_err;
            s->tls_flags=e->error_handle->esp_tls_cert_verify_flags;s->sock_error=e->error_handle->esp_transport_sock_errno;}
        increment(&s->errors);break;
    case MQTT_EVENT_DATA:
        if(e->current_data_offset==0){
            s->assembling=false;s->used=0;s->total=0;
            if(!e->topic||e->topic_len!=(int)strlen(s->ack_topic)||memcmp(e->topic,s->ack_topic,e->topic_len)||
               e->qos!=1||e->retain||e->total_data_len<1||e->total_data_len>=PROBE_RECEIPT_CAP){increment(&s->invalid);break;}
            s->total=(size_t)e->total_data_len;s->assembling=true;
        }
        if(!s->assembling)break;
        if(e->data_len<0||e->current_data_offset<0||(size_t)e->current_data_offset!=s->used||
            (size_t)e->total_data_len!=s->total||(size_t)e->data_len>s->total-s->used){
            s->assembling=false;increment(&s->invalid);break;}
        memcpy(s->response+s->used,e->data,e->data_len);s->used+=e->data_len;
        if(s->used==s->total){mqtt_message_t m={.length=s->used,.received_at=esp_timer_get_time()};memcpy(m.data,s->response,s->used);
            s->assembling=false;if(xQueueSend(s->messages,&m,0)!=pdTRUE)increment(&s->losses);}
        break;
    default:break;
    }
}
static esp_mqtt_client_handle_t mqtt_connect(mqtt_state_t *s,const char *mode,size_t bytes,unsigned sample)
{
    memset(s,0,sizeof(*s));s->last_puback=-1;s->subscription_id=-1;
    snprintf(s->client_id,sizeof(s->client_id),"bench-%s",run_hex);
    snprintf(s->data_topic,sizeof(s->data_topic),"probe/%s/data",s->client_id);
    snprintf(s->ack_topic,sizeof(s->ack_topic),"probe/%s/ack",s->client_id);
    s->messages=xQueueCreate(2,sizeof(mqtt_message_t));if(!s->messages){failures++;return NULL;}
    esp_mqtt_client_config_t cfg={
        .broker.address.uri=cfg_mqtt_uri,
        .broker.verification={.certificate=cfg_ca_pem,.skip_cert_common_name_check=false},
        .credentials={.client_id=s->client_id,.username="probe",.authentication.password=cfg_token},
        .session={.keepalive=15,.protocol_ver=MQTT_PROTOCOL_V_3_1_1,.message_retransmit_timeout=15000},
        .network={.disable_auto_reconnect=true,.timeout_ms=3000},
        .task={.stack_size=6144,.priority=5},.buffer={.size=1024,.out_size=CFG_mqttOutSize},.outbox.limit=20000,
    };
    size_t free_start=heap_caps_get_free_size(HEAP_CAPS),largest=heap_caps_get_largest_free_block(HEAP_CAPS);
    bool monitor=heap_caps_monitor_local_minimum_free_size_start()==ESP_OK;int64_t start=esp_timer_get_time();
    esp_mqtt_client_handle_t c=esp_mqtt_client_init(&cfg);
    mqtt_lease=(probe_mqtt_lease_t){.client=c,.queue=s->messages};
    esp_err_t err=c?esp_mqtt_client_register_event(c,ESP_EVENT_ANY_ID,mqtt_event,s):ESP_ERR_NO_MEM;
    if(err==ESP_OK){err=esp_mqtt_client_start(c);mqtt_lease.started=err==ESP_OK;}
    int cap=remaining_ms(12000);
    while(err==ESP_OK&&!counter(&s->subacks)&&!counter(&s->errors)&&available()&&
        esp_timer_get_time()-start<(int64_t)cap*1000)vTaskDelay(pdMS_TO_TICKS(10));
    bool valid=err==ESP_OK&&counter(&s->connected)==1&&counter(&s->subacks)==1&&
        !counter(&s->errors)&&!counter(&s->disconnected);
    s->connect_elapsed=esp_timer_get_time()-start;
    size_t minimum=monitor?heap_caps_get_minimum_free_size(HEAP_CAPS):0;
    if(monitor)heap_caps_monitor_local_minimum_free_size_stop();
    printf("COMPARE_MQTT_CONNECT mode=%s mqtt_api=%s mqtt_out_size=%lld bytes=%u sample=%u valid=%u err=%d elapsed_us=%"PRId64
        " connected_us=%"PRId64" suback_us=%"PRId64" subacks=%u sub_fail=%u errors=%u "
        "tls_error=%d tls_flags=%d socket_error=%d free_start=%u free_min=%u free_end=%u largest_start=%u largest_end=%u task_stack=6144 outbox_limit=20000\n",
        mode,mqtt_api(),(long long)CFG_mqttOutSize,(unsigned)bytes,sample,valid,err,esp_timer_get_time()-start,s->connected_at?s->connected_at-start:-1,
        s->subscribed_at?s->subscribed_at-start:-1,counter(&s->subacks),counter(&s->sub_fail),counter(&s->errors),
        s->tls_error,s->tls_flags,s->sock_error,(unsigned)free_start,(unsigned)minimum,
        (unsigned)heap_caps_get_free_size(HEAP_CAPS),(unsigned)largest,(unsigned)heap_caps_get_largest_free_block(HEAP_CAPS));
    if(!valid){failures++;mqtt_release();return NULL;}
    return c;
}
static bool mqtt_request(esp_mqtt_client_handle_t c,mqtt_state_t *s,const char *mode,size_t bytes,unsigned sample,char previous[37])
{
    bool cpu_fresh=mqtt_cpu_pending;
    probe_cpu_point_t cpu_before=cpu_fresh?mqtt_cpu_before:probe_cpu_begin(true);
    lan_ble_counts_t ble_before;lan_ble_snapshot(&ble_before);
    uint32_t seq=++sequence;probe_payload(payload,bytes,run_bytes,seq);char hash[65];digest(bytes,hash);
    size_t free_start=heap_caps_get_free_size(HEAP_CAPS),largest=heap_caps_get_largest_free_block(HEAP_CAPS);
    bool monitor=heap_caps_monitor_local_minimum_free_size_start()==ESP_OK;int64_t start=esp_timer_get_time();
    unsigned errors=counter(&s->errors),drops=counter(&s->disconnected),pubacks=counter(&s->pubacks);
    // Both SDK APIs keep only one bounded QoS1 application message outstanding.
    // Direct publish performs synchronous sends; enqueue leaves transmission to
    // the MQTT worker, including its poll-wake scheduling delay. API call time,
    // outbox allocation and both ACKs remain inside the overall timing window.
    int64_t api_start=esp_timer_get_time();
    int msg_id=CFG_mqttDirectPublish?
        esp_mqtt_client_publish(c,s->data_topic,(char*)payload,(int)bytes,1,0):
        esp_mqtt_client_enqueue(c,s->data_topic,(char*)payload,(int)bytes,1,0,true);
    int64_t api_call_us=esp_timer_get_time()-api_start;
    int outbox=esp_mqtt_client_get_outbox_size(c);int cap=remaining_ms(12000);
    mqtt_message_t response={0};bool received=false,pubacked=false;int64_t receipt_us=-1,puback_us=-1;
    while(msg_id>=0&&available()&&esp_timer_get_time()-start<(int64_t)cap*1000){
        if(!received&&xQueueReceive(s->messages,&response,pdMS_TO_TICKS(10))==pdTRUE){received=true;receipt_us=response.received_at-start;}
        if(!pubacked&&__atomic_load_n(&s->last_puback,__ATOMIC_ACQUIRE)==msg_id&&counter(&s->pubacks)>pubacks){pubacked=true;puback_us=s->puback_at-start;}
        if((received&&pubacked)||counter(&s->errors)!=errors||counter(&s->disconnected)!=drops)break;
        vTaskDelay(pdMS_TO_TICKS(1));
    }
    probe_receipt_t receipt={0};
    bool valid=received&&pubacked&&probe_receipt(response.data,response.length,run_hex,seq,bytes,hash,&receipt)&&
        counter(&s->errors)==errors&&counter(&s->disconnected)==drops&&!counter(&s->losses)&&!counter(&s->invalid)&&
        (!previous[0]||!strcmp(previous,receipt.connection_id));
    size_t minimum=monitor?heap_caps_get_minimum_free_size(HEAP_CAPS):0;
    if(monitor)heap_caps_monitor_local_minimum_free_size_stop();
    s->request_elapsed=esp_timer_get_time()-start;
    probe_cpu_end(&cpu_before,"mqtt",mode,bytes,sample,true,cpu_fresh);mqtt_cpu_pending=false;
    printf("COMPARE_MQTT_MSG mode=%s mqtt_api=%s mqtt_out_size=%lld bytes=%u sample=%u seq=%"PRIu32" valid=%u enqueued=%u puback=%u app_receipt=%u "
        "api_call_us=%"PRId64" enqueue_call_us=%"PRId64" publish_call_us=%"PRId64" puback_us=%"PRId64" receipt_us=%"PRId64" elapsed_us=%"PRId64" outbox_after_api=%d outbox_after_enqueue=%d outbox_end=%d "
        "free_start=%u free_min=%u free_end=%u largest_start=%u largest_end=%u errors=%u disconnected=%u invalid=%u queue_losses=%u\n",
        mode,mqtt_api(),(long long)CFG_mqttOutSize,(unsigned)bytes,sample,seq,valid,msg_id>=0,pubacked,received,
        api_call_us,CFG_mqttDirectPublish?(int64_t)-1:api_call_us,CFG_mqttDirectPublish?api_call_us:(int64_t)-1,
        puback_us,receipt_us,s->request_elapsed,outbox,CFG_mqttDirectPublish?-1:outbox,esp_mqtt_client_get_outbox_size(c),(unsigned)free_start,(unsigned)minimum,
        (unsigned)heap_caps_get_free_size(HEAP_CAPS),(unsigned)largest,(unsigned)heap_caps_get_largest_free_block(HEAP_CAPS),
        counter(&s->errors),counter(&s->disconnected),counter(&s->invalid),counter(&s->losses));
    lan_ble_print("request",mode,sample,&ble_before);
    if(valid){successes++;strcpy(previous,receipt.connection_id);}else failures++;
    return valid;
}
static void mqtt_phase(bool warm,size_t bytes)
{
    group_memory(warm?"mqtt_warm_before":"mqtt_fresh_before");
    mqtt_state_t *state=&mqtt_state;esp_mqtt_client_handle_t c=NULL;char previous[37]={0};
    unsigned count=warm?CFG_mqttWarmSamples:CFG_mqttFreshSamples;
    for(unsigned i=0;i<count&&available();i++){
        if(!c){
            if(!warm){mqtt_cpu_before=probe_cpu_begin(true);mqtt_cpu_pending=true;}
            c=mqtt_connect(state,warm?"warm_setup":"fresh",bytes,i);previous[0]=0;
        }
        if(!c){
            if(mqtt_cpu_pending){probe_cpu_end(&mqtt_cpu_before,"mqtt_connect_failure","fresh",bytes,i,true,true);mqtt_cpu_pending=false;}
            break;
        }
        bool valid=mqtt_request(c,state,warm?"warm":"fresh",bytes,i,previous);
        if(!warm)printf("COMPARE_MQTT_FRESH_TOTAL bytes=%u sample=%u valid=%u elapsed_us=%"PRId64"\n",(unsigned)bytes,i,valid,state->connect_elapsed+state->request_elapsed);
        if(!warm||!valid){bool released=mqtt_release();c=NULL;if(!released)break;}
        if(!valid)break;
        vTaskDelay(pdMS_TO_TICKS(30));
    }
    if(c)mqtt_release();
    group_memory(warm?"mqtt_warm_after":"mqtt_fresh_after");
}
void app_main(void)
{
    esp_log_level_set("*",ESP_LOG_NONE);
    int64_t start=esp_timer_get_time();end_us=start+(CFG_budgetSeconds-20)*1000000LL;
    printf("COMPARE_START synthetic=1 protocol=cp-link-probe/1 receipt_guard=%u mqtt_lifetime_guard=%u heap_low_water=per_heap_sum mqtt_api=%s mqtt_out_size=%lld cpu_stats=%lld budget_s=%lld ble_enabled=%u scan_interval_ms=100 scan_window_ms=%lld\n",
        PROBE_RECEIPT_GUARD_VERSION,PROBE_MQTT_LIFETIME_VERSION,mqtt_api(),(long long)CFG_mqttOutSize,
        (long long)CFG_cpuStats,(long long)CFG_budgetSeconds,LAN_BLE_ENABLED,(long long)CFG_bleWindowMs);
    esp_err_t err=probe_wifi_start_saved(30000);
    printf("COMPARE_WIFI saved_only=1 nvs_readonly=1 ram_storage=1 ok=%u err=%d\n",err==ESP_OK,err);
    if(err!=ESP_OK){failures++;goto done;}
    err=esp_wifi_set_ps((wifi_ps_type_t)CFG_wifiPs);
    if(err!=ESP_OK||!clock_prepare()){failures++;goto done;}
    group_memory("wifi_baseline");
    err=lan_ble_start();printf("COMPARE_BLE_START valid=%u err=%d\n",err==ESP_OK,err);
    if(err!=ESP_OK){failures++;goto stop_ble;}
    esp_fill_random(run_bytes,sizeof(run_bytes));probe_hex(run_bytes,sizeof(run_bytes),run_hex);
    group_memory("ble_baseline");
    probe_cpu_control();
    for(unsigned i=0;i<2&&available();i++){
        size_t bytes=i?8192:1024;http_phase(false,bytes);http_phase(true,bytes);
        mqtt_phase(false,bytes);if(transport_retained)break;
        mqtt_phase(true,bytes);if(transport_retained)break;
    }
stop_ble:
    err=lan_ble_stop();printf("COMPARE_BLE_STOP valid=%u err=%d retained=%u\n",err==ESP_OK,err,lan_ble_runtime_retained());
    if(err!=ESP_OK)failures++;
done:
    esp_wifi_stop();
    unsigned expected=2*(CFG_freshSamples+1+CFG_reuseSamples+CFG_mqttFreshSamples+CFG_mqttWarmSamples);
    printf("COMPARE_DONE success=%u expected=%u failed=%u complete=%u retained_transport=%u budget_exhausted=%u elapsed_us=%"PRId64" free=%u boot_min=%u\n",
        successes,expected,failures,successes==expected&&!failures,transport_retained,!available(),esp_timer_get_time()-start,
        (unsigned)heap_caps_get_free_size(HEAP_CAPS),(unsigned)heap_caps_get_minimum_free_size(HEAP_CAPS));
}
