/* HISTORICAL SCAFFOLD, excluded from the application CMake source list.
 * Current bounded statistics entry is small_runtime.c; this legacy gate stays
 * closed and is not a claim about that separate runtime's hardware acceptance.
 * Bounded, board-owned v3 acceptance image. Every boot waits for physical USB
 * bootstrap. No v2 runtime, raw writer or host-translated observations. */
#include "trial_bootstrap.h"
#include "board_admission.h"
#include "board_report.h"
#include "board_stats_window.h"
#include "board_capture.h"
#include "board_resources_esp.h"
#include "cp_v3_control.h"
#include "cp_v3_queue.h"
#include "cp_v3_transport.h"
#include "flash_queue.h"
#include "esp_partition.h"
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

_Static_assert(BLE_HCI_ADV_RPT_EVTYPE_SCAN_RSP==4, "NimBLE legacy scan response changed");
_Static_assert(BLE_HCI_ADV_SCAN_RSP_MASK==0x08, "NimBLE extended scan response changed");
#define REPORT_SLOTS 128u
typedef te_v3_report_t report_t;
static const char *TAG="v3trial";
static cp_v3_control_t *s_control;
static cp_v3_control_workspace_t *s_workspace;
static cp_v3_queue_t *s_queue;
static te_v3_stats_window_t s_stats_window;
static te_flash_queue_t s_store;
static trial_bootstrap_t s_bootstrap;
static report_t *s_reports;
static char s_node[16],s_boot[37];
static char *s_reply,*s_body,*s_pending;
static QueueHandle_t s_free,s_ready;
static portMUX_TYPE s_lock=portMUX_INITIALIZER_UNLOCKED;
static uint64_t s_capture_start,s_capture_end;
static uint32_t s_seen,s_callbacks;
static te_v3_capture_state_t s_capture_state;
static uint64_t s_ingress_seq;
static bool s_accept;
static _Atomic bool s_ble_synced,s_scanning,s_stop;
static bool s_ble_initialized;
static bool s_transport_started;
static uint32_t s_acked,s_uploaded_bytes,s_writes,s_failed_uploads,s_bad_acks;
static uint32_t s_feature_acked,s_status_acked,s_windows_closed;
static bool s_retry_tested;

static void uuid4(char out[37]) {
    uint8_t b[16]; esp_fill_random(b,sizeof b); b[6]=(b[6]&15)|64; b[8]=(b[8]&63)|128;
    snprintf(out,37,"%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
        b[0],b[1],b[2],b[3],b[4],b[5],b[6],b[7],b[8],b[9],b[10],b[11],b[12],b[13],b[14],b[15]);
}
static void phase(const char *name) {
    te_v3_memory_snapshot_t m;
    if(!te_v3_esp_memory_snapshot(&m)){ESP_LOGE(TAG,"phase=%s memory_unavailable",name);return;}
    ESP_LOGI(TAG,"phase=%s internal=%u internal_min=%u internal_largest=%u psram=%u psram_min=%u psram_largest=%u stack=%u",name,
        (unsigned)m.internal_free,(unsigned)m.internal_minimum,(unsigned)m.internal_largest,
        (unsigned)m.external_free,(unsigned)m.external_minimum,(unsigned)m.external_largest,
        (unsigned)uxTaskGetStackHighWaterMark(NULL));
}
static bool now(cp_v3_time_t *out){return cp_v3_transport_time(out)==ESP_OK;}
static bool cancelled(void){return s_stop;}
static _Noreturn void startup_fault(const char *reason) {
    ESP_LOGE(TAG,"startup_failed=%s",reason); phase("V3 START FAILED");
    for (;;) vTaskDelay(pdMS_TO_TICKS(1000));
}
static void iso(uint64_t ms,char out[25]){time_t sec=(time_t)(ms/1000);struct tm t;gmtime_r(&sec,&t);
    if(strftime(out,20,"%Y-%m-%dT%H:%M:%S",&t)!=19){out[0]=0;return;}
    snprintf(out+19,6,".%03uZ",(unsigned)(ms%1000));}
static size_t capabilities(char *out,size_t cap,uint64_t utc) {
    char issued[25],expires[25],id[37];iso(utc-5000,issued);iso(utc+1800000,expires);uuid4(id);
    int n=snprintf(out,cap,"{\"schema\":\"device-capabilities/1\",\"capability_id\":\"trial-%s\",\"node_id\":\"%s\",\"boot_id\":\"%s\",\"producer_version\":\"cp-v3-producer/1\",\"policy_schemas\":[\"device-config/3\"],\"issued_at\":\"%s\",\"expires_at\":\"%s\","
        "\"scanner\":{\"modes\":[\"passive\"],\"phys\":[\"1m\"],\"duplicate_filter\":[false],\"min_interval_units\":4,\"max_interval_units\":16384},\"local_raw\":null,"
        "\"resources\":{\"max_working_bytes\":2097152,\"max_storage_write_bytes_per_day\":16777216,\"tf_usable_bytes\":null},"
        "\"summary\":{\"max_addresses\":8,\"max_bins\":10,\"max_window_ms\":10000},"
        "\"features\":{\"schemas\":[\"ble-feature-evidence/1\"],\"extractor_versions\":[\"cp-v3-ad/1\"],\"fields\":[\"company_ids\",\"appearance\"],\"populations\":[\"all_worker_reports\"],\"max_reports_per_window\":10000,\"max_bytes_per_window\":65536},"
        "\"uplink\":{\"transports\":[\"https\"],\"streams\":[\"feature_summaries\",\"node_status\"],\"max_batch_items\":1,\"max_body_bytes\":4096,\"max_sample_reports_per_window\":0,\"cpraw_archive\":false},"
        "\"queue\":{\"media\":[{\"medium\":\"flash_journal\",\"usable_bytes\":49152,\"max_items\":12,\"power_loss_recovery\":true}]}}",id,s_node,s_boot,issued,expires);
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
    if(p->tf_queue||p->evidence.max_identifiers>8||p->queue_max_bytes!=49152||p->queue_max_items!=12||p->feature_reserve_items!=8||p->status_reserve_items!=2||p->control_reserve_items!=2||p->feature_reserve_bytes!=32768||p->status_reserve_bytes!=8192||p->control_reserve_bytes!=8192||p->working_bytes<1048576)return CP_V3_APPLY_RESOURCE_EXHAUSTED;
    if(!s_queue->ready||s_queue->retired_slots||s_queue->corrupt_slots)return CP_V3_APPLY_STORAGE_FAILED;
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
    if(ev->type==BLE_GAP_EVENT_DISC_COMPLETE){
        uint64_t t=(uint64_t)esp_timer_get_time();
        portENTER_CRITICAL(&s_lock);te_v3_capture_scan_end(&s_capture_state,t);s_accept=false;s_scanning=false;portEXIT_CRITICAL(&s_lock);
        return 0;
    }
    if(ev->type!=BLE_GAP_EVENT_DISC&&ev->type!=BLE_GAP_EVENT_EXT_DISC)return 0;
    uint64_t mono_us=(uint64_t)esp_timer_get_time();
    uint64_t mono=mono_us/1000;
    portENTER_CRITICAL(&s_lock);
    bool accepted=s_accept&&mono>=s_capture_start&&mono<s_capture_end;
    uint64_t seq=0;bool ingress_exhausted=false;
    if(accepted){
        if(s_ingress_seq==UINT64_MAX || s_seen==UINT32_MAX){s_accept=false;s_stop=true;s_capture_state.accounting_known=false;accepted=false;ingress_exhausted=true;}
        else {seq=++s_ingress_seq;++s_seen;++s_callbacks;}
    }
    portEXIT_CRITICAL(&s_lock);
    if(ingress_exhausted)ESP_LOGE(TAG,"ingress_counter_saturated collection_stopped=1");
    if(!accepted)return 0;
    uint16_t index;bool queued=false,return_failed=false;
    te_v3_loss_kind_t loss=TE_LOSS_QUEUE_FULL;
    unsigned length=ev->type==BLE_GAP_EVENT_DISC?ev->disc.length_data:ev->ext_disc.length_data;
    const uint8_t *data=ev->type==BLE_GAP_EVENT_DISC?ev->disc.data:ev->ext_disc.data;
    if(length>CP_V3_STATS_PAYLOAD_MAX)loss=TE_LOSS_OVERSIZE;
    else if(length&&!data)loss=TE_LOSS_INVALID;
    else if(xQueueReceive(s_free,&index,0)==pdTRUE){
        report_t *r=&s_reports[index];te_v3_report_init(r,seq,mono_us);r->length=length;
        if(ev->type==BLE_GAP_EVENT_DISC){
            const struct ble_gap_disc_desc *d=&ev->disc;
            r->event_type=d->event_type;r->address_type=d->addr.type;memcpy(r->address,d->addr.val,6);
            r->direct_address_type=d->direct_addr.type;memcpy(r->direct_address,d->direct_addr.val,6);
            r->rssi=d->rssi;r->primary_phy=BLE_HCI_LE_PHY_1M;
        } else {
            const struct ble_gap_ext_disc_desc *d=&ev->ext_disc;
            r->kind=1;r->event_type=d->legacy_event_type;r->props=d->props;r->data_status=d->data_status;
            r->address_type=d->addr.type;memcpy(r->address,d->addr.val,6);
            r->direct_address_type=d->direct_addr.type;memcpy(r->direct_address,d->direct_addr.val,6);
            r->rssi=d->rssi;r->tx_power=d->tx_power;r->sid=d->sid;r->primary_phy=d->prim_phy;r->secondary_phy=d->sec_phy;r->periodic_interval=d->periodic_adv_itvl;
        }
        if(length)memcpy(r->payload,data,length);
        queued=xQueueSend(s_ready,&index,0)==pdTRUE;
        if(!queued){loss=TE_LOSS_ENQUEUE_FAILED;return_failed=xQueueSend(s_free,&index,0)!=pdTRUE;}
    }
    bool accounting_fault=false;
    portENTER_CRITICAL(&s_lock);
    if(!queued&&!te_v3_capture_loss(&s_capture_state,loss)){s_accept=false;s_stop=true;accounting_fault=true;}
    if(return_failed){(void)te_v3_capture_loss(&s_capture_state,TE_LOSS_RETURN_FAILED);s_accept=false;s_stop=true;accounting_fault=true;}
    --s_callbacks;portEXIT_CRITICAL(&s_lock);
    if(accounting_fault)ESP_LOGE(TAG,"callback_loss_counter_saturated collection_stopped=1");
    return 0;
}
static void synced(void){s_ble_synced=true;}
static void reset(int reason){ESP_LOGE(TAG,"ble_reset=%d",reason);s_stop=true;}
static void host(void *unused){(void)unused;nimble_port_run();nimble_port_freertos_deinit();}
/* Only the worker task consumes and returns slots. The runtime gate remains
 * closed until this worker is initialized and the old capture/lease scaffolding
 * is replaced by the finalized small-statistics control path. */
static void consume(unsigned wait_ms) {
    uint16_t index;
    if(xQueueReceive(s_ready,&index,pdMS_TO_TICKS(wait_ms))!=pdTRUE)return;
    report_t *r=&s_reports[index];
    bool accepted=te_v3_window_report(&s_stats_window,r);
    if(!accepted){ESP_LOGE(TAG,"statistics_window_invalid collection_stopped=1");s_stop=true;}
    memset(r,0,sizeof *r);
    if(xQueueSend(s_free,&index,0)!=pdTRUE){
        portENTER_CRITICAL(&s_lock);(void)te_v3_capture_loss(&s_capture_state,TE_LOSS_RETURN_FAILED);s_accept=false;portEXIT_CRITICAL(&s_lock);
        ESP_LOGE(TAG,"slot_return_failed collection_stopped=1");s_stop=true;
    }
}
/* This capture path is dormant until shared policy, lease, queue and worker
 * initialization are integrated. The caller owns time authorization. */
static bool capture(uint32_t seq) {
    cp_v3_time_t start,end;
    if(!now(&start))return false;
    cp_v3_control_permissions_t permission=cp_v3_control_permissions(s_control,start);
    uint64_t growth=((uint64_t)s_control->policy.evidence.window_ms*500u+999999u)/1000000u;
    if(!permission.collection||start.mono_ms+s_control->policy.evidence.window_ms>=permission.deadline_mono_ms||
        start.utc_ms+start.uncertainty_ms+s_control->policy.evidence.window_ms+growth>=permission.deadline_utc_ms)return false;
    (void)seq;
    if(!te_v3_window_begin(&s_stats_window,start.mono_ms*1000u,false))return false;
    portENTER_CRITICAL(&s_lock);
    s_seen=0;te_v3_capture_reset(&s_capture_state);s_capture_start=start.mono_ms;
    s_capture_end=start.mono_ms+s_control->policy.evidence.window_ms;s_accept=true;
    portEXIT_CRITICAL(&s_lock);
    bool failed=false,expired=false,started=false,callbacks_idle=false,interrupted=false;
    struct ble_gap_ext_disc_params p={.itvl=s_control->policy.scan_interval_units,.window=s_control->policy.scan_window_units,.passive=1};
    if(ble_gap_ext_disc(BLE_OWN_ADDR_PUBLIC,0,0,0,0,0,&p,NULL,gap,NULL))failed=true;
    else {
        started=true;
        portENTER_CRITICAL(&s_lock);bool already_ended=s_capture_state.scan_ended;s_scanning=!already_ended;portEXIT_CRITICAL(&s_lock);
        if(!already_ended && !te_v3_window_scan_state(&s_stats_window,(uint64_t)esp_timer_get_time(),true))failed=true;
    }
    if(!failed){
        phase("V3 COLLECT");uint64_t last_check=start.mono_ms;
        while(!s_stop&&(uint64_t)esp_timer_get_time()/1000<s_capture_end){
            portENTER_CRITICAL(&s_lock);bool ended=s_capture_state.scan_ended;portEXIT_CRITICAL(&s_lock);
            if(ended)break;
            consume(10);
            uint64_t current=(uint64_t)esp_timer_get_time()/1000;
            if(current-last_check>=100){cp_v3_time_t t;if(!now(&t)||!cp_v3_control_permissions(s_control,t).collection){expired=true;break;}last_check=current;}
        }
    }
    /* Every exit closes admission first, attempts radio stop, waits for all
     * accepted callbacks, and releases every queued slot even after failure. */
    portENTER_CRITICAL(&s_lock);s_accept=false;portEXIT_CRITICAL(&s_lock);
    uint64_t stop_request_us=(uint64_t)esp_timer_get_time();
    if(started&&ble_gap_disc_active()&&ble_gap_disc_cancel())failed=true;
    bool radio_stopped=!started;
    for(unsigned i=0;started&&i<1000;++i){
        if(!ble_gap_disc_active()){radio_stopped=true;break;}
        vTaskDelay(1);
    }
    if(!radio_stopped)failed=true;
    for(unsigned i=0;i<1000;++i){portENTER_CRITICAL(&s_lock);callbacks_idle=s_callbacks==0;portEXIT_CRITICAL(&s_lock);if(callbacks_idle)break;vTaskDelay(1);}
    if(!callbacks_idle)failed=true;
    te_v3_capture_state_t ingress;
    portENTER_CRITICAL(&s_lock);ingress=s_capture_state;portEXIT_CRITICAL(&s_lock);
    uint64_t cut=0;
    if(!te_v3_capture_cut(&ingress,start.mono_ms*1000u,s_capture_end*1000u,stop_request_us,&cut,&interrupted))failed=true;
    if(!ingress.accounting_known||ingress.return_failed)failed=true;
    bool draining=false;
    if(!failed&&callbacks_idle&&radio_stopped)draining=te_v3_window_stop(&s_stats_window,cut,radio_stopped,callbacks_idle);
    if(!draining)failed=true;
    while(uxQueueMessagesWaiting(s_ready))consume(0);
    if(s_stop||expired)failed=true;
    cp_v3_stats_source_t source={.reports_seen_known=ingress.accounting_known,.queue_drops_known=ingress.accounting_known,
        .processing_losses_known=ingress.accounting_known,.reports_seen=s_seen,
        .queue_drops=(uint64_t)ingress.queue_full+ingress.enqueue_failed,
        .processing_losses=(uint64_t)ingress.invalid+ingress.oversize};
    cp_v3_stats_snapshot_t snapshot;
    bool snapshot_ok=draining&&te_v3_window_finish(&s_stats_window,uxQueueMessagesWaiting(s_ready)==0,source,&snapshot);
    if(snapshot_ok)ESP_LOGI(TAG,"window=%lu reports=%lu queue_full=%lu enqueue_failed=%lu invalid=%lu oversize=%lu return_failed=%lu scan_interrupted=%u partial=%u quality=%u",
        (unsigned long)seq,(unsigned long)s_seen,(unsigned long)ingress.queue_full,(unsigned long)ingress.enqueue_failed,
        (unsigned long)ingress.invalid,(unsigned long)ingress.oversize,(unsigned long)ingress.return_failed,
        (unsigned)interrupted,(unsigned)!snapshot.window_closed,(unsigned)snapshot.quality_mask);
    if(failed||interrupted||!snapshot_ok||!snapshot.window_closed||!snapshot.source_consistent||snapshot.counters_saturated||!now(&end))return false;
    uint64_t target=start.mono_ms+s_control->policy.evidence.window_ms;
    if(end.mono_ms<target||end.utc_ms<end.mono_ms-target)return false;
    end.utc_ms-=end.mono_ms-target;end.mono_ms=target;
    if(end.utc_ms+end.uncertainty_ms>=permission.deadline_utc_ms)return false;
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
                /* Charge both erase sectors before attempting the ACK, including failures. */
                if((uint64_t)s_writes+8192u>s_control->policy.storage_write_bytes_per_day)return false;
                s_writes+=8192u;
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
    unsigned slot;
    /* Charge the full two-sector slot before each attempted write, including
     * failures; ACK reclamation is charged separately in drain(). */
    if((uint64_t)s_writes+8192u>s_control->policy.storage_write_bytes_per_day)return false;
    s_writes+=8192u;
    cp_v3_queue_result_t e=cp_v3_queue_push(s_queue,kind,expected,s_body,length,&slot);
    if(e==CP_V3_QUEUE_FULL){
        memcpy(s_pending,s_body,length);if(!drain(kind))return false;
        memcpy(s_body,s_pending,length);memset(s_pending,0,4096);
        if((uint64_t)s_writes+8192u>s_control->policy.storage_write_bytes_per_day)return false;
        s_writes+=8192u;
        e=cp_v3_queue_push(s_queue,kind,expected,s_body,length,&slot);
    }
    return e==CP_V3_QUEUE_OK;
}
/* No legacy feature or raw upload path. The shared statistics contract and
 * durable queue must be integrated before collection or transport can start. */
static bool run(void) { return false; }
static void *pool_alloc(size_t bytes,void *ctx) { (void)ctx; return heap_caps_calloc(1,bytes,MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT); }
static bool pool_external(const void *p,void *ctx) { (void)ctx; return esp_ptr_external_ram(p); }
static void pool_free(void *p,void *ctx) { (void)ctx; heap_caps_free(p); }
static void trial_task(void *unused) {
    (void)unused;
    if(!te_v3_runtime_ready()){
        ESP_LOGE(TAG,"runtime_blocked=statistics_contract_and_storage_unavailable usb_setup=unavailable");
        vTaskDelete(NULL);return;
    }
    if(nvs_flash_init()!=ESP_OK)startup_fault("nvs");
    uint8_t mac[6];if(esp_efuse_mac_get_default(mac)!=ESP_OK)startup_fault("identity");snprintf(s_node,sizeof s_node,"cp_%02x%02x%02x%02x%02x%02x",mac[0],mac[1],mac[2],mac[3],mac[4],mac[5]);memset(mac,0,sizeof mac);
    bootloader_random_enable();uuid4(s_boot);bootloader_random_disable();
    phase("V3 WAIT USB");
    if(trial_bootstrap_wait(s_node,s_boot,&s_bootstrap,cancelled)!=ESP_OK){vTaskDelete(NULL);return;}
    s_control=heap_caps_calloc(1,sizeof *s_control,MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT);s_workspace=heap_caps_calloc(1,sizeof *s_workspace,MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT);
    s_queue=heap_caps_calloc(1,sizeof *s_queue,MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT);
    s_reports=te_v3_pool_acquire(REPORT_SLOTS,sizeof *s_reports,pool_alloc,pool_external,pool_free,NULL);s_body=heap_caps_calloc(1,4096,MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT);s_reply=heap_caps_calloc(1,32768,MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT);s_pending=heap_caps_calloc(1,4096,MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT);
    bool ok=s_control&&s_workspace&&s_queue&&s_reports&&esp_ptr_external_ram(s_reports)&&s_body&&s_reply&&s_pending;
    s_free=xQueueCreate(REPORT_SLOTS,sizeof(uint16_t));s_ready=xQueueCreate(REPORT_SLOTS,sizeof(uint16_t));ok=ok&&s_free&&s_ready;
    if(ok)for(uint16_t i=0;i<REPORT_SLOTS;++i)(void)xQueueSend(s_free,&i,0);
    cp_v3_queue_store_t store={0};
    const esp_partition_t *partition=esp_partition_find_first(ESP_PARTITION_TYPE_DATA,0x40,"v3queue");
    if(ok)ok=te_flash_queue_prepare(&s_store,partition,&store)&&cp_v3_queue_open(s_queue,store,s_node,s_boot,cp_v3_transport_sha256,NULL)==CP_V3_QUEUE_OK&&!s_queue->corrupt_slots&&!s_queue->retired_slots;
    if(ok)ESP_LOGI(TAG,"queue_reopened feature_pending=%u status_pending=%u retired=%lu corrupt=%lu",cp_v3_queue_pending(s_queue,CP_V3_QUEUE_FEATURE),cp_v3_queue_pending(s_queue,CP_V3_QUEUE_STATUS),(unsigned long)s_queue->retired_slots,(unsigned long)s_queue->corrupt_slots);
    if(ok)ok=run();
    portENTER_CRITICAL(&s_lock);s_accept=false;portEXIT_CRITICAL(&s_lock);
    if(s_ble_initialized&&ble_gap_disc_active())(void)ble_gap_disc_cancel();
    esp_err_t stopped=cp_v3_transport_stop();trial_bootstrap_clear(&s_bootstrap);
    bool safe=!s_transport_started||stopped==ESP_OK;
    ESP_LOGI(TAG,"cleanup network=%ld safe=%u",(long)stopped,(unsigned)safe);
    phase(ok&&safe?"V3 TEST PASSED":"V3 TEST FAILED");
    vTaskDelete(NULL);
}
void app_main(void) { if(xTaskCreate(trial_task,"v3_trial",16384,NULL,4,NULL)!=pdPASS)startup_fault("trial_task"); }
