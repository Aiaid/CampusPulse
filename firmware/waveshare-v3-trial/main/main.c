/* Bounded, board-owned v3 acceptance image. Every boot waits for physical USB
 * bootstrap. No v2 runtime, raw writer or host-translated observations. */
#include "trial_bootstrap.h"
#include "cp_v3_control.h"
#include "cp_v3_queue.h"
#include "cp_v3_transport.h"
#include "raw_board.h"
#include "raw_power.h"
#include "raw_battery.h"
#include "raw_clock.h"
#include "raw_display.h"
#include "raw_v3_queue_store.h"
#include "raw_v3_queue_sd_sync.h"
#include "bootloader_random.h"
#include "esp_mac.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "esp_log.h"
#include "esp_heap_caps.h"
#include "nvs_flash.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/queue.h"
#include "host/ble_gap.h"
#include "host/ble_hs.h"
#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#include <stdio.h>
#include <string.h>
#include <time.h>
#include <inttypes.h>
#include <stdatomic.h>

#define REPORT_SLOTS 128u
typedef struct { uint8_t address[6],type,kind,status,report_type; uint16_t length; uint8_t payload[1650]; } report_t;
static const char *TAG="v3trial";
static cp_v3_control_t *s_control;
static cp_v3_control_workspace_t *s_workspace;
static cp_v3_queue_t *s_queue;
static cp_v3_window_t *s_window;
static raw_v3_queue_store_t *s_store;
static trial_bootstrap_t s_bootstrap;
static report_t *s_reports;
static char s_node[16],s_boot[37];
static char *s_reply,*s_body,*s_pending;
static QueueHandle_t s_free,s_ready;
static portMUX_TYPE s_lock=portMUX_INITIALIZER_UNLOCKED;
static uint64_t s_capture_start,s_capture_end;
static uint32_t s_seen,s_drops,s_callbacks;
static bool s_accept;
static _Atomic bool s_ble_synced,s_scanning,s_stop;
static _Atomic bool s_safe_shutdown,s_display_asleep;
static bool s_ble_initialized;
static bool s_transport_started;
static bool s_display_started;
static raw_display_snapshot_t s_display;
static uint32_t s_acked,s_uploaded_bytes,s_writes,s_failed_uploads,s_bad_acks;
static uint32_t s_feature_acked,s_status_acked,s_windows_closed;
static bool s_retry_tested;

static void uuid4(char out[37]) {
    uint8_t b[16]; esp_fill_random(b,sizeof b); b[6]=(b[6]&15)|64; b[8]=(b[8]&63)|128;
    snprintf(out,37,"%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
        b[0],b[1],b[2],b[3],b[4],b[5],b[6],b[7],b[8],b[9],b[10],b[11],b[12],b[13],b[14],b[15]);
}
static bool entropy(void *ctx,uint8_t out[16]) { (void)ctx; esp_fill_random(out,16); return true; }
static void phase(const char *name) {
    portENTER_CRITICAL(&s_lock); snprintf(s_display.state,sizeof s_display.state,"%s",name); portEXIT_CRITICAL(&s_lock);
    ESP_LOGI(TAG,"phase=%s internal=%u largest=%u psram=%u stack=%u",name,
        (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL|MALLOC_CAP_8BIT),
        (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL|MALLOC_CAP_8BIT),
        (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM),
        (unsigned)uxTaskGetStackHighWaterMark(NULL));
}
static void display_task(void *unused) {
    (void)unused; bool ready=raw_display_init()==ESP_OK; (void)raw_battery_init();
    for (;;) {
        if(s_stop&&s_safe_shutdown){if(ready)(void)raw_display_sleep();s_display_asleep=true;vTaskDelete(NULL);}
        raw_display_snapshot_t snap; portENTER_CRITICAL(&s_lock);snap=s_display;portEXIT_CRITICAL(&s_lock);
        snap.uptime_s=(uint64_t)esp_timer_get_time()/1000000u;
        raw_battery_sample_t bat;
        if(raw_battery_read(&bat)==ESP_OK&&bat.known){snap.battery_known=true;snap.battery_mv=bat.millivolts;snap.battery_percent=bat.estimated_percent;}
        snap.memory_known=true;snap.internal_total=heap_caps_get_total_size(MALLOC_CAP_INTERNAL|MALLOC_CAP_8BIT);snap.internal_free=heap_caps_get_free_size(MALLOC_CAP_INTERNAL|MALLOC_CAP_8BIT);
        snap.psram_known=true;snap.psram_total=heap_caps_get_total_size(MALLOC_CAP_SPIRAM);snap.psram_free=heap_caps_get_free_size(MALLOC_CAP_SPIRAM);
        if(ready)(void)raw_display_present(&snap);
        vTaskDelay(pdMS_TO_TICKS(2000));
    }
}
static void key_task(void *unused) {
    (void)unused;unsigned held=0;bool armed=false;
    for(;;){if(!raw_power_pressed()){armed=true;held=0;}else if(armed&&++held>=50){s_stop=true;cp_v3_transport_cancel();}
        if(s_stop&&s_safe_shutdown&&s_display_asleep&&!raw_power_pressed())(void)raw_power_shutdown();
        vTaskDelay(pdMS_TO_TICKS(20));}
}
static bool now(cp_v3_time_t *out){return cp_v3_transport_time(out)==ESP_OK;}
static bool cancelled(void){return s_stop;}
static _Noreturn void startup_fault(bool power_ready,const char *reason) {
    ESP_LOGE(TAG,"startup_failed=%s",reason);phase("V3 START FAILED");
    bool armed=false;unsigned held=0;
    /* This task becomes the PWR fallback; it never returns into FreeRTOS and
     * requires no new task allocation on an allocation-failure path. */
    for(;;){
        if(power_ready){
            bool pressed=raw_power_pressed();if(!pressed){armed=true;held=0;}else if(armed&&++held>=50){s_stop=true;s_safe_shutdown=true;}
            if(s_stop&&!pressed&&(!s_display_started||s_display_asleep))(void)raw_power_shutdown();
        }
        vTaskDelay(pdMS_TO_TICKS(20));
    }
}
static void iso(uint64_t ms,char out[25]){time_t sec=(time_t)(ms/1000);struct tm t;gmtime_r(&sec,&t);
    if(strftime(out,20,"%Y-%m-%dT%H:%M:%S",&t)!=19){out[0]=0;return;}
    snprintf(out+19,6,".%03uZ",(unsigned)(ms%1000));}
static size_t capabilities(char *out,size_t cap,uint64_t utc) {
    char issued[25],expires[25],id[37];iso(utc-5000,issued);iso(utc+1800000,expires);uuid4(id);
    int n=snprintf(out,cap,"{\"schema\":\"device-capabilities/1\",\"capability_id\":\"trial-%s\",\"node_id\":\"%s\",\"boot_id\":\"%s\",\"producer_version\":\"cp-v3-producer/1\",\"policy_schemas\":[\"device-config/3\"],\"issued_at\":\"%s\",\"expires_at\":\"%s\","
        "\"scanner\":{\"modes\":[\"passive\"],\"phys\":[\"1m\"],\"duplicate_filter\":[false],\"min_interval_units\":4,\"max_interval_units\":16384},\"local_raw\":null,"
        "\"resources\":{\"max_working_bytes\":2097152,\"max_storage_write_bytes_per_day\":16777216,\"tf_usable_bytes\":262144},"
        "\"summary\":{\"max_addresses\":8,\"max_bins\":10,\"max_window_ms\":10000},"
        "\"features\":{\"schemas\":[\"ble-feature-evidence/1\"],\"extractor_versions\":[\"cp-v3-ad/1\"],\"fields\":[\"company_ids\",\"appearance\"],\"populations\":[\"all_worker_reports\"],\"max_reports_per_window\":10000,\"max_bytes_per_window\":65536},"
        "\"uplink\":{\"transports\":[\"https\"],\"streams\":[\"feature_summaries\",\"node_status\"],\"max_batch_items\":1,\"max_body_bytes\":4096,\"max_sample_reports_per_window\":0,\"cpraw_archive\":false},"
        "\"queue\":{\"media\":[{\"medium\":\"tf_journal\",\"usable_bytes\":49152,\"max_items\":12,\"power_loss_recovery\":true}]}}",id,s_node,s_boot,issued,expires);
    return n>0&&(size_t)n<cap?(size_t)n:0;
}
static bool http(cp_v3_http_method_t method,const char *path,const void *body,size_t length,cp_v3_transport_response_t *response) {
    esp_err_t e=cp_v3_transport_request(method,path,body,length,s_reply,32768,response);
    if(e!=ESP_OK||!response->complete){ESP_LOGW(TAG,"request_error=%ld stage=%u io=%d dns=%d connected=%d read=%d write=%d rx=%u tx=%u tls_esp=%d tls_stack=%d verify=%d internal_free=%u largest=%u stack=%u",(long)e,(unsigned)response->stage,(int)response->io_error,(int)response->dns_error,(int)response->tls_connected,(int)response->last_read,(int)response->last_write,(unsigned)response->received_bytes,(unsigned)response->written_bytes,(int)response->tls_esp_error,(int)response->tls_stack_error,(int)response->tls_verify_flags,(unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL|MALLOC_CAP_8BIT),(unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL|MALLOC_CAP_8BIT),(unsigned)uxTaskGetStackHighWaterMark(NULL));return false;}
    if(response->http_status<200||response->http_status>=300){ESP_LOGW(TAG,"http_status=%d",response->http_status);return false;}
    return true;
}
static bool control_post(const char *path,const void *body,size_t length,cp_v3_transport_response_t *response) {
    for(unsigned attempt=0;attempt<3&&!s_stop;++attempt){
        if(http(CP_V3_HTTP_POST,path,body,length,response))return true;
        if(response->complete&&response->http_status<500&&response->http_status!=429)return false;
        vTaskDelay(pdMS_TO_TICKS(1000));
    }
    return false;
}
static void synced(void);
static void reset(int reason);
static void host(void *unused);
static cp_v3_apply_result_t apply(void *ctx,const cp_v3_trial_policy_t *p,cp_v3_boundary_t *boundary) {
    (void)ctx;
    if(boundary->window_open||boundary->segment_open||s_scanning)return CP_V3_APPLY_BOUNDARY_FAILED;
    if(!p->tf_queue||p->evidence.max_identifiers>8||p->queue_max_bytes!=49152||p->queue_max_items!=12||p->feature_reserve_items!=8||p->status_reserve_items!=2||p->control_reserve_items!=2||p->feature_reserve_bytes!=32768||p->status_reserve_bytes!=8192||p->control_reserve_bytes!=8192||p->working_bytes<1048576)return CP_V3_APPLY_RESOURCE_EXHAUSTED;
    if(!s_queue->ready||s_queue->retired_slots||s_queue->corrupt_slots)return CP_V3_APPLY_STORAGE_FAILED;
    uint64_t total,free;
    if(raw_storage_capacity(&total,&free)!=ESP_OK||free<1048576+262144)return CP_V3_APPLY_STORAGE_FAILED;
    if(!s_ble_initialized){
        if(nimble_port_init()!=ESP_OK)return CP_V3_APPLY_RESOURCE_EXHAUSTED;
        s_ble_initialized=true;ble_hs_cfg.sync_cb=synced;ble_hs_cfg.reset_cb=reset;nimble_port_freertos_init(host);
        for(unsigned i=0;i<500&&!s_ble_synced&&!s_stop;++i)vTaskDelay(pdMS_TO_TICKS(10));
        if(!s_ble_synced||s_stop)return CP_V3_APPLY_RESOURCE_EXHAUSTED;
    }
    if(heap_caps_get_free_size(MALLOC_CAP_INTERNAL|MALLOC_CAP_8BIT)<56000||heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL|MALLOC_CAP_8BIT)<20000)return CP_V3_APPLY_RESOURCE_EXHAUSTED;
    return CP_V3_APPLY_OK;
}
static int gap(struct ble_gap_event *ev,void *unused) {
    (void)unused;
    if(ev->type==BLE_GAP_EVENT_DISC_COMPLETE){s_scanning=false;return 0;}
    if(ev->type!=BLE_GAP_EVENT_DISC&&ev->type!=BLE_GAP_EVENT_EXT_DISC)return 0;
    uint64_t mono=(uint64_t)esp_timer_get_time()/1000;
    portENTER_CRITICAL(&s_lock);
    bool accepted=s_accept&&mono>=s_capture_start&&mono<s_capture_end;
    if(accepted){++s_seen;++s_callbacks;}
    portEXIT_CRITICAL(&s_lock);
    if(!accepted)return 0;
    uint16_t index;bool queued=false;
    unsigned length=ev->type==BLE_GAP_EVENT_DISC?ev->disc.length_data:ev->ext_disc.length_data;
    const uint8_t *data=ev->type==BLE_GAP_EVENT_DISC?ev->disc.data:ev->ext_disc.data;
    if(length<=1650&&(!length||data)&&xQueueReceive(s_free,&index,0)==pdTRUE){
        report_t *r=&s_reports[index];memset(r,0,offsetof(report_t,payload));r->length=length;
        if(ev->type==BLE_GAP_EVENT_DISC){r->type=ev->disc.addr.type;memcpy(r->address,ev->disc.addr.val,6);r->report_type=ev->disc.event_type==BLE_HCI_ADV_RPT_EVTYPE_SCAN_RSP?1:0;}
        else {r->kind=1;r->type=ev->ext_disc.addr.type;memcpy(r->address,ev->ext_disc.addr.val,6);r->status=ev->ext_disc.data_status;r->report_type=(ev->ext_disc.props&BLE_HCI_ADV_SCAN_RSP_MASK)?1:0;}
        if(length)memcpy(r->payload,data,length);
        queued=xQueueSend(s_ready,&index,0)==pdTRUE;if(!queued)(void)xQueueSend(s_free,&index,0);
    }
    portENTER_CRITICAL(&s_lock);if(!queued)++s_drops;--s_callbacks;portEXIT_CRITICAL(&s_lock);return 0;
}
static void synced(void){s_ble_synced=true;}
static void reset(int reason){ESP_LOGE(TAG,"ble_reset=%d",reason);s_stop=true;}
static void host(void *unused){(void)unused;nimble_port_run();nimble_port_freertos_deinit();}
static void consume(unsigned wait_ms) {
    uint16_t index;
    if(xQueueReceive(s_ready,&index,pdMS_TO_TICKS(wait_ms))!=pdTRUE)return;
    report_t *r=&s_reports[index];
    cp_v3_report_t report={.address_type=r->type,.kind=r->kind,.data_status=r->status,.report_type=r->report_type,.payload=r->payload,.length=r->length};memcpy(report.address,r->address,6);
    (void)cp_v3_window_observe(s_window,&report);memset(r,0,sizeof *r);(void)xQueueSend(s_free,&index,0);
}
static bool capture(uint32_t seq) {
    cp_v3_time_t start,end;
    if(!now(&start))return false;
    cp_v3_control_permissions_t permission=cp_v3_control_permissions(s_control,start);
    uint64_t growth=((uint64_t)s_control->policy.evidence.window_ms*500u+999999u)/1000000u;
    if(!permission.collection||start.mono_ms+s_control->policy.evidence.window_ms>=permission.deadline_mono_ms||
        start.utc_ms+start.uncertainty_ms+s_control->policy.evidence.window_ms+growth>=permission.deadline_utc_ms)return false;
    cp_v3_scope_t scope=s_control->policy.scope;scope.window_seq=seq;
    if(cp_v3_window_begin(s_window,&scope,&s_control->policy.evidence,start,entropy,NULL)!=CP_V3_OK)return false;
    portENTER_CRITICAL(&s_lock);s_seen=s_drops=0;s_capture_start=start.mono_ms;s_capture_end=start.mono_ms+s_control->policy.evidence.window_ms;s_accept=true;portEXIT_CRITICAL(&s_lock);
    struct ble_gap_ext_disc_params p={.itvl=s_control->policy.scan_interval_units,.window=s_control->policy.scan_window_units,.passive=1};
    if(ble_gap_ext_disc(BLE_OWN_ADDR_PUBLIC,0,0,0,0,0,&p,NULL,gap,NULL)){s_accept=false;return false;}
    s_scanning=true;phase("V3 COLLECT");
    bool expired=false;uint64_t last_check=start.mono_ms;
    while(!s_stop&&(uint64_t)esp_timer_get_time()/1000<s_capture_end){
        consume(10);
        uint64_t current=(uint64_t)esp_timer_get_time()/1000;
        if(current-last_check>=100){cp_v3_time_t t;if(!now(&t)||!cp_v3_control_permissions(s_control,t).collection){expired=true;break;}last_check=current;}
    }
    portENTER_CRITICAL(&s_lock);s_accept=false;portEXIT_CRITICAL(&s_lock);
    if(ble_gap_disc_active()&&ble_gap_disc_cancel())return false;
    bool callbacks_idle=false;
    for(unsigned i=0;i<1000;++i){portENTER_CRITICAL(&s_lock);callbacks_idle=s_callbacks==0;portEXIT_CRITICAL(&s_lock);if(callbacks_idle)break;vTaskDelay(1);}
    if(!callbacks_idle)return false;
    while(uxQueueMessagesWaiting(s_ready))consume(0);
    if(s_stop||expired||!now(&end))return false;
    uint64_t target=start.mono_ms+s_control->policy.evidence.window_ms;
    if(end.mono_ms<target||end.utc_ms<end.mono_ms-target)return false;
    end.utc_ms-=end.mono_ms-target;end.mono_ms=target;
    if(end.utc_ms+end.uncertainty_ms>=permission.deadline_utc_ms)return false;
    if(cp_v3_window_seal(s_window,end,true,s_seen,s_drops)!=CP_V3_OK)return false;
    ESP_LOGI(TAG,"window=%lu reports=%lu worker=%lu callback_drops=%lu address_overflow=%lu identifiers=%u evidence_bytes=%lu",(unsigned long)seq,(unsigned long)s_seen,(unsigned long)s_window->worker_reports,(unsigned long)s_drops,(unsigned long)s_window->address_overflow_reports,s_window->count,(unsigned long)s_window->evidence_bytes);
    portENTER_CRITICAL(&s_lock);s_display.received+=s_seen;s_display.dropped+=s_drops;s_display.buffer_used=0;portEXIT_CRITICAL(&s_lock);
    return true;
}
static bool permitted(bool upload) {cp_v3_time_t t;if(!now(&t))return false;cp_v3_control_permissions_t p=cp_v3_control_permissions(s_control,t);return !s_stop&&(upload?p.uplink:p.collection);}
static bool drain(cp_v3_queue_kind_t kind) {
    unsigned slot;
    cp_v3_queue_result_t next;
    while((next=cp_v3_queue_oldest(s_queue,kind,&slot))==CP_V3_QUEUE_OK){
        cp_v3_expected_t expected;size_t bytes=0;
        if(cp_v3_queue_read(s_queue,slot,s_body,4096,&bytes,&expected)!=CP_V3_QUEUE_OK)return false;
        bool acked=false;
        for(unsigned attempt=0;attempt<s_control->policy.retry_max_attempts&&permitted(true);++attempt){
            if((uint64_t)s_uploaded_bytes+bytes>s_control->policy.max_upload_bytes_per_day)return false;
            cp_v3_transport_response_t response;phase("V3 UPLOAD");
            if(http(CP_V3_HTTP_POST,"/api/v3/ingest",s_body,bytes,&response)){
                if(!cp_v3_receipt_matches(s_reply,response.body_bytes,&expected)){++s_bad_acks;continue;}
                if(!s_retry_tested&&kind==CP_V3_QUEUE_FEATURE){
                    char first[2048];if(response.body_bytes>=sizeof first)return false;memcpy(first,s_reply,response.body_bytes);size_t first_bytes=response.body_bytes;
                    if(!permitted(true)||!http(CP_V3_HTTP_POST,"/api/v3/ingest",s_body,bytes,&response)||!cp_v3_receipt_matches(s_reply,response.body_bytes,&expected)||response.body_bytes!=first_bytes||memcmp(first,s_reply,first_bytes))return false;
                    s_retry_tested=true;ESP_LOGI(TAG,"exact_retry_same_receipt=1");
                }
                if(cp_v3_queue_ack(s_queue,slot,s_reply,response.body_bytes)!=CP_V3_QUEUE_OK)return false;
                ++s_acked;if(kind==CP_V3_QUEUE_FEATURE)++s_feature_acked;else if(kind==CP_V3_QUEUE_STATUS)++s_status_acked;
                s_uploaded_bytes+=bytes;acked=true;ESP_LOGI(TAG,"durable_acked=%lu body_bytes=%u stream=%u",(unsigned long)s_acked,(unsigned)bytes,(unsigned)kind);break;
            }
            ++s_failed_uploads;vTaskDelay(pdMS_TO_TICKS(s_control->policy.retry_min_ms));
        }
        if(!acked)return false;
    }
    return next==CP_V3_QUEUE_NOT_FOUND;
}
static bool enqueue(cp_v3_queue_kind_t kind,const cp_v3_expected_t *expected,size_t length) {
    if((uint64_t)s_writes+3*CP_V3_QUEUE_SLOT_BYTES>s_control->policy.storage_write_bytes_per_day)return false;
    unsigned slot;cp_v3_queue_result_t e=cp_v3_queue_push(s_queue,kind,expected,s_body,length,&slot);
    if(e==CP_V3_QUEUE_FULL){memcpy(s_pending,s_body,length);if(!drain(kind))return false;memcpy(s_body,s_pending,length);memset(s_pending,0,4096);e=cp_v3_queue_push(s_queue,kind,expected,s_body,length,&slot);}
    if(e!=CP_V3_QUEUE_OK)return false;
    s_writes+=3*CP_V3_QUEUE_SLOT_BYTES;
    return true;
}
static bool run(void) {
    cp_v3_transport_config_t config={.origin=s_bootstrap.origin,.clock_seed=s_bootstrap.clock_seed,.wifi_timeout_ms=30000,.request_timeout_ms=15000,.server_clock_error_ms=100};
    phase("V3 WIFI");if(cp_v3_transport_start(&s_bootstrap.settings,&config)!=ESP_OK)return false;
    s_transport_started=true;
    portENTER_CRITICAL(&s_lock);s_display.wifi_enabled=s_display.wifi_connected=true;portEXIT_CRITICAL(&s_lock);
    cp_v3_time_t t;if(!now(&t))return false;
    size_t caplen=capabilities(s_body,4096,t.utc_ms);
    if(!caplen||cp_v3_control_init(s_control,s_workspace,s_node,s_boot,s_body,caplen,t,cp_v3_transport_sha256,NULL)!=CP_V3_CONTROL_OK)return false;
    const char *registration;size_t length;
    if(cp_v3_control_registration(s_control,1,t.mono_ms,&registration,&length)!=CP_V3_CONTROL_OK)return false;
    cp_v3_transport_response_t response;
    phase("V3 REGISTER");if(!control_post("/api/v3/device/capabilities",registration,length,&response)||!now(&t)||cp_v3_control_registration_receipt(s_control,s_reply,response.body_bytes,t)!=CP_V3_CONTROL_OK)return false;
    ESP_LOGI(TAG,"capability_registered=1 queue_body=49152 queue_pool=262144");
    char path[128];snprintf(path,sizeof path,"/api/v3/device/config?boot_id=%s",s_boot);phase("V3 WAIT POLICY");
    bool offered=false;
    for(unsigned i=0;i<180&&!s_stop;++i){
        if(http(CP_V3_HTTP_GET,path,NULL,0,&response)&&now(&t)&&cp_v3_control_offer(s_control,s_reply,response.body_bytes,t)==CP_V3_CONTROL_OK){offered=true;break;}
        vTaskDelay(pdMS_TO_TICKS(1000));
    }
    if(!offered||!now(&t))return false;
    cp_v3_boundary_t boundary={0};
    if(cp_v3_control_apply(s_control,t,boundary,1,apply,NULL)!=CP_V3_CONTROL_OK)return false;
    const char *ack=cp_v3_control_ack_bytes(s_control,&length);
    phase("V3 ACK POLICY");
    if(!ack||!control_post("/api/v3/device/config/ack",ack,length,&response)||!now(&t)||cp_v3_control_ack_receipt(s_control,s_reply,response.body_bytes,t)!=CP_V3_CONTROL_OK)return false;
    if(s_control->apply_result!=CP_V3_APPLY_OK){ESP_LOGE(TAG,"policy_failed_committed result=%u",(unsigned)s_control->apply_result);return false;}
    ESP_LOGI(TAG,"policy_applied_committed=1");
    /* Initial ACK may arrive before the lower UTC bound reaches received_at.
     * WAIT is not permission denial for the rest of the boot. */
    bool granted=false;
    for(unsigned i=0;i<200&&!s_stop;++i){
        if(!now(&t))return false;
        cp_v3_control_permissions_t permission=cp_v3_control_permissions(s_control,t);
        if(permission.collection&&permission.uplink){granted=true;break;}
        if(permission.reason!=CP_V3_CONTROL_WAIT)return false;
        vTaskDelay(pdMS_TO_TICKS(50));
    }
    if(!granted)return false;
    uint32_t feature_seq=0,status_seq=0;
    for(unsigned w=1;w<=s_bootstrap.max_windows&&permitted(false);++w){
        /* ACK establishes the first lease. A later start must be provably at/
         * after its server timestamp even with host clock uncertainty. */
        if(!permitted(false))return false;
        if(!capture(w))return false;
        for(unsigned id=0;id<s_window->count;++id){
            char batch[37];uuid4(batch);cp_v3_expected_t expected;
            if(cp_v3_feature_body(s_window,id,batch,++feature_seq,cp_v3_transport_sha256,NULL,s_body,4096,&length,&expected)!=CP_V3_OK||!enqueue(CP_V3_QUEUE_FEATURE,&expected,length))return false;
        }
        cp_v3_status_t status={0};if(!now(&status.time))return false;
        status.feature_pending_items=cp_v3_queue_pending(s_queue,CP_V3_QUEUE_FEATURE);status.feature_pending_bytes=cp_v3_queue_pending_bytes(s_queue,CP_V3_QUEUE_FEATURE);
        status.status_pending_items=cp_v3_queue_pending(s_queue,CP_V3_QUEUE_STATUS);status.status_pending_bytes=cp_v3_queue_pending_bytes(s_queue,CP_V3_QUEUE_STATUS);
        status.upload_failures=s_failed_uploads;status.ack_failures=s_bad_acks;
        char batch[37];uuid4(batch);cp_v3_expected_t expected;cp_v3_scope_t scope=s_control->policy.scope;scope.window_seq=w;
        if(cp_v3_status_body(&scope,&status,batch,++status_seq,cp_v3_transport_sha256,NULL,s_body,4096,&length,&expected)!=CP_V3_OK||!enqueue(CP_V3_QUEUE_STATUS,&expected,length))return false;
        uint64_t observation_upper=status.time.utc_ms+status.time.uncertainty_ms;
        bool aged=false;
        for(unsigned i=0;i<200&&permitted(true);++i){
            cp_v3_time_t current;if(!now(&current))return false;
            if(current.utc_ms>=current.uncertainty_ms&&current.utc_ms-current.uncertainty_ms>=observation_upper){aged=true;break;}
            vTaskDelay(pdMS_TO_TICKS(50));
        }
        if(!aged)return false;
        /* Every completed window is fully frozen and synced before its first
         * upload. The trial advertises eight IDs to fit eight feature slots. */
        if(!drain(CP_V3_QUEUE_FEATURE)||!drain(CP_V3_QUEUE_STATUS))return false;
        ++s_windows_closed;
        cp_v3_window_clear(s_window);
    }
    unsigned feature_pending=cp_v3_queue_pending(s_queue,CP_V3_QUEUE_FEATURE),status_pending=cp_v3_queue_pending(s_queue,CP_V3_QUEUE_STATUS);
    ESP_LOGI(TAG,"trial_finished acked=%lu retry_tested=%u writes_budget=%lu internal_min=%u psram_free=%u feature_pending=%u status_pending=%u queue_io=%lu",(unsigned long)s_acked,s_retry_tested,(unsigned long)s_writes,(unsigned)heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL|MALLOC_CAP_8BIT),(unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM),feature_pending,status_pending,(unsigned long)s_queue->io_failures);
    return s_feature_acked>0&&s_status_acked>0&&s_retry_tested&&s_windows_closed==s_bootstrap.max_windows&&!feature_pending&&!status_pending&&!s_queue->io_failures;
}
static void trial_task(void *unused) {
    (void)unused;
    bool power_ready=raw_power_init()==ESP_OK;
    if(!power_ready)startup_fault(false,"power");
    if(nvs_flash_init()!=ESP_OK)startup_fault(true,"nvs");
    uint8_t mac[6];if(esp_efuse_mac_get_default(mac)!=ESP_OK)startup_fault(true,"identity");snprintf(s_node,sizeof s_node,"cp_%02x%02x%02x%02x%02x%02x",mac[0],mac[1],mac[2],mac[3],mac[4],mac[5]);memset(mac,0,sizeof mac);
    bootloader_random_enable();uuid4(s_boot);bootloader_random_disable();
    (void)raw_clock_init();phase("V3 WAIT USB");
    if(xTaskCreate(display_task,"v3_display",6144,NULL,1,NULL)!=pdPASS)startup_fault(true,"display_task");
    s_display_started=true;
    if(xTaskCreate(key_task,"v3_keys",3072,NULL,1,NULL)!=pdPASS)startup_fault(true,"key_task");
    if(trial_bootstrap_wait(s_node,s_boot,&s_bootstrap,cancelled)!=ESP_OK){s_safe_shutdown=true;vTaskDelete(NULL);return;}
    s_control=heap_caps_calloc(1,sizeof *s_control,MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT);s_workspace=heap_caps_calloc(1,sizeof *s_workspace,MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT);
    s_queue=heap_caps_calloc(1,sizeof *s_queue,MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT);s_window=heap_caps_calloc(1,sizeof *s_window,MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT);s_store=heap_caps_calloc(1,sizeof *s_store,MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT);
    s_reports=heap_caps_calloc(REPORT_SLOTS,sizeof *s_reports,MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT);s_body=heap_caps_calloc(1,4096,MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT);s_reply=heap_caps_calloc(1,32768,MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT);s_pending=heap_caps_calloc(1,4096,MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT);
    bool ok=s_control&&s_workspace&&s_queue&&s_window&&s_store&&s_reports&&s_body&&s_reply&&s_pending;
    s_free=xQueueCreate(REPORT_SLOTS,sizeof(uint16_t));s_ready=xQueueCreate(REPORT_SLOTS,sizeof(uint16_t));ok=ok&&s_free&&s_ready;
    if(ok)for(uint16_t i=0;i<REPORT_SLOTS;++i)(void)xQueueSend(s_free,&i,0);
    cp_v3_queue_store_t store={0};
    if(ok)ok=raw_storage_mount()==ESP_OK&&raw_v3_queue_store_prepare(s_store,"/sdcard/cpv3queue",raw_v3_queue_sd_sync,raw_storage_card_handle(),&store)&&cp_v3_queue_open(s_queue,store,s_node,s_boot,cp_v3_transport_sha256,NULL)==CP_V3_QUEUE_OK&&!s_queue->corrupt_slots&&!s_queue->retired_slots;
    if(ok)ESP_LOGI(TAG,"queue_reopened feature_pending=%u status_pending=%u retired=%lu corrupt=%lu",cp_v3_queue_pending(s_queue,CP_V3_QUEUE_FEATURE),cp_v3_queue_pending(s_queue,CP_V3_QUEUE_STATUS),(unsigned long)s_queue->retired_slots,(unsigned long)s_queue->corrupt_slots);
    if(ok)ok=run();
    s_accept=false;if(s_ble_initialized&&ble_gap_disc_active())(void)ble_gap_disc_cancel();
    esp_err_t stopped=cp_v3_transport_stop();trial_bootstrap_clear(&s_bootstrap);
    esp_err_t unmounted=raw_storage_unmount();
    s_safe_shutdown=(!s_transport_started||stopped==ESP_OK)&&unmounted==ESP_OK;
    ESP_LOGI(TAG,"cleanup network=%ld storage=%ld safe=%u",(long)stopped,(long)unmounted,(unsigned)s_safe_shutdown);
    phase(ok&&s_safe_shutdown?"V3 TEST PASSED":"V3 TEST FAILED");
    vTaskDelete(NULL);
}
void app_main(void) { if(xTaskCreate(trial_task,"v3_trial",16384,NULL,4,NULL)!=pdPASS)startup_fault(raw_power_init()==ESP_OK,"trial_task"); }
