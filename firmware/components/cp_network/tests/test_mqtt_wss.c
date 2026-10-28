#include <assert.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <pthread.h>
#include <sched.h>
#include "mqtt_client.h"
#include "sdkconfig.h"
#include "cp_settings.h"
static cp_settings_t settings={.device_token="synthetic-test",.mqtt_uri=CP_MQTT_PRODUCTION_URI,
    .mqtt_username="synthetic-broker-user",.mqtt_password="synthetic-broker-password",.mqtt_namespace="fixture_pool"};
static unsigned allocations;static int malloc_fail=-1;
static void *response_malloc(size_t n){++allocations;if(malloc_fail==0)return NULL;if(malloc_fail>0)--malloc_fail;return malloc(n);}
#define malloc response_malloc
#include "../mqtt_wss.c"
#undef malloc
struct test_client {esp_event_handler_t handler;void *argument;unsigned char *outbox;size_t outbox_bytes;bool started;};
static uint64_t clock_ms;static size_t heap_free=100000,heap_largest=50000;
static unsigned starts,destroys,publications,ws_headers,ws_lookups,init_calls;
static unsigned transport_reads,transport_writes,transport_polls;
static int transport_readable=1,transport_result=1;
static bool transport_ready_after_wait;
static bool mutex_fail,io_take_fail,assert_sdk_lock_order=true;
static pthread_mutex_t host_io_mutex=PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t host_io_changed=PTHREAD_COND_INITIALIZER;
static pthread_mutex_t host_sdk_api=PTHREAD_MUTEX_INITIALIZER;
static unsigned threaded_io_waiting,threaded_io_done,hold_real_read,real_read_entered;
static bool active=true,reply_enabled=true,puback_enabled=true,ack_first=false;
static bool init_oom,headers_oom,start_fail,subscribe_fail,stop_fail,stop_hang,task_oom,publish_fail;
static bool tls_missing;
static bool delayed_response,disconnect_after_reply,bad_suback;static char late_topic[CP_MQTT_TOPIC_CAP];
static uint32_t publish_delay;
static void event_emit(esp_mqtt_client_handle_t c,int id,esp_mqtt_event_t *e){e->client=c;c->handler(c->argument,NULL,id,e);}
static void reply_emit(esp_mqtt_client_handle_t c,const char *topic){
    const char body[]={0,(char)200,'{','"','o','k','"',':','1','}'};
    esp_mqtt_event_t e={.topic=topic,.topic_len=(int)strlen(topic),.data=body,.data_len=1,.total_data_len=sizeof(body)};
    event_emit(c,MQTT_EVENT_DATA,&e);e.topic=NULL;e.topic_len=0;e.data=body+1;e.data_len=sizeof(body)-1;e.current_data_offset=1;event_emit(c,MQTT_EVENT_DATA,&e);
}
static void puback_emit(esp_mqtt_client_handle_t c){free(c->outbox);c->outbox=NULL;c->outbox_bytes=0;esp_mqtt_event_t e={.msg_id=77};event_emit(c,MQTT_EVENT_PUBLISHED,&e);}
void test_log(const char *fmt,...){char output[1024];va_list ap;va_start(ap,fmt);
    vsnprintf(output,sizeof(output),fmt,ap);va_end(ap);
    assert(!strstr(output,"synthetic-test")&&!strstr(output,"synthetic-broker")&&
        !strstr(output,"Authorization")&&!strstr(output,"secret@"));}
void esp_log_level_set(const char *tag,int level){assert(!strcmp(tag,"transport_ws")&&level==ESP_LOG_NONE);}
esp_err_t esp_crt_bundle_attach(void *p){(void)p;return ESP_OK;}
size_t heap_caps_get_free_size(unsigned caps){(void)caps;return heap_free;}
size_t heap_caps_get_largest_free_block(unsigned caps){(void)caps;return heap_largest;}
int64_t esp_timer_get_time(void){return (int64_t)clock_ms*1000;}
unsigned uxTaskGetStackHighWaterMark(void *p){(void)p;return 2000;}
SemaphoreHandle_t xSemaphoreCreateBinaryStatic(StaticSemaphore_t *p){*p=0;return p;}
SemaphoreHandle_t xSemaphoreCreateMutexStatic(StaticSemaphore_t *p){if(mutex_fail)return NULL;*p=1;return p;}
int xSemaphoreTake(SemaphoreHandle_t p,TickType_t ticks){
    if(p==s_io){
        if(io_take_fail)return 0;
        pthread_mutex_lock(&host_io_mutex);
        while(!*p&&ticks==portMAX_DELAY){
            __atomic_store_n(&threaded_io_waiting,1u,__ATOMIC_RELEASE);
            pthread_cond_wait(&host_io_changed,&host_io_mutex);
        }
        int result=*p?pdTRUE:0;if(result)*p=0;
        pthread_mutex_unlock(&host_io_mutex);if(!result)clock_ms+=ticks;return result;
    }
    if(*p){*p=0;return pdTRUE;}clock_ms+=ticks;return 0;
}
void xSemaphoreGive(SemaphoreHandle_t p){
    if(p==s_io){pthread_mutex_lock(&host_io_mutex);assert(!*p);*p=1;
        pthread_cond_broadcast(&host_io_changed);pthread_mutex_unlock(&host_io_mutex);}
    else *p=1;
}
int esp_transport_poll_read(esp_transport_handle_t p,int timeout){assert(p==s_tls&&timeout>=0);++transport_polls;
    return timeout>0&&transport_ready_after_wait?1:transport_readable;}
int __real_esp_transport_read(esp_transport_handle_t p,char *buffer,int n,int timeout){
    (void)buffer;(void)n;(void)timeout;if(p==s_tls){assert(s_io&&!*s_io&&!s_memory_work);}
    if(__atomic_load_n(&hold_real_read,__ATOMIC_ACQUIRE)){
        __atomic_store_n(&real_read_entered,1u,__ATOMIC_RELEASE);
        while(__atomic_load_n(&hold_real_read,__ATOMIC_ACQUIRE))sched_yield();
    }
    ++transport_reads;return transport_result;
}
int __real_esp_transport_write(esp_transport_handle_t p,const char *buffer,int n,int timeout){
    (void)buffer;(void)n;(void)timeout;if(p==s_tls){assert(s_io&&!*s_io&&!s_memory_work);}
    ++transport_writes;return transport_result;
}
void vTaskDelay(TickType_t ticks){clock_ms+=ticks;}
void vTaskDelete(void *p){(void)p;}
int xTaskCreate(void (*fn)(void *),const char *name,unsigned stack,void *arg,unsigned priority,void *out){
    (void)out;assert(!strcmp(name,"cp_mq_stop")&&stack==4096&&priority==tskIDLE_PRIORITY);
    if(task_oom)return 0;if(!stop_hang)fn(arg);return pdPASS;
}
esp_mqtt_client_handle_t esp_mqtt_client_init(const esp_mqtt_client_config_t *c){
    ++init_calls;
    assert(c->network.disable_auto_reconnect&&c->network.refresh_connection_after_ms==0);
    assert(c->network.timeout_ms==12000);
    assert(c->broker.verification.crt_bundle_attach==esp_crt_bundle_attach&&!c->broker.verification.skip_cert_common_name_check);
    assert(c->session.protocol_ver==MQTT_PROTOCOL_V_3_1_1&&!c->session.disable_clean_session&&c->session.keepalive==60);
    assert(c->task.stack_size==6144&&c->buffer.size==1024&&c->buffer.out_size==1024&&c->outbox.limit==12288);
    assert(!strcmp(c->credentials.client_id,"test:00000000-0000-4000-8000-000000000001"));
#if CONFIG_CP_NETWORK_MQTT_NATIVE_TLS
    assert(!strcmp(c->broker.address.uri,settings.mqtt_uri));
    assert(!strcmp(c->credentials.username,settings.mqtt_username));
    assert(!strcmp(c->credentials.authentication.password,settings.mqtt_password));
    assert(strcmp(c->credentials.authentication.password,"synthetic-test"));
#else
    assert(!strcmp(c->broker.address.uri,CONFIG_CP_NETWORK_MQTT_WSS_URI));
    assert(!strcmp(c->credentials.username,"test")&&!c->credentials.authentication.password);
#endif
    if(init_oom)return NULL;return calloc(1,sizeof(struct test_client));
}
esp_err_t esp_mqtt_client_register_event(esp_mqtt_client_handle_t c,int event_id,esp_event_handler_t handler,void *arg){
    assert(event_id==ESP_EVENT_ANY_ID);c->handler=handler;c->argument=arg;return ESP_OK;
}
esp_err_t esp_mqtt_client_start(esp_mqtt_client_handle_t c){
    ++starts;if(start_fail)return ESP_FAIL;c->started=true;esp_mqtt_event_t e={0};
    event_emit(c,MQTT_EVENT_BEFORE_CONNECT,&e);if(!headers_oom&&!tls_missing)event_emit(c,MQTT_EVENT_CONNECTED,&e);return ESP_OK;
}
esp_transport_handle_t esp_mqtt_client_get_transport(esp_mqtt_client_handle_t c,char *scheme){
    assert(!strcmp(scheme,"wss")||!strcmp(scheme,"mqtts"));
    if(!strcmp(scheme,"wss")){++ws_lookups;assert(!CONFIG_CP_NETWORK_MQTT_NATIVE_TLS);}
    return tls_missing&&!strcmp(scheme,"mqtts")?NULL:c;
}
void esp_transport_ssl_set_esp_tls_dyn_buf_strategy(esp_transport_handle_t t,int strategy){(void)t;(void)strategy;assert(!"RX must remain dynamic");}
esp_err_t esp_transport_ws_set_headers(esp_transport_handle_t t,const char *h){
    assert(!CONFIG_CP_NETWORK_MQTT_NATIVE_TLS&&t&&!strcmp(h,"Authorization: Bearer synthetic-test\r\n"));
    ++ws_headers;return headers_oom?ESP_ERR_NO_MEM:ESP_OK;}
int esp_transport_ws_get_upgrade_request_status(esp_transport_handle_t t){assert(t);return 101;}
int esp_mqtt_client_subscribe(esp_mqtt_client_handle_t c,const char *topic,int qos){
    assert(strstr(topic,"/rep/+/+")&&qos==0);
#if CONFIG_CP_NETWORK_MQTT_NATIVE_TLS
    assert(!strncmp(topic,"cp/v1/fixture_pool/",18));
#endif
    if(subscribe_fail)return -1;
    char grant=bad_suback?(char)0x80:0;esp_mqtt_event_t e={.msg_id=12,.data=&grant,.data_len=1};event_emit(c,MQTT_EVENT_SUBSCRIBED,&e);return 12;
}
int esp_mqtt_client_publish(esp_mqtt_client_handle_t c,const char *topic,const char *body,int n,int qos,int retain){
    #if CONFIG_CP_NETWORK_MQTT_NATIVE_TLS
    assert(!strncmp(topic,"cp/v1/fixture_pool/",18));
#endif
    ++publications;assert(qos==1&&!retain&&!c->outbox&&n>=0&&n<=8192);
    c->outbox=malloc((size_t)n+1u);assert(c->outbox);if(n){memcpy(c->outbox,body,(size_t)n);assert(!memcmp(c->outbox,body,(size_t)n));}
    else assert(body==NULL);
    c->outbox_bytes=(size_t)n+1u;
    char reply_topic[CP_MQTT_TOPIC_CAP];strcpy(reply_topic,topic);char *req=strstr(reply_topic,"/req/");assert(req);memcpy(req,"/rep/",5);
    clock_ms+=publish_delay;
    if(delayed_response&&late_topic[0])reply_emit(c,late_topic);
    if(ack_first&&puback_enabled)puback_emit(c);
    if(reply_enabled)reply_emit(c,reply_topic);
    if(!ack_first&&puback_enabled)puback_emit(c);
    strcpy(late_topic,reply_topic);
    if(disconnect_after_reply){esp_mqtt_event_t e={0};event_emit(c,MQTT_EVENT_DISCONNECTED,&e);}
    return publish_fail?-1:77;
}
int esp_mqtt_client_get_outbox_size(esp_mqtt_client_handle_t c){
    if(assert_sdk_lock_order)assert(!s_memory_work);
    pthread_mutex_lock(&host_sdk_api);int bytes=(int)c->outbox_bytes;
    pthread_mutex_unlock(&host_sdk_api);return bytes;
}
esp_err_t esp_mqtt_client_stop(esp_mqtt_client_handle_t c){assert(c&&c->started);if(stop_fail)return ESP_FAIL;
    c->started=false;free(c->outbox);c->outbox=NULL;c->outbox_bytes=0;return ESP_OK;}
esp_err_t esp_mqtt_client_destroy(esp_mqtt_client_handle_t c){assert(c&&!c->started);++destroys;free(c->outbox);free(c);return ESP_OK;}
static bool is_active(void){return active;}

static esp_err_t request(void){
    cp_http_response_t response={0};int status=0;char *body=malloc(8192);memset(body,'x',8192);
    esp_err_t e=cp_mqtt_wss_request(&settings,"test","00000000-0000-4000-8000-000000000001","ingest",body,8192,&response,&status,is_active);
    if(e==ESP_OK){assert(status==200&&response.used==8&&!strcmp(response.body,"{\"ok\":1}"));}
    free(response.body);memset(body,0xa5,8192);free(body);return e;
}
static void control_request(const char *op){
    cp_http_response_t response={0};int status=0;const char *body=strcmp(op,"config")?"{}":NULL;
    assert(cp_mqtt_wss_request(&settings,"test","00000000-0000-4000-8000-000000000001",op,body,
        body?2u:0u,&response,&status,is_active)==ESP_OK);
    assert(status==200);free(response.body);
}
static void clean(void){assert(cp_mqtt_wss_stop()==ESP_OK);assert(!s_lease.client&&!s_lease.retained&&!s_tls&&!s_memory_work);assert(!s_io||*s_io);}
static void wait_flag(unsigned *flag){for(unsigned n=0;n<10000000u;++n){
    if(__atomic_load_n(flag,__ATOMIC_ACQUIRE))return;sched_yield();}assert(!"thread synchronization timed out");}
static void *background_io(void *write){
    /* Same ordering as the pinned SDK MQTT task: API -> IO. */
    pthread_mutex_lock(&host_sdk_api);
    int result=write?__wrap_esp_transport_write(s_tls,NULL,0,12000):
        __wrap_esp_transport_read(s_tls,NULL,0,12000);
    assert(result==1);pthread_mutex_unlock(&host_sdk_api);
    __atomic_store_n(&threaded_io_done,1u,__ATOMIC_RELEASE);return NULL;
}
static void concurrent_gate_checks(void){
    for(unsigned write=0;write<2;++write){
        pthread_t thread;threaded_io_waiting=threaded_io_done=0;
        assert(cp_mqtt_wss_allocation_ready(3841,0));
        assert(pthread_create(&thread,NULL,background_io,write?(void *)1:NULL)==0);
        wait_flag(&threaded_io_waiting);assert(!__atomic_load_n(&threaded_io_done,__ATOMIC_ACQUIRE));
        /* Background owns SDK API now: these must not call it or deadlock. */
        assert(cp_mqtt_wss_upload_ready(true));assert(!cp_mqtt_wss_upload_ready(false));
        cp_mqtt_wss_end_memory_work();assert(pthread_join(thread,NULL)==0);
        assert(threaded_io_done&&*s_io&&!s_memory_work);
    }
    /* A read already owning IO completes before an encoder can enter. */
    pthread_t thread;real_read_entered=threaded_io_done=0;hold_real_read=1;
    assert(pthread_create(&thread,NULL,background_io,NULL)==0);wait_flag(&real_read_entered);
    assert(!s_memory_work);__atomic_store_n(&hold_real_read,0u,__ATOMIC_RELEASE);
    assert(cp_mqtt_wss_encode_ready(100));cp_mqtt_wss_end_memory_work();
    assert(pthread_join(thread,NULL)==0&&threaded_io_done&&*s_io);
}
static void memory_gate_checks(void){
    assert(cp_mqtt_wss_encode_ready(0)&&s_memory_work&&!*s_io);
    assert(!cp_mqtt_wss_memory_safe()&&cp_mqtt_wss_stop()==ESP_ERR_INVALID_STATE);
    assert(request()==ESP_ERR_INVALID_STATE);cp_mqtt_wss_end_memory_work();assert(*s_io);
    assert(cp_mqtt_wss_allocation_ready(3841,0)&&s_memory_work);
    assert(cp_mqtt_wss_upload_ready(true));assert(!cp_mqtt_wss_upload_ready(false));
    cp_mqtt_wss_end_memory_work();assert(*s_io);assert(!cp_mqtt_wss_upload_ready(true));
    heap_free=24000;assert(!cp_mqtt_wss_encode_ready(0)&&!s_memory_work&&*s_io);
    assert(!cp_mqtt_wss_allocation_ready(3841,0)&&!s_memory_work&&*s_io);heap_free=100000;
    heap_largest=CP_MQTT_HOT_LARGEST-1;assert(!cp_mqtt_wss_allocation_ready(3841,0)&&*s_io);heap_largest=50000;
    io_take_fail=true;assert(!cp_mqtt_wss_encode_ready(20)&&!s_memory_work&&*s_io);io_take_fail=false;
    /* Gate selection is exact: unrelated transports never poll or take it. */
    unsigned reads=transport_reads,writes=transport_writes,polls=transport_polls;
    assert(cp_mqtt_wss_encode_ready(0));
    assert(__wrap_esp_transport_read((void *)1,NULL,0,10)==1);
    assert(__wrap_esp_transport_write((void *)1,NULL,0,10)==1);
    assert(transport_reads==reads+1&&transport_writes==writes+1&&transport_polls==polls);
    cp_mqtt_wss_end_memory_work();
    transport_readable=0;assert(__wrap_esp_transport_read(s_tls,NULL,0,12000)==0&&*s_io);
    assert(transport_reads==reads+1);
    /* Cold HTTP upgrade must retain the caller's wait, outside the IO gate. */
    transport_ready_after_wait=true;
    assert(__wrap_esp_transport_read(s_tls,NULL,0,12000)==1&&*s_io);
    assert(transport_reads==reads+2);transport_ready_after_wait=false;transport_readable=-1;
    assert(__wrap_esp_transport_read(s_tls,NULL,0,12000)==ERR_TCP_TRANSPORT_CONNECTION_FAILED&&*s_io);
    transport_readable=1;
    for(int result=-3;result<=1;++result){transport_result=result;
        assert(__wrap_esp_transport_read(s_tls,NULL,0,12000)==result&&*s_io);
        assert(__wrap_esp_transport_write(s_tls,NULL,0,12000)==result&&*s_io);}
    transport_result=1;
    io_take_fail=true;assert(__wrap_esp_transport_read(s_tls,NULL,0,1)==ERR_TCP_TRANSPORT_NO_MEM);
    assert(__wrap_esp_transport_write(s_tls,NULL,0,1)==ERR_TCP_TRANSPORT_NO_MEM);io_take_fail=false;
}
#if CONFIG_CP_NETWORK_MQTT_NATIVE_TLS
static void native_config_checks(void){
    const char *invalid_uri[]={"","wss://gateway.example/mqtt","mqtts://user:secret@broker.example",
        "mqtts://broker.example:8883/mqtt","mqtts://broker.example?secret=1"};
    unsigned calls=init_calls;
    for(unsigned i=0;i<sizeof(invalid_uri)/sizeof(*invalid_uri);++i){
        strcpy(settings.mqtt_uri,invalid_uri[i]);assert(request()==ESP_ERR_INVALID_ARG);
        assert(init_calls==calls&&!s_lease.client&&!s_tls);
    }
    strcpy(settings.mqtt_uri,CP_MQTT_PRODUCTION_URI);
    settings.mqtt_username[0]=0;assert(request()==ESP_ERR_INVALID_ARG&&init_calls==calls);
    memset(settings.mqtt_username,'x',sizeof settings.mqtt_username);
    assert(request()==ESP_ERR_INVALID_ARG&&init_calls==calls);
    strcpy(settings.mqtt_username,"synthetic-broker-user");
    settings.mqtt_password[0]=0;assert(request()==ESP_ERR_INVALID_ARG&&init_calls==calls);
    memset(settings.mqtt_password,'x',sizeof settings.mqtt_password);
    assert(request()==ESP_ERR_INVALID_ARG&&init_calls==calls);
    strcpy(settings.mqtt_password,"bad\nsecret");assert(request()==ESP_ERR_INVALID_ARG&&init_calls==calls);
    strcpy(settings.mqtt_password,"synthetic-broker-password");
    strcpy(settings.mqtt_namespace,"bad/namespace");assert(request()==ESP_ERR_INVALID_ARG&&init_calls==calls);
    strcpy(settings.mqtt_namespace,"fixture_pool");
}
#endif
int main(void){
#if CONFIG_CP_NETWORK_MQTT_NATIVE_TLS
    native_config_checks();
#endif
    mutex_fail=true;assert(request()==ESP_ERR_NO_MEM&&!s_lease.client&&!s_memory_work);mutex_fail=false;
    assert(request()==ESP_OK);assert(starts==1&&cp_mqtt_wss_established());
    memory_gate_checks();
    concurrent_gate_checks();
    control_request("contact");control_request("config");control_request("activation");assert(starts==1);
    ack_first=true;assert(request()==ESP_OK&&starts==1);assert(cp_mqtt_wss_encode_ready(0));cp_mqtt_wss_end_memory_work();
    /* App-only timeout preserves TLS; its late exact topic cannot match next RPC. */
    reply_enabled=false;assert(request()==ESP_ERR_TIMEOUT&&starts==1&&cp_mqtt_wss_established());
    reply_enabled=true;delayed_response=true;assert(request()==ESP_OK&&starts==1);
    delayed_response=false;
    /* One absolute deadline starts before direct publish, not after it. */
    publish_delay=21000;uint64_t before=clock_ms;assert(request()==ESP_ERR_TIMEOUT);
    assert(clock_ms-before==21000&&starts==1);publish_delay=0;
    /* Missing PUBACK retains an owned SDK copy only until confirmed cleanup. */
    puback_enabled=false;assert(request()==ESP_ERR_TIMEOUT&&!s_lease.client);puback_enabled=true;
    assert(request()==ESP_OK&&starts==2);clean();
    disconnect_after_reply=true;assert(request()==ESP_OK&&!s_lease.client);disconnect_after_reply=false;
    heap_free=CP_MQTT_COLD_FREE-1;assert(request()==ESP_ERR_NO_MEM&&!s_lease.client);heap_free=100000;
    init_oom=true;assert(request()==ESP_ERR_NO_MEM&&!s_lease.client);init_oom=false;
#if !CONFIG_CP_NETWORK_MQTT_NATIVE_TLS
    headers_oom=true;assert(request()==ESP_ERR_NO_MEM&&!s_lease.client);headers_oom=false;
#endif
    tls_missing=true;assert(request()!=ESP_OK&&!s_lease.client&&!s_tls);tls_missing=false;
    start_fail=true;assert(request()==ESP_FAIL&&!s_lease.client);start_fail=false;
    subscribe_fail=true;assert(request()!=ESP_OK&&!s_lease.client);subscribe_fail=false;
    bad_suback=true;assert(request()!=ESP_OK&&!s_lease.client);bad_suback=false;
    malloc_fail=0;assert(request()==ESP_ERR_NO_MEM&&s_lease.client);malloc_fail=-1;clean();
    assert(request()==ESP_OK);heap_free=20000;assert(!cp_mqtt_wss_encode_ready(0)&&*s_io);heap_free=100000;
    esp_mqtt_event_t disconnected={0};event_emit(s_lease.client,MQTT_EVENT_DISCONNECTED,&disconnected);
    assert(request()==ESP_OK);clean();
    /* Unknown stop retains callback storage/outbox; late callback is safe and
     * a late confirmed stop can subsequently finish cleanup exactly once. */
    assert(request()==ESP_OK);stop_hang=true;unsigned d=destroys;
    assert(cp_mqtt_wss_stop()==ESP_ERR_TIMEOUT&&s_lease.retained&&destroys==d);
    assert(!cp_mqtt_wss_memory_safe()&&request()!=ESP_OK);
    assert(!cp_mqtt_wss_encode_ready(0)&&!cp_mqtt_wss_allocation_ready(3841,0)&&*s_io);
    esp_mqtt_event_t late={.msg_id=77};event_emit(s_lease.client,MQTT_EVENT_PUBLISHED,&late);
    stop_hang=false;stop_task(NULL);
    assert(healthy()); /* SDK stop can succeed without DISCONNECTED. */
    cp_mqtt_wss_idle(true);
    assert(!s_lease.client&&!s_lease.retained&&destroys==d+1);
    assert(cp_mqtt_wss_memory_safe());clean();assert(destroys==d+1);
    /* Admission also completes a late success, without depending on idle. */
    assert(request()==ESP_OK);stop_hang=true;d=destroys;
    assert(cp_mqtt_wss_stop()==ESP_ERR_TIMEOUT&&s_lease.retained);
    stop_hang=false;stop_task(NULL);assert(healthy());
    assert(cp_mqtt_wss_memory_safe()&&!s_lease.client&&destroys==d+1);
    /* OOM creating the bounded stop worker retains every resource too. */
    assert(request()==ESP_OK);task_oom=true;d=destroys;
    assert(cp_mqtt_wss_stop()==ESP_ERR_NO_MEM&&s_lease.retained&&destroys==d);
    task_oom=false;assert(esp_mqtt_client_stop(s_lease.client)==ESP_OK);
    s_lease.started=false;s_lease.retained=false;clean();
    /* Explicit stop failure is terminal for this lease, never destroy/reset. */
    assert(request()==ESP_OK);stop_fail=true;d=destroys;
    assert(cp_mqtt_wss_stop()!=ESP_OK&&s_lease.retained&&destroys==d);
    assert(!cp_mqtt_wss_memory_safe());stop_fail=false;
    /* Test harness alone recovers the intentionally retained object at exit. */
    assert(esp_mqtt_client_stop(s_lease.client)==ESP_OK);s_lease.started=false;s_lease.retained=false;clean();
    assert(allocations>0&&publications>10);
    if(CONFIG_CP_NETWORK_MQTT_NATIVE_TLS)assert(!ws_headers&&!ws_lookups);
    else assert(ws_headers>0&&ws_lookups>0);
    printf("mqtt %s adapter timeout/reuse/OOM/reconnect/late-callback/lifetime passed; host_state_bytes=%zu\n",
        CONFIG_CP_NETWORK_MQTT_NATIVE_TLS?"native TLS":"WSS",sizeof(s));
}
