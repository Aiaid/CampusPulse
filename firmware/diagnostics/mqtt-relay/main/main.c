/* Synthetic bounded MQTT/TLS relay diagnostic. Never links journal or collector. */
#include <inttypes.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/time.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "cJSON.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_random.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "mbedtls/base64.h"
#include "mbedtls/sha256.h"
#include "mqtt_client.h"
#include "mqtt_config.h"

#if !CONFIG_MBEDTLS_HAVE_TIME || !CONFIG_MBEDTLS_HAVE_TIME_DATE
#error "MQTT diagnostic requires TLS certificate time and date verification"
#endif
#if CONFIG_ESP_TLS_INSECURE || CONFIG_ESP_WIFI_NVS_ENABLED || CONFIG_ESP_PHY_CALIBRATION_AND_DATA_STORAGE || CONFIG_BT_ENABLED
#error "MQTT diagnostic requires strict TLS, no Wi-Fi/PHY NVS writes, and BLE disabled"
#endif

#define PROTOCOL "campuspulse-mqtt-relay/1"
#define HEAP_CAPS (MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT)
#define RX_CAP (18*1024)
#define RESPONSE_CAP (12*1024)
#define RETRY_US 15000000LL
extern esp_err_t mqtt_wifi_start_saved(uint32_t timeout_ms);
static esp_mqtt_client_handle_t client;
static int64_t experiment_start;
static bool accepting=true, connected, subscribed;
static unsigned attempts, connects, disconnects, subacks, pubacks, errors, rx_overflow, rx_busy, rx_invalid;
static int last_error, last_tls, last_flags, last_errno;
static int subscription_id=-1;
static unsigned subscription_failures;
static char rx[RX_CAP+1];
static size_t rx_used, rx_total;
static bool rx_assembling, rx_ready;
static int64_t rx_time;
static unsigned char response[RESPONSE_CAP+1];
static char canonical[4*((RESPONSE_CAP+2)/3)+1];
typedef struct {
    const char *op;
    char id[37], sha[65];
    char *bytes;
    unsigned sends, verified, relay_errors, upstream_failures, rejected;
    int64_t first_send, last_send, verified_us;
    bool durable;
} request_t;
static request_t requests[2];

static unsigned counter(const unsigned *p) { return __atomic_load_n(p,__ATOMIC_RELAXED); }
static void increment(unsigned *p) { __atomic_add_fetch(p,1,__ATOMIC_RELAXED); }
static bool flag(const bool *p) { return __atomic_load_n(p,__ATOMIC_ACQUIRE); }
static void set_flag(bool *p,bool value) { __atomic_store_n(p,value,__ATOMIC_RELEASE); }

static bool digest(const void *body,size_t length,char output[65])
{
    unsigned char sha[32];
    if (mbedtls_sha256(body,length,sha,0)) return false;
    static const char hex[]="0123456789abcdef";
    for (unsigned i=0;i<32;++i) { output[2*i]=hex[sha[i]>>4]; output[2*i+1]=hex[sha[i]&15]; }
    output[64]=0; return true;
}
static bool equals(const cJSON *o,const char *key,const char *expected)
{
    const cJSON *v=cJSON_GetObjectItemCaseSensitive(o,key);
    return cJSON_IsString(v) && v->valuestring && !strcmp(v->valuestring,expected);
}
static bool unique(const cJSON *o,unsigned depth)
{
    if (depth>12) return false;
    for (const cJSON *a=o->child;a;a=a->next) {
        if (cJSON_IsObject(o)) for (const cJSON *b=a->next;b;b=b->next)
            if (!a->string || !b->string || !strcmp(a->string,b->string)) return false;
        if (!unique(a,depth+1)) return false;
    }
    return true;
}
static cJSON *parse(const char *text,size_t length)
{
    if (!length || memchr(text,0,length)) return NULL;
    unsigned depth=0; bool quoted=false,escaped=false;
    for (size_t i=0;i<length;++i) {
        if (i+6<=length && !memcmp(text+i,"\\u0000",6)) return NULL;
        char c=text[i];
        if (quoted) { if (escaped) escaped=false; else if (c=='\\') escaped=true; else if (c=='"') quoted=false; }
        else if (c=='"') quoted=true;
        else if (c=='{' || c=='[') { if (++depth>12) return NULL; }
        else if (c=='}' || c==']') { if (!depth) return NULL; --depth; }
    }
    if (quoted || depth) return NULL;
    const char *end=NULL;
    cJSON *o=cJSON_ParseWithLengthOpts(text,length,&end,false);
    if (!o) return NULL;
    while (end<text+length && (*end==' ' || *end=='\r' || *end=='\n' || *end=='\t')) ++end;
    if (end!=text+length || !cJSON_IsObject(o) || !unique(o,0)) { cJSON_Delete(o); return NULL; }
    return o;
}
static bool exact_keys(const cJSON *o,const char *const *keys,size_t count)
{
    size_t seen=0;
    for (const cJSON *v=o->child;v;v=v->next) {
        bool found=false;
        for (size_t i=0;i<count;++i) if (v->string && !strcmp(v->string,keys[i])) found=true;
        if (!found) return false;
        ++seen;
    }
    return seen==count;
}
static bool timestamp(const char *s)
{
    if (!s || strlen(s)!=24 || s[4]!='-' || s[7]!='-' || s[10]!='T' || s[13]!=':' ||
        s[16]!=':' || s[19]!='.' || s[23]!='Z') return false;
    for (unsigned i=0;i<23;++i) if (i!=4 && i!=7 && i!=10 && i!=13 && i!=16 && i!=19 &&
        (s[i]<'0' || s[i]>'9')) return false;
    unsigned year=0,month=0,day=0,hour=0,minute=0,second=0,millisecond=0;
    if (sscanf(s,"%4u-%2u-%2uT%2u:%2u:%2u.%3uZ",&year,&month,&day,&hour,&minute,&second,&millisecond)!=7 ||
        year<2020 || month<1 || month>12 || day<1 || hour>23 || minute>59 || second>59) return false;
    static const unsigned days[]={31,28,31,30,31,30,31,31,30,31,30,31};
    unsigned maximum=days[month-1]+(month==2 && year%4==0 && (year%100!=0 || year%400==0));
    return day<=maximum;
}
static bool expected_ack(const char *text,size_t length)
{
    cJSON *ack=parse(text,length), *expected=parse(cfg_expected_ack,strlen(cfg_expected_ack));
    static const char *const keys[]={"node_id","boot_id","stream","batch_id","body_sha256","accepted_count","durability","receipt_id","received_at"};
    bool valid=ack && expected && exact_keys(ack,keys,9);
    if (valid) for (const cJSON *e=expected->child;e;e=e->next) {
        const cJSON *v=cJSON_GetObjectItemCaseSensitive(ack,e->string);
        if (cJSON_IsString(e)) valid=equals(ack,e->string,e->valuestring);
        else valid=cJSON_IsNumber(e) && cJSON_IsNumber(v) && e->valuedouble==v->valuedouble;
        if (!valid) break;
    }
    const cJSON *receipt=cJSON_GetObjectItemCaseSensitive(ack,"receipt_id");
    const cJSON *received=cJSON_GetObjectItemCaseSensitive(ack,"received_at");
    valid=valid && cJSON_IsString(receipt) && receipt->valuestring[0] && strlen(receipt->valuestring)<128
        && cJSON_IsString(received) && timestamp(received->valuestring);
    cJSON_Delete(ack); cJSON_Delete(expected); return valid;
}

static void event(void *arg,esp_event_base_t base,int32_t id,void *data)
{
    (void)arg; (void)base;
    esp_mqtt_event_handle_t e=data;
    switch (id) {
    case MQTT_EVENT_BEFORE_CONNECT: increment(&attempts); break;
    case MQTT_EVENT_CONNECTED:
        increment(&connects); set_flag(&connected,true); set_flag(&subscribed,false);
        if (flag(&accepting)) {
            subscription_id=esp_mqtt_client_subscribe(client,cfg_reply_topic,1);
            if (subscription_id<0) { increment(&errors); increment(&subscription_failures); }
        }
        break;
    case MQTT_EVENT_DISCONNECTED:
        increment(&disconnects); set_flag(&connected,false); set_flag(&subscribed,false); break;
    case MQTT_EVENT_SUBSCRIBED:
        // IDF emits SUBSCRIBED even for a failed broker grant (0x80).
        if (e->msg_id==subscription_id && e->data && e->data_len==1 &&
            (unsigned char)e->data[0]==1 && e->error_handle &&
            e->error_handle->error_type==MQTT_ERROR_TYPE_NONE) {
            increment(&subacks); set_flag(&subscribed,true);
        } else { increment(&subscription_failures); increment(&errors); set_flag(&subscribed,false); }
        break;
    case MQTT_EVENT_PUBLISHED: increment(&pubacks); break;
    case MQTT_EVENT_ERROR:
        increment(&errors);
        if (e->error_handle) {
            __atomic_store_n(&last_error,e->error_handle->error_type,__ATOMIC_RELAXED);
            __atomic_store_n(&last_tls,e->error_handle->esp_tls_stack_err,__ATOMIC_RELAXED);
            __atomic_store_n(&last_flags,e->error_handle->esp_tls_cert_verify_flags,__ATOMIC_RELAXED);
            __atomic_store_n(&last_errno,e->error_handle->esp_transport_sock_errno,__ATOMIC_RELAXED);
        }
        break;
    case MQTT_EVENT_DATA:
        if (!flag(&accepting)) break;
        if (flag(&rx_ready)) { increment(&rx_busy); break; }
        if (e->current_data_offset==0) {
            rx_used=0; rx_total=0; rx_assembling=false;
            if (!e->topic || e->topic_len!=(int)strlen(cfg_reply_topic) ||
                memcmp(e->topic,cfg_reply_topic,e->topic_len) || e->retain) { increment(&rx_invalid); break; }
            if (e->total_data_len<=0 || e->total_data_len>RX_CAP) { increment(&rx_overflow); break; }
            rx_total=(size_t)e->total_data_len; rx_assembling=true;
        }
        if (!rx_assembling) break;
        if (e->data_len<0 || e->current_data_offset<0 || (size_t)e->current_data_offset!=rx_used ||
            e->total_data_len!=(int)rx_total || (size_t)e->data_len>rx_total-rx_used) {
            rx_assembling=false; increment(&rx_invalid); break;
        }
        memcpy(rx+rx_used,e->data,(size_t)e->data_len); rx_used+=(size_t)e->data_len;
        if (rx_used==rx_total) {
            rx[rx_used]=0; rx_time=esp_timer_get_time(); rx_assembling=false; set_flag(&rx_ready,true);
        }
        break;
    default: break;
    }
}

static bool prepare(request_t *r,const char *op,const char *body_base64,const char *sha)
{
    r->op=op; memcpy(r->sha,sha,65);
    unsigned char uuid[16]; esp_fill_random(uuid,sizeof uuid);
    uuid[6]=(uuid[6]&15)|0x40; uuid[8]=(uuid[8]&63)|0x80;
    snprintf(r->id,sizeof r->id,"%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
        uuid[0],uuid[1],uuid[2],uuid[3],uuid[4],uuid[5],uuid[6],uuid[7],uuid[8],uuid[9],uuid[10],uuid[11],uuid[12],uuid[13],uuid[14],uuid[15]);
    cJSON *o=cJSON_CreateObject();
    if (!o) return false;
    bool ok=cJSON_AddStringToObject(o,"protocol",PROTOCOL) && cJSON_AddStringToObject(o,"request_id",r->id)
        && cJSON_AddStringToObject(o,"op",op) && cJSON_AddStringToObject(o,"body_base64",body_base64)
        && cJSON_AddStringToObject(o,"body_sha256",sha);
    if (ok) r->bytes=cJSON_PrintUnformatted(o);
    cJSON_Delete(o); return r->bytes!=NULL;
}

static void receive(request_t *r)
{
    cJSON *o=parse(rx,rx_used);
    bool match=o && equals(o,"protocol",PROTOCOL) && equals(o,"request_id",r->id)
        && equals(o,"op",r->op) && equals(o,"request_sha256",r->sha);
    if (!match) { ++r->rejected; cJSON_Delete(o); return; }
    static const char *const error_keys[]={"protocol","request_id","op","request_sha256","kind","code"};
    if (equals(o,"kind","relay_error") && exact_keys(o,error_keys,6)) {
        ++r->relay_errors; cJSON_Delete(o); return;
    }
    static const char *const reply_keys[]={"protocol","request_id","op","request_sha256","kind","status","body_base64","response_sha256"};
    const cJSON *status=cJSON_GetObjectItemCaseSensitive(o,"status"), *body=cJSON_GetObjectItemCaseSensitive(o,"body_base64");
    bool ok=equals(o,"kind","upstream_response") && exact_keys(o,reply_keys,8)
        && cJSON_IsNumber(status) && status->valuedouble>=100 && status->valuedouble<=599
        && status->valuedouble==(double)status->valueint && cJSON_IsString(body);
    size_t decoded=0,encoded=0;
    if (ok) ok=mbedtls_base64_decode(response,RESPONSE_CAP,&decoded,(unsigned char *)body->valuestring,strlen(body->valuestring))==0;
    // Re-encoding enforces canonical RFC4648 including padding and no whitespace.
    if (ok) ok=mbedtls_base64_encode((unsigned char *)canonical,sizeof canonical,&encoded,response,decoded)==0
        && encoded==strlen(body->valuestring) && !memcmp(canonical,body->valuestring,encoded);
    char hash[65];
    if (ok) ok=digest(response,decoded,hash) && equals(o,"response_sha256",hash);
    if (!ok) ++r->rejected;
    else if (status->valueint!=200) ++r->upstream_failures;
    else if (!strcmp(r->op,"ingest") && !expected_ack((char *)response,decoded)) ++r->rejected;
    else if (!strcmp(r->op,"health")) {
        cJSON *health=parse((char *)response,decoded);
        if (!health || !equals(health,"status","ok") || !equals(health,"ingestion","implemented")) ++r->rejected;
        else { ++r->verified; r->verified_us=rx_time-r->first_send;
            printf("MQTT_REPLY op=health verified=1 cloud_durable=0 status=200 elapsed_us=%"PRId64" response_bytes=%u\n",
                r->verified_us,(unsigned)decoded); }
        cJSON_Delete(health);
    }
    else {
        ++r->verified; r->verified_us=rx_time-r->first_send; r->durable=!strcmp(r->op,"ingest");
        printf("MQTT_REPLY op=%s verified=1 cloud_durable=%u status=200 elapsed_us=%"PRId64" response_bytes=%u\n",
            r->op,r->durable,r->verified_us,(unsigned)decoded);
    }
    memset(response,0,sizeof response); memset(canonical,0,sizeof canonical); cJSON_Delete(o);
}

static void snapshot(const char *phase)
{
    unsigned n=counter(&connects);
    printf("MQTT_STATE phase=%s elapsed_us=%"PRId64" attempts=%u connects=%u reconnects=%u disconnects=%u "
        "subacks=%u subscription_failures=%u qos1_pubacks=%u errors=%u tls_error=%d tls_flags=%d socket_errno=%d error_type=%d "
        "rx_overflow=%u rx_busy=%u rx_invalid=%u free=%u minimum=%u largest=%u\n",
        phase,esp_timer_get_time()-experiment_start,counter(&attempts),n,n?n-1:0,counter(&disconnects),
        counter(&subacks),counter(&subscription_failures),counter(&pubacks),counter(&errors),__atomic_load_n(&last_tls,__ATOMIC_RELAXED),
        __atomic_load_n(&last_flags,__ATOMIC_RELAXED),__atomic_load_n(&last_errno,__ATOMIC_RELAXED),
        __atomic_load_n(&last_error,__ATOMIC_RELAXED),counter(&rx_overflow),counter(&rx_busy),counter(&rx_invalid),
        (unsigned)heap_caps_get_free_size(HEAP_CAPS),(unsigned)heap_caps_get_minimum_free_size(HEAP_CAPS),
        (unsigned)heap_caps_get_largest_free_block(HEAP_CAPS));
}
static void idle(void)
{
    set_flag(&accepting,false);
    // No stop/destroy/reinit: MQTT owns its live task, outbox and TLS state until hardware reset.
    snapshot("final");
    for (unsigned i=0;i<1+CP_MQTT_HAS_FIXTURE;++i) {
        request_t *r=&requests[i];
        printf("MQTT_RESULT op=%s sends=%u verified_replies=%u cloud_durable=%u relay_errors=%u upstream_failures=%u rejected=%u elapsed_us=%"PRId64"\n",
            r->op?r->op:"unprepared",r->sends,r->verified,r->durable,r->relay_errors,r->upstream_failures,r->rejected,r->verified_us);
    }
    printf("MQTT_DONE synthetic=1 ble=0 journal=0 reclaimed=0 idle=1 auto_restart=0 runtime_retained=1 "
        "full_deinit=0 application_requests_stopped=1 mqtt_protocol_runtime_may_continue=1\n");
    for (;;) vTaskDelay(pdMS_TO_TICKS(1000));
}
void app_main(void)
{
    esp_log_level_set("*",ESP_LOG_NONE);
    experiment_start=esp_timer_get_time();
    printf("MQTT_BOOT schema=1 reset_reason=%u synthetic=1 ble=0 ca_verify=1 name_verify=1 date_verify=1 "
        "deadline_ms=%u immutable_retry=1 runtime_retained=1\n",(unsigned)esp_reset_reason(),CP_MQTT_DEADLINE_MS);
    struct timeval now={.tv_sec=CP_MQTT_UNIX_TIME};
    if (settimeofday(&now,NULL)) { printf("MQTT_CLOCK ok=0\n"); idle(); }
    char empty_sha[65];
    if (!digest("",0,empty_sha) || !prepare(&requests[0],"health","",empty_sha) ||
        (CP_MQTT_HAS_FIXTURE && !prepare(&requests[1],"ingest",cfg_body_base64,cfg_body_sha256))) {
        printf("MQTT_PREPARE ok=0\n"); idle();
    }
    const int64_t deadline=experiment_start+(int64_t)CP_MQTT_DEADLINE_MS*1000;
    esp_err_t err=mqtt_wifi_start_saved(CP_MQTT_DEADLINE_MS<60000?CP_MQTT_DEADLINE_MS:60000);
    printf("MQTT_WIFI saved_only=1 nvs_readonly=1 ram_storage=1 ok=%u err=%d\n",err==ESP_OK,err);
    if (err!=ESP_OK || esp_timer_get_time()>=deadline) idle();
    const esp_mqtt_client_config_t cfg={
        .broker.address.uri=cfg_broker_uri,
        .broker.verification={.certificate=cfg_ca_pem,.skip_cert_common_name_check=false},
        .credentials={.client_id=cfg_client_id,.username=cfg_username,.authentication.password=cfg_password},
        .session={.keepalive=30,.protocol_ver=MQTT_PROTOCOL_V_3_1_1,.message_retransmit_timeout=15000},
        .network={.disable_auto_reconnect=true,.timeout_ms=8000},
        .task={.stack_size=6144,.priority=5},.buffer={.size=1024,.out_size=1024},.outbox.limit=40000,
    };
    client=esp_mqtt_client_init(&cfg);
    if (!client) { printf("MQTT_ALLOC ok=0\n"); idle(); }
    err=esp_mqtt_client_register_event(client,ESP_EVENT_ANY_ID,event,NULL);
    if (err==ESP_OK) err=esp_mqtt_client_start(client);
    printf("MQTT_START ok=%u err=%d\n",err==ESP_OK,err);
    if (err!=ESP_OK) idle();
    unsigned active=0;
    int64_t next_reconnect=esp_timer_get_time()+10000000LL,next_report=esp_timer_get_time()+10000000LL;
    while (esp_timer_get_time()<deadline && active<1+CP_MQTT_HAS_FIXTURE) {
        request_t *r=&requests[active];
        int64_t tick=esp_timer_get_time();
        if (flag(&rx_ready)) {
            receive(r); memset(rx,0,rx_used); set_flag(&rx_ready,false);
            if (r->verified) { ++active; continue; }
        }
        if (flag(&subscribed) && (!r->last_send || tick-r->last_send>=RETRY_US)) {
            // Never rebuild UUID/body/hash; retry exact same envelope; QoS1 and application reply are separate.
            int msg_id=esp_mqtt_client_enqueue(client,cfg_request_topic,r->bytes,(int)strlen(r->bytes),1,0,true);
            if (msg_id>=0) { if (!r->sends) r->first_send=tick; ++r->sends; r->last_send=tick; }
            else { increment(&errors); r->last_send=tick; }
            printf("MQTT_SEND op=%s accepted=%u send=%u envelope_bytes=%u\n",r->op,msg_id>=0,r->sends,(unsigned)strlen(r->bytes));
        }
        if (!flag(&connected) && tick>=next_reconnect) {
            esp_err_t reconnect=esp_mqtt_client_reconnect(client);
            if (reconnect!=ESP_OK) increment(&errors);
            next_reconnect=tick+10000000LL;
        }
        if (tick>=next_report) { snapshot("running"); next_report=tick+10000000LL; }
        vTaskDelay(pdMS_TO_TICKS(20));
    }
    idle();
}
