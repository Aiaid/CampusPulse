/* Waveshare normal small-result collector. USB supplies boot-private settings;
 * scanner, storage and uplink have separate owners. No saved secret or raw uplink. */
#include "trial_bootstrap.h"
#include "cp_v3_control.h"
#include "cp_v3_queue.h"
#include "cp_v3_budget.h"
#include "cp_v3_budget_nvs.h"
#include "cp_v3_transport.h"
#include "cp_v3_capture.h"
#include "cp_v3_small_results.h"
#include "local_raw.h"
#include "runtime_logic.h"
#include "runtime_json.h"
#include "runtime_lifecycle.h"
#include "runtime_budget.h"
#include "runtime_upload.h"
#include "runtime_registration.h"
#include <sys/stat.h>
#include <dirent.h>
#include <fcntl.h>
#include <errno.h>
#include "edge_ui.h"
#include "raw_board.h"
#include "raw_power.h"
#include "raw_battery.h"
#include "raw_clock.h"
#include "raw_format.h"
#include "raw_display.h"
#include "raw_v3_queue_store.h"
#include "raw_v3_queue_sd_sync.h"
#include "bootloader_random.h"
#include "esp_mac.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "esp_system.h"
#include "esp_wifi.h"
#include "esp_netif.h"
#include <unistd.h>
#include "esp_log.h"
#include "esp_heap_caps.h"
#include "nvs_flash.h"
#include "cJSON.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include <stdio.h>
#include <string.h>
#include <time.h>
#include <stdatomic.h>

#define BODY_MAX 2048u
#define QUEUE_BYTES (12u*BODY_MAX)
#define FS_POOL 262144u
#define WORKING_MAX 4194304u
#define WRITE_MAX 67108864u
static const char *TAG="v3small";
static char s_node[16],s_boot[37];
static trial_bootstrap_t s_bootstrap;
static cp_v3_control_t *s_control;
static cp_v3_control_workspace_t *s_workspace;
static cp_v3_queue_t *s_queue;
static raw_v3_queue_store_t *s_store;
static cp_v3_capture_t *s_capture;
static local_raw_t *s_raw;
static SemaphoreHandle_t s_tf;
static cp_v3_budget_t s_budget;
static cp_v3_budget_nvs_t s_budget_provider;
static cp_v3_budget_t s_uplink_budget;
static cp_v3_budget_nvs_t s_uplink_provider;
static cp_v3_budget_store_t s_uplink_store;
static edge_budget_bridge_t s_uplink_bridge;
static uint8_t s_budget_owner[32];
static cp_v3_queue_store_t s_base_store;
static bool s_lifecycle_ready,s_publish_authorized;
static uint64_t s_publish_allowance,s_cleanup_covered,s_cleanup_completed;
static _Atomic unsigned s_budget_error;
static portMUX_TYPE s_lock=portMUX_INITIALIZER_UNLOCKED;
static cp_v3_time_t s_anchor;
static raw_display_snapshot_t s_display;
static uint64_t s_ui_last_reports,s_ui_last_drops;
static bool s_ui_last_known;
static char s_phase[24]="WAIT USB";
static _Atomic bool s_stop,s_usb_stop,s_power_stop,s_safe,s_display_asleep,s_storage_stop,s_storage_done;
static _Atomic bool s_capture_ready,s_storage_fault,s_storage_started,s_raw_ready,s_bootstrapped,s_storage_backpressure,s_storage_resume,s_storage_ready,s_storage_gate;
static _Atomic bool s_mounted,s_queue_ready,s_run_failed;
static _Atomic bool s_selected_mqtt;
static _Atomic uint32_t s_windows,s_window_acks,s_event_acks,s_status_acks,s_last_body;
static _Atomic uint32_t s_upload_failures,s_ack_failures,s_retries;
static uint32_t s_historical_acks;
static const char *s_error_code="unavailable";
static bool s_error_retryable=true;
static uint32_t s_window_seq,s_event_seq,s_status_seq,s_control_seq;
static _Atomic uint32_t s_status_coalesced,s_last_durable_window;
static uint64_t s_writes,s_tx_bytes;
static bool s_transport_started,s_retry_tested;
static uint32_t s_attempts[CP_V3_QUEUE_SLOTS];
static uint64_t s_next_attempt[CP_V3_QUEUE_SLOTS];
static char s_attempt_hash[CP_V3_QUEUE_SLOTS][65];
static char *s_reply,*s_network_body;

static uint64_t monotonic_ms(void){return (uint64_t)esp_timer_get_time()/1000;}
static void uuid4(char out[37]) {
    uint8_t b[16];esp_fill_random(b,sizeof b);b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;
    snprintf(out,37,"%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",b[0],b[1],b[2],b[3],b[4],b[5],b[6],b[7],b[8],b[9],b[10],b[11],b[12],b[13],b[14],b[15]);
}
static bool entropy(void *ctx,uint8_t out[16]){(void)ctx;esp_fill_random(out,16);return true;}
static bool clock_copy(void *ctx,uint64_t mono,cp_v3_temporal_time_t *out) {
    (void)ctx;cp_v3_time_t anchor;portENTER_CRITICAL(&s_lock);anchor=s_anchor;portEXIT_CRITICAL(&s_lock);
    return edge_clock_at(anchor,mono,out);
}
static bool current(cp_v3_time_t *out) {
    /* Owner-only transport call; storage/collector use clock_copy exclusively. */
    if(cp_v3_transport_time(out)!=ESP_OK)return false;
    return true;
}
static void publish_anchor(cp_v3_time_t t){portENTER_CRITICAL(&s_lock);s_anchor=t;portEXIT_CRITICAL(&s_lock);}
static bool queue_clock(void *ctx,uint64_t *lower,uint64_t *upper) {
    (void)ctx;cp_v3_temporal_time_t t;if(!clock_copy(NULL,monotonic_ms(),&t)||t.utc_ms<t.uncertainty_ms)return false;
    *lower=t.utc_ms-t.uncertainty_ms;*upper=t.utc_ms+t.uncertainty_ms;return true;
}
/* All budget calls occur under the existing outer TF mutex. Raw invokes this
 * callback under that same lock; never reacquire it here. */
static bool write_charge(void *context,uint64_t bytes) {
    (void)context;uint64_t lower=0,upper=0;(void)queue_clock(NULL,&lower,&upper);
    cp_v3_budget_result_t result=cp_v3_budget_charge(&s_budget,bytes,lower,upper);
    if(result!=CP_V3_BUDGET_OK){if(atomic_exchange(&s_budget_error,(unsigned)result)!=(unsigned)result)ESP_LOGE(TAG,"write_budget_denied=%u",(unsigned)result);return false;}
    s_budget_error=0;s_writes+=bytes;return true;
}
static bool budget_open(void) {
    cp_v3_budget_store_t store;char owner[80];uint8_t digest[32];
    int bytes=snprintf(owner,sizeof owner,"%s/cp-v3-small-storage/1",s_node);
    if(bytes<=0||(size_t)bytes>=sizeof owner||!cp_v3_transport_sha256(NULL,owner,(size_t)bytes,digest)||cp_v3_budget_nvs_open(&s_budget_provider,"cpv3budg",&store)!=ESP_OK)return false;
    memcpy(s_budget_owner,digest,32);
    return cp_v3_budget_open(&s_budget,store,digest)==CP_V3_BUDGET_OK&&cp_v3_budget_configure(&s_budget,WRITE_MAX,65536)==CP_V3_BUDGET_OK;
}
/* Uplink journal reservations themselves consume the storage allowance.
 * Caller already owns TF; lock order is uplink -> storage -> provider NVS. */
static bool uplink_open(void) {
    char owner[80];uint8_t digest[32];int bytes=snprintf(owner,sizeof owner,"%s/cp-v3-small-uplink/1",s_node);
    if(bytes<=0||(size_t)bytes>=sizeof owner||!cp_v3_transport_sha256(NULL,owner,(size_t)bytes,digest)||cp_v3_budget_nvs_open(&s_uplink_provider,"cpv3upl",&s_uplink_store)!=ESP_OK)return false;
    s_uplink_bridge=(edge_budget_bridge_t){s_uplink_store,write_charge,NULL};
    cp_v3_budget_store_t wrapped=edge_budget_provider(&s_uplink_bridge);
    return cp_v3_budget_open(&s_uplink_budget,wrapped,digest)==CP_V3_BUDGET_OK&&cp_v3_budget_configure(&s_uplink_budget,WRITE_MAX,65536)==CP_V3_BUDGET_OK;
}
static bool uplink_charge(size_t bytes) {
    if(!bytes)return true;
    uint64_t lower=0,upper=0;(void)queue_clock(NULL,&lower,&upper);
    return cp_v3_budget_charge(&s_uplink_budget,bytes,lower,upper)==CP_V3_BUDGET_OK;
}
static void budget_log(void) {
    if(!s_tf)return;
    cp_v3_budget_snapshot_t b,u;xSemaphoreTake(s_tf,portMAX_DELAY);cp_v3_budget_snapshot(&s_budget,&b);cp_v3_budget_snapshot(&s_uplink_budget,&u);xSemaphoreGive(s_tf);
    ESP_LOGI(TAG,"uplink_budget day=%lu reserved=%llu authorized_body=%llu reservation_journal=%llu persist=%llu/%llu latched=%u",(unsigned long)u.utc_day,(unsigned long long)u.persisted_reserved_bytes,(unsigned long long)u.authorized_io_bytes_since_open,(unsigned long long)u.journal_logical_bytes_since_open,(unsigned long long)u.persist_successes,(unsigned long long)u.persist_attempts,(unsigned)u.latched);
    ESP_LOGI(TAG,"budget day=%lu reserved=%llu authorized_logical=%llu journal_logical=%llu persist=%llu/%llu carry=%llu discarded_credit=%llu latched=%u",(unsigned long)b.utc_day,(unsigned long long)b.persisted_reserved_bytes,(unsigned long long)b.authorized_io_bytes_since_open,(unsigned long long)b.journal_logical_bytes_since_open,(unsigned long long)b.persist_successes,(unsigned long long)b.persist_attempts,(unsigned long long)b.carry_in_reserved_bytes,(unsigned long long)b.discarded_credit_bytes,(unsigned)b.latched);
}
static bool owned_record(const void *bytes,size_t length,unsigned slot) {
    return s_lifecycle_ready&&edge_lifecycle_record(bytes,length,slot,s_node,cp_v3_transport_sha256,NULL);
}
/* Deferred cleanup is the bounded obligation prepaid on publication day, not
 * new day credit. Never apply this to imported/legacy/unknown records. */
static bool queue_expire(void *ctx,unsigned slot,const void *body,size_t bytes,const cp_v3_queue_tombstone_t *t) {
    (void)ctx;if(!owned_record(body,bytes,slot))return false;s_cleanup_covered++;
    bool okay=raw_v3_queue_store_expire(s_store,slot,body,bytes,t);if(okay)s_cleanup_completed++;return okay;
}
static bool queue_reclaim(void *ctx,unsigned slot,const void *body,size_t bytes) {
    (void)ctx;if(!owned_record(body,bytes,slot))return false;s_cleanup_covered++;
    bool okay=s_base_store.reclaim(s_base_store.context,slot,body,bytes);if(okay)s_cleanup_completed++;return okay;
}
static bool queue_store(void *ctx,unsigned slot,const void *body,size_t bytes) {
    (void)ctx;if(!s_publish_authorized||s_publish_allowance<edge_lifecycle_charge(bytes)||!owned_record(body,bytes,slot))return false;
    s_publish_authorized=false;return s_base_store.store(s_base_store.context,slot,body,bytes);
}
static int queue_load(void *ctx,unsigned slot,void *out,size_t cap,size_t *length) {
    (void)ctx;if(!s_lifecycle_ready||slot>=CP_V3_QUEUE_SLOTS)return -1;
    /* The underlying adapter can complete an exact expired-record deletion in
     * load(). Validate the complete record before granting that narrow recovery. */
    char path[224];int chars=snprintf(path,sizeof path,"%s/q%02u.rec",s_store->directory,slot);
    if(chars<0||(size_t)chars>=sizeof path)return -1;
    struct stat st;bool present=stat(path,&st)==0;
    if(!present&&errno!=ENOENT)return -1;
    if(present){
        if(!S_ISREG(st.st_mode)||st.st_size<=0||(uint64_t)st.st_size>sizeof s_store->comparison)return 2;
        FILE *file=fopen(path,"rb");if(!file)return -1;size_t got=fread(s_store->comparison,1,(size_t)st.st_size,file);
        bool exact=got==(size_t)st.st_size&&!ferror(file)&&fgetc(file)==EOF;if(fclose(file))exact=false;
        if(!exact)return -1;
        if(!owned_record(s_store->comparison,got,slot))return 2;
    }
    int result=s_base_store.load(s_base_store.context,slot,out,cap,length);
    if(present&&result==3){s_cleanup_covered++;s_cleanup_completed++;}
    return result;
}
static bool lifecycle_directory(void) {
    const char *name="/sdcard/cpv3small/.logical-lifecycle-v1";struct stat st;
    if(stat(name,&st)==0){
        if(!S_ISREG(st.st_mode)||st.st_size!=EDGE_LIFECYCLE_MARKER_BYTES)return false;
        uint8_t marker[64];FILE *file=fopen(name,"rb");if(!file)return false;
        bool okay=fread(marker,1,sizeof marker,file)==sizeof marker&&!ferror(file)&&fgetc(file)==EOF;
        if(fclose(file))okay=false;
        return okay&&edge_lifecycle_marker_matches(marker,sizeof marker,s_budget_owner);
    }
    if(errno!=ENOENT)return false;
    DIR *directory=opendir("/sdcard/cpv3small");if(!directory)return false;bool empty=true;struct dirent *entry;
    while((entry=readdir(directory))!=NULL)if(strcmp(entry->d_name,".")&&strcmp(entry->d_name,"..")){empty=false;break;}
    if(closedir(directory))empty=false;
    if(!empty||!write_charge(NULL,4096))return false;
    uint8_t marker[64];edge_lifecycle_marker(s_budget_owner,marker);
    int fd=open(name,O_WRONLY|O_CREAT|O_EXCL,0600);if(fd<0)return false;
    bool okay=write(fd,marker,sizeof marker)==sizeof marker&&fsync(fd)==0;if(close(fd))okay=false;
    return okay&&raw_v3_queue_sd_sync(raw_storage_card_handle());
}
static bool media_sync(void *ctx){(void)ctx;return raw_v3_queue_sd_sync(raw_storage_card_handle());}
static bool cancelled(void){return s_stop;}
static void phase(const char *name) {
    portENTER_CRITICAL(&s_lock);snprintf(s_phase,sizeof s_phase,"%s",name);portEXIT_CRITICAL(&s_lock);
    ESP_LOGI(TAG,"phase=%s internal=%u largest=%u psram=%u",name,(unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL|MALLOC_CAP_8BIT),(unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL|MALLOC_CAP_8BIT),(unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM));
}
static void *psram(size_t bytes){return heap_caps_calloc(1,bytes,MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT);}
/* Network owner publishes a bounded local display snapshot; no credentials
 * other than the user-visible SSID are copied, and nothing is logged. */
static void ui_network_snapshot(void) {
    wifi_ap_record_t ap;esp_netif_ip_info_t ip;
    bool have_ap=esp_wifi_sta_get_ap_info(&ap)==ESP_OK;
    esp_netif_t *netif=esp_netif_get_handle_from_ifkey("WIFI_STA_DEF");
    bool have_ip=netif&&esp_netif_get_ip_info(netif,&ip)==ESP_OK&&ip.ip.addr;
    portENTER_CRITICAL(&s_lock);
    s_display.wifi_enabled=s_display.wifi_connected=true;
    s_display.wifi_rssi_known=have_ap;
    if(have_ap){size_t n=strnlen((const char *)ap.ssid,32);memcpy(s_display.wifi_ssid,ap.ssid,n);s_display.wifi_ssid[n]=0;s_display.wifi_rssi=ap.rssi;}
    else s_display.wifi_ssid[0]=0;
    if(have_ip)snprintf(s_display.ip,sizeof s_display.ip,IPSTR,IP2STR(&ip.ip));else s_display.ip[0]=0;
    portEXIT_CRITICAL(&s_lock);
}
static uint32_t ui_count(uint64_t n){return n>UINT32_MAX?UINT32_MAX:(uint32_t)n;}
static edge_ui_phase_t ui_phase(const char *name,const cp_v3_capture_status_t *capture) {
    if(s_run_failed||capture->failed||strstr(name,"ERROR")||strstr(name,"FAILED"))return EDGE_UI_ERROR;
    if(s_stop&&!s_safe)return EDGE_UI_STOPPING;
    if(s_safe)return EDGE_UI_STOPPED_SAFE;
    if(!strcmp(name,"WAIT USB"))return EDGE_UI_WAIT_USB;
    if(capture->running)return EDGE_UI_COLLECTING;
    if(!strcmp(name,"LEASE PAUSED")||(s_storage_gate&&capture->paused))return EDGE_UI_PAUSED;
    return EDGE_UI_STARTING;
}
static void display_task(void *unused) {
    (void)unused;bool ready=raw_display_init()==ESP_OK;(void)raw_battery_init();
    uint64_t previous_reports=0,previous_ms=0,space_at=0,tf_total=0,tf_free=0;
    bool previous_known=false,tf_known=false;
    uint32_t rate_bins[10]={0};
    for(;;){
        bool final_display=s_stop&&s_safe&&s_power_stop;
        raw_display_snapshot_t snap;edge_ui_metrics_t metrics={0};char name[24];
        portENTER_CRITICAL(&s_lock);snap=s_display;memcpy(name,s_phase,sizeof name);
        metrics.last_window_known=s_ui_last_known;metrics.last_window_reports=s_ui_last_reports;metrics.last_window_drops=s_ui_last_drops;portEXIT_CRITICAL(&s_lock);
        cp_v3_capture_status_t c={0};if(s_capture_ready)cp_v3_capture_status(s_capture,&c);
        uint64_t now=monotonic_ms();uint32_t queue_errors=0;
        if(s_queue_ready){
            xSemaphoreTake(s_tf,portMAX_DELAY);
            snap.buffer_used=cp_v3_queue_pending(s_queue,CP_V3_QUEUE_WINDOW)+cp_v3_queue_pending(s_queue,CP_V3_QUEUE_EVENT)+cp_v3_queue_pending(s_queue,CP_V3_QUEUE_STATUS)+cp_v3_queue_pending(s_queue,CP_V3_QUEUE_CONTROL);
            snap.buffer_capacity=12;
            metrics.current_pending=ui_count(edge_upload_pending_current(s_queue,CP_V3_QUEUE_WINDOW,s_boot)+edge_upload_pending_current(s_queue,CP_V3_QUEUE_EVENT,s_boot)+edge_upload_pending_current(s_queue,CP_V3_QUEUE_STATUS,s_boot)+edge_upload_pending_current(s_queue,CP_V3_QUEUE_CONTROL,s_boot));
            metrics.historical_pending=snap.buffer_used>=metrics.current_pending?snap.buffer_used-metrics.current_pending:0;
            metrics.queue_known=true;queue_errors=s_queue->io_failures;
            if(s_mounted&&(!tf_known||now-space_at>=5000)){
                uint64_t total,free_bytes;
                if(raw_storage_capacity(&total,&free_bytes)==ESP_OK){tf_total=total;tf_free=free_bytes;tf_known=true;}
                space_at=now;
            }
            xSemaphoreGive(s_tf);
        }
        local_raw_status_t raw={0};if(s_raw_ready)local_raw_snapshot(s_raw,&raw);
        metrics.phase=ui_phase(name,&c);metrics.capture_known=s_capture_ready;metrics.metrics_known=s_capture_ready;
        metrics.raw_policy_enabled=s_capture_ready&&s_control->policy.local_raw.enabled;metrics.raw_active=raw.active;
        metrics.raw_fault=raw.io_failed_latched||raw.counters[4]||raw.counters[5];metrics.storage_fault=s_storage_fault||raw.io_failed_latched;
        metrics.tf_mounted=s_mounted;metrics.raw_queue_capacity=raw.capacity;metrics.raw_queue_used=raw.capacity>=raw.free_slots?raw.capacity-raw.free_slots:0;
        metrics.history_known=s_capture_ready&&s_control->policy.temporal.rolling;metrics.history_ms=metrics.history_known?s_control->policy.temporal.history_ms:0;
        metrics.history_slices=c.temporal.history_slices;metrics.tracks=c.temporal.tracks;metrics.open_events=c.temporal.open_events;
        metrics.windows=s_windows;metrics.confirmed_windows=s_window_acks;metrics.last_body_bytes=s_last_body;
        metrics.upload_failures=s_upload_failures;metrics.retries=s_retries;
        metrics.transport_known=s_bootstrapped;metrics.mqtt_tls=s_selected_mqtt;
        uint64_t elapsed=now>=previous_ms?now-previous_ms:0;
        metrics.rate_known=s_capture_ready&&c.running&&previous_known&&elapsed&&elapsed<=60000&&c.callback_reports>=previous_reports;
        if(metrics.rate_known){uint64_t delta=c.callback_reports-previous_reports;uint64_t rate=delta>UINT64_MAX/1000?UINT64_MAX:delta*1000/elapsed;snap.reports_per_second=ui_count(rate);memmove(rate_bins,rate_bins+1,9*sizeof *rate_bins);rate_bins[9]=snap.reports_per_second;}
        else {snap.reports_per_second=0;memset(rate_bins,0,sizeof rate_bins);}
        memcpy(snap.report_bins,rate_bins,sizeof rate_bins);previous_ms=now;previous_reports=c.callback_reports;previous_known=s_capture_ready&&c.running;
        snap.received=c.callback_reports;snap.dropped=raw.counters[3]>UINT64_MAX-c.callback_drops?UINT64_MAX:c.callback_drops+raw.counters[3];snap.written=raw.counters[1];snap.synced=raw.counters[2];snap.uptime_s=now/1000;
        snap.storage_errors=ui_count(raw.counters[4]+queue_errors);snap.free_known=tf_known;snap.total_bytes=tf_total;snap.free_bytes=tf_free;
        snap.internal_free=heap_caps_get_free_size(MALLOC_CAP_INTERNAL|MALLOC_CAP_8BIT);snap.internal_total=heap_caps_get_total_size(MALLOC_CAP_INTERNAL|MALLOC_CAP_8BIT);snap.memory_known=snap.internal_total!=0;
        snap.psram_free=heap_caps_get_free_size(MALLOC_CAP_SPIRAM);snap.psram_total=heap_caps_get_total_size(MALLOC_CAP_SPIRAM);snap.psram_known=snap.psram_total!=0;
        raw_battery_sample_t bat;if(raw_battery_read(&bat)==ESP_OK&&bat.known){snap.battery_known=true;snap.battery_mv=bat.millivolts;snap.battery_percent=bat.estimated_percent;}
        uint64_t rtc;
        if(raw_clock_get(&rtc)==ESP_OK){
            snap.clock_known=true;snap.utc_epoch=rtc;
            cp_v3_temporal_time_t trusted;
            if(snap.clock_calibrated){bool mapped=clock_copy(NULL,now,&trusted);uint64_t utc=rtc*1000;uint64_t delta=mapped?(utc>trusted.utc_ms?utc-trusted.utc_ms:trusted.utc_ms-utc):UINT64_MAX;snap.clock_calibrated=mapped&&delta<=1000u+(uint64_t)trusted.uncertainty_ms;}
        }else snap.clock_known=snap.clock_calibrated=false;
        snap.setup_available=s_usb_stop&&s_safe;snap.setup_stopping=s_stop&&!s_safe;
        edge_ui_state(&metrics);
        if(ready)(void)raw_display_present(&snap);
        if(final_display){if(ready)(void)raw_display_sleep();s_display_asleep=true;vTaskDelete(NULL);}
        vTaskDelay(pdMS_TO_TICKS(1500));
    }
}
static void key_task(void *unused) {
    (void)unused;unsigned power=0,boot=0;bool armed=false,boot_held=false,boot_long=false;
    for(;;){
        bool pressed=raw_power_pressed();if(!pressed){armed=true;power=0;}else if(armed&&++power>=50){s_power_stop=true;s_usb_stop=false;s_stop=true;cp_v3_transport_cancel();}
        bool b=raw_boot_pressed();if(b){if(!boot_held){boot_held=true;boot_long=false;boot=0;}if(!boot_long&&++boot>=100){boot_long=true;s_usb_stop=true;if(s_bootstrapped){s_stop=true;cp_v3_transport_cancel();}portENTER_CRITICAL(&s_lock);s_display.page=4;portEXIT_CRITICAL(&s_lock);}}
        else if(boot_held){if(!boot_long&&boot>=2){unsigned pages=!s_bootstrapped||s_usb_stop?5:4;portENTER_CRITICAL(&s_lock);s_display.page=s_display.page+1>=pages?0:s_display.page+1;portEXIT_CRITICAL(&s_lock);}boot_held=false;}
        if(s_stop&&s_safe&&s_power_stop&&s_display_asleep&&!pressed)(void)raw_power_shutdown();
        vTaskDelay(pdMS_TO_TICKS(20));
    }
}
static _Noreturn void fault(const char *reason) {
    ESP_LOGE(TAG,"startup_failed=%s",reason);phase("START FAILED");
    /* No unsafe power release: existing key task remains alive. */
    for(;;)vTaskDelay(pdMS_TO_TICKS(1000));
}
static void iso(uint64_t ms,char out[25]) {
    time_t sec=(time_t)(ms/1000);struct tm tm;gmtime_r(&sec,&tm);if(strftime(out,20,"%Y-%m-%dT%H:%M:%S",&tm)!=19){out[0]=0;return;}snprintf(out+19,6,".%03uZ",(unsigned)(ms%1000));
}
static size_t capabilities(char *out,size_t cap,cp_v3_time_t t,uint64_t free_bytes) {
    char issued[25],expires[25],id[37];iso(t.utc_ms-5000,issued);iso(t.utc_ms+1800000,expires);uuid4(id);
    /* These are supported ceilings. Policy application must allocate the
     * actual stats/history pools and pass all resource floors before ACK. */
    uint64_t tf_usable=free_bytes>1048576?free_bytes-1048576:0;if(tf_usable>33554432u+1048576u+QUEUE_BYTES)tf_usable=33554432u+1048576u+QUEUE_BYTES;
    int n=snprintf(out,cap,"{\"schema\":\"device-capabilities/1\",\"capability_id\":\"small-%s\",\"node_id\":\"%s\",\"boot_id\":\"%s\",\"producer_version\":\"cp-v3-small/1\",\"policy_schemas\":[\"device-config/3\"],\"issued_at\":\"%s\",\"expires_at\":\"%s\","
        "\"scanner\":{\"modes\":[\"passive\"],\"phys\":[\"1m\"],\"duplicate_filter\":[false],\"min_interval_units\":4,\"max_interval_units\":16384},"
        "\"summary\":{\"max_addresses\":512,\"max_bins\":12,\"max_window_ms\":60000},"
        "\"statistics\":{\"schemas\":[\"window-statistics/1\"],\"extractor_versions\":[\"cp-v3-stats/1\"],\"ruleset_versions\":[\"unclassified-v1\"]},"
        "\"temporal\":{\"slice_ms\":[2000],\"max_history_ms\":600000,\"max_tracks\":512,\"max_open_events\":64,\"max_event_ms\":3600000,\"event_schemas\":[\"candidate-event/1\"],\"report_modes\":[\"off\",\"terminal_only\"]},"
        "\"local_raw\":{\"formats\":[\"cpraw/1\"],\"max_segment_bytes\":1048576,\"min_sync_interval_ms\":1000},"
        "\"uplink\":{\"transports\":[\"%s\"],\"streams\":[\"window_statistics\",\"node_status\",\"candidate_events\"],\"max_batch_items\":1,\"max_body_bytes\":2048,\"max_sample_reports_per_window\":0,\"cpraw_archive\":false},"
        "\"queue\":{\"media\":[{\"medium\":\"tf_journal\",\"usable_bytes\":24576,\"max_items\":12,\"power_loss_recovery\":true}]},"
        "\"resources\":{\"max_working_bytes\":4194304,\"max_storage_write_bytes_per_day\":67108864,\"tf_usable_bytes\":%llu}}",id,s_node,s_boot,issued,expires,s_bootstrap.transport==CP_V3_TRANSPORT_MQTT_TLS?"mqtt_tls":"https",(unsigned long long)tf_usable);
    return n>0&&(size_t)n<cap?(size_t)n:0;
}
/* Only the raw writer calls this after startup. Actual RTC seconds are used,
 * and disagreement with the trusted map invalidates the anchor. I2C never runs
 * in the BLE callback/collector or uplink owner while the writer is active. */
static bool raw_rtc_clock(void *ctx,uint64_t mono,cp_v3_temporal_time_t *out) {
    (void)ctx;cp_v3_temporal_time_t expected;uint64_t seconds;
    if(!clock_copy(NULL,mono,&expected)||raw_clock_get(&seconds)!=ESP_OK)return false;
    uint64_t after=monotonic_ms();if(after<mono||after-mono>5000||seconds>UINT64_MAX/1000)return false;
    uint64_t actual=seconds*1000,diff=actual>expected.utc_ms?actual-expected.utc_ms:expected.utc_ms-actual;
    if(diff>1000u+(uint64_t)expected.uncertainty_ms+after-mono){portENTER_CRITICAL(&s_lock);s_display.clock_known=false;portEXIT_CRITICAL(&s_lock);return false;}
    /* local_raw adds the RTC's 1000ms quantization before encoding; include
     * the independent I2C read interval here without rounding drift twice. */
    expected.utc_ms=actual;expected.uncertainty_ms+=(uint32_t)(after-mono);*out=expected;return true;
}
static bool calibrate_rtc(void) {
    cp_v3_temporal_time_t t;uint64_t readback=0;bool checked=clock_copy(NULL,monotonic_ms(),&t);
    if(checked){uint64_t seconds=t.utc_ms/1000;checked=raw_clock_set(seconds)==ESP_OK&&raw_clock_get(&readback)==ESP_OK&&(readback>seconds?readback-seconds:seconds-readback)<=1;}
    portENTER_CRITICAL(&s_lock);s_display.clock_known=checked;s_display.clock_calibrated=checked;s_display.utc_epoch=checked?readback:0;portEXIT_CRITICAL(&s_lock);
    ESP_LOGI(TAG,"rtc_set_readback_verified=%u",(unsigned)checked);
    return local_raw_set_clock(s_raw,raw_rtc_clock,NULL,RAW_CLOCK_HOST_CALIBRATED_RTC,checked)==ESP_OK;
}
static bool raw_hook(void *ctx,const cp_v3_stats_report_t *r){(void)ctx;return s_raw?local_raw_hook(s_raw,r):false;}
static cp_v3_apply_result_t actual_apply(void *ctx,const cp_v3_trial_policy_t *p,cp_v3_boundary_t *b) {
    (void)ctx;if(b->window_open||b->segment_open||s_capture)return CP_V3_APPLY_BOUNDARY_FAILED;
    if(p->mqtt_tls!=(s_bootstrap.transport==CP_V3_TRANSPORT_MQTT_TLS))return CP_V3_APPLY_UNSUPPORTED;
    if(!p->statistics||!p->tf_queue||!p->stats_max_addresses||p->stats_max_addresses>512||p->bin_ms!=5000||
       (p->window_ms!=30000&&p->window_ms!=60000)||p->max_body_bytes!=BODY_MAX||
       p->queue_max_bytes!=QUEUE_BYTES||p->queue_max_items!=12||p->window_reserve_items!=4||(p->candidate_events?p->event_reserve_items!=4:p->event_reserve_items!=0)||p->status_reserve_items!=2||p->control_reserve_items!=2||
       p->window_reserve_bytes!=8192||(p->candidate_events?p->event_reserve_bytes!=8192:p->event_reserve_bytes!=0)||p->status_reserve_bytes!=4096||p->control_reserve_bytes!=4096||
       (s_bootstrap.max_windows&&p->retry_max_attempts<2)||p->working_bytes>WORKING_MAX||p->storage_write_bytes_per_day>WRITE_MAX||
       (p->temporal.rolling&&(p->temporal.slice_ms!=2000||p->temporal.max_tracks>512||p->temporal.max_open_events>64||p->temporal.max_event_ms>3600000||p->temporal.report_mode==CP_V3_TEMPORAL_REPORT_REVISIONS)))return CP_V3_APPLY_UNSUPPORTED;
    if(p->local_raw.enabled&&(p->local_raw.max_segment_bytes>1048576||p->local_raw.max_total_bytes>33554432||p->local_raw.min_free_bytes<1048576||p->local_raw.sync_interval_ms!=1000||p->storage_write_bytes_per_day<p->local_raw.max_total_bytes+FS_POOL))return CP_V3_APPLY_UNSUPPORTED;
    if(!s_storage_ready||s_storage_fault)return CP_V3_APPLY_RESOURCE_EXHAUSTED;
    xSemaphoreTake(s_tf,portMAX_DELAY);
    bool budget=cp_v3_budget_configure(&s_budget,p->storage_write_bytes_per_day,65536)==CP_V3_BUDGET_OK&&cp_v3_budget_configure(&s_uplink_budget,p->max_upload_bytes_per_day,65536)==CP_V3_BUDGET_OK;
    uint64_t total,free_bytes;bool storage=budget&&raw_storage_capacity(&total,&free_bytes)==ESP_OK&&free_bytes>FS_POOL+1048576&&s_queue->ready&&!s_queue->corrupt_slots&&!s_queue->retired_slots;xSemaphoreGive(s_tf);
    if(!storage)return CP_V3_APPLY_STORAGE_FAILED;
    if(!calibrate_rtc())return CP_V3_APPLY_INTERNAL_ERROR;
    if(p->local_raw.enabled){
        local_raw_config_t raw={p->local_raw.max_segment_bytes,p->local_raw.max_total_bytes,p->local_raw.min_free_bytes,p->local_raw.sync_interval_ms};
        if(local_raw_probe(s_raw,&raw,NULL)!=ESP_OK)return CP_V3_APPLY_STORAGE_FAILED;
    }
    cp_v3_capture_config_t config={.statistics={.capacity=p->stats_max_addresses,.window_ms=p->window_ms,.bin_ms=p->bin_ms,.rules_version=CP_V3_STATS_RULESET},
        .temporal_enabled=p->temporal.rolling,.report_events=p->candidate_events,.context={1,p->scope.assignment_generation,p->scope.assignment_generation},
        .report_slots=128,.window_slots=4,.event_slots=4,.stop_after_windows=s_bootstrap.max_windows,.min_internal_free=56000,.min_internal_largest=20000,.min_psram_free=512u*1024,.min_psram_largest=128u*1024,
        .clock=clock_copy,.entropy=entropy,.raw=p->local_raw.enabled?raw_hook:NULL};
    config.temporal=(cp_v3_temporal_config_t){p->temporal.max_tracks,p->temporal.max_open_events,4,(uint16_t)p->temporal.slice_ms,p->temporal.history_ms,p->temporal.gap_ms,p->temporal.max_event_ms};
    size_t temporal=p->temporal.rolling?cp_v3_temporal_memory_bytes(&config.temporal):0;
    size_t estimate=temporal+cp_v3_stats_memory_bytes(p->stats_max_addresses)+128u*(sizeof(cp_v3_stats_report_t)+1650u)+4u*sizeof(cp_v3_capture_window_t)+4u*sizeof(cp_v3_capture_event_t)+local_raw_memory_bytes()+FS_POOL;
    if((p->temporal.rolling&&!temporal)||estimate>p->working_bytes||heap_caps_get_free_size(MALLOC_CAP_SPIRAM)<estimate)return CP_V3_APPLY_RESOURCE_EXHAUSTED;
    cp_v3_transport_memory_t memory;
    if(cp_v3_transport_begin_memory(2000,&memory)!=ESP_OK)return CP_V3_APPLY_RESOURCE_EXHAUSTED;
    if((p->mqtt_tls&&!memory.mqtt_hot)||memory.persistent_external_bytes>p->working_bytes-estimate){
        cp_v3_transport_end_memory();return CP_V3_APPLY_RESOURCE_EXHAUSTED;
    }
    config.min_internal_free=memory.min_internal_free;config.min_internal_largest=memory.min_internal_largest;
    esp_err_t prepared=cp_v3_capture_prepare(&config,&s_capture);
    cp_v3_transport_end_memory();
    if(prepared!=ESP_OK){
        cp_v3_capture_status_t failed;cp_v3_capture_prepare_status(&failed);
        ESP_LOGE(TAG,"capture_prepare_failed error=%ld stage=%s internal=%lu largest=%lu psram=%lu psram_largest=%lu",(long)prepared,failed.failure_stage,(unsigned long)failed.internal_free,(unsigned long)failed.internal_largest,(unsigned long)failed.psram_free,(unsigned long)failed.psram_largest);
        ESP_LOGE(TAG,"arena_alignment stats=%u/%u temporal=%u/%u",failed.statistics_alignment,failed.statistics_alignment_remainder,failed.temporal_alignment,failed.temporal_alignment_remainder);
        return CP_V3_APPLY_RESOURCE_EXHAUSTED;
    }
    cp_v3_capture_status_t status;cp_v3_capture_status(s_capture,&status);
    if(!status.prepared||status.running||status.failed||heap_caps_get_free_size(MALLOC_CAP_INTERNAL|MALLOC_CAP_8BIT)<memory.min_internal_free||heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL|MALLOC_CAP_8BIT)<memory.min_internal_largest||heap_caps_get_free_size(MALLOC_CAP_SPIRAM)<512u*1024||heap_caps_get_largest_free_block(MALLOC_CAP_SPIRAM)<128u*1024)return CP_V3_APPLY_RESOURCE_EXHAUSTED;
    s_capture_ready=true;
    ESP_LOGI(TAG,"resources_reserved stats=%u temporal=%u report=%u window=%u event=%u raw=%u queue_pool=%u",(unsigned)status.statistics_bytes,(unsigned)status.temporal_bytes,(unsigned)status.report_bytes,(unsigned)status.window_bytes,(unsigned)status.event_bytes,(unsigned)local_raw_memory_bytes(),FS_POOL);
    ESP_LOGI(TAG,"arena_alignment stats=%u/%u temporal=%u/%u",status.statistics_alignment,status.statistics_alignment_remainder,status.temporal_alignment,status.temporal_alignment_remainder);
    return CP_V3_APPLY_OK;
}
static bool request_mode(cp_v3_http_method_t method,const char *path,const void *body,size_t bytes,cp_v3_transport_response_t *r,bool receipt_only) {
    memset(r,0,sizeof *r);
    s_error_code="unavailable";s_error_retryable=true;
    if(method==CP_V3_HTTP_POST&&bytes){
        xSemaphoreTake(s_tf,portMAX_DELAY);bool charged=uplink_charge(bytes);xSemaphoreGive(s_tf);
        if(!charged){s_upload_failures++;ESP_LOGW(TAG,"uplink_budget_denied no_send=1");return false;}
    }
    uint64_t started=monotonic_ms();
    esp_err_t e=receipt_only?cp_v3_transport_request_receipt_only(method,path,body,bytes,s_reply,CP_V3_TRANSPORT_RESPONSE_MAX,r):
        cp_v3_transport_request(method,path,body,bytes,s_reply,CP_V3_TRANSPORT_RESPONSE_MAX,r);
    if(e!=ESP_OK||!r->complete||r->http_status<200||r->http_status>=300){
        if(e==ESP_OK&&r->complete)s_error_code=edge_error_code(s_reply,r->body_bytes,&s_error_retryable);
        int status=r->complete?r->http_status:r->parsed_http_status;
        s_error_retryable=edge_http_response_retryable(status,s_error_retryable);
        s_upload_failures++;
        ESP_LOGW(TAG,"request_failed error=%ld status=%d parsed_http_status=%d stage=%u retryable=%u elapsed_ms=%llu dns=%ld resolved_ipv4=%lu tls_connected=%ld io=%ld last_read=%ld last_write=%ld rx=%lu tx=%lu tls_esp_error=%ld tls_stack_error=%ld tls_verify_flags=%ld whole_flush_attempted=%u whole_flush_succeeded=%u whole_flush_error=%ld",
            (long)e,r->http_status,r->parsed_http_status,(unsigned)r->stage,(unsigned)s_error_retryable,(unsigned long long)(monotonic_ms()-started),
            (long)r->dns_error,(unsigned long)r->resolved_ipv4,(long)r->tls_connected,(long)r->io_error,(long)r->last_read,(long)r->last_write,
            (unsigned long)r->received_bytes,(unsigned long)r->written_bytes,(long)r->tls_esp_error,(long)r->tls_stack_error,(long)r->tls_verify_flags,
            (unsigned)r->whole_flush_attempted,(unsigned)r->whole_flush_succeeded,(long)r->whole_flush_error);
        ESP_LOGW(TAG,"transport_mode=%u mqtt_ready=%u mqtt_response=%u mqtt_retained=%u mqtt_stop_confirmed=%u mqtt_publish_id=%ld mqtt_puback_id=%ld mqtt_connect_code=%ld mqtt_outbox=%lu mqtt_stack_min=%lu",
            (unsigned)s_bootstrap.transport,(unsigned)r->mqtt_session_ready,(unsigned)r->mqtt_response_received,(unsigned)r->mqtt_retained,(unsigned)r->mqtt_stop_confirmed,
            (long)r->mqtt_publish_id,(long)r->mqtt_puback_id,(long)r->mqtt_connect_code,(unsigned long)r->mqtt_outbox_bytes,(unsigned long)r->mqtt_callback_stack_min);
        return false;
    }return true;
}
static bool request(cp_v3_http_method_t method,const char *path,const void *body,size_t bytes,cp_v3_transport_response_t *r) {
    return request_mode(method,path,body,bytes,r,false);
}
static bool registration_stopped(void *ctx) { (void)ctx; return s_stop; }
static bool registration_attempt(void *ctx,const void *body,size_t bytes,unsigned attempt,bool *retryable) {
    cp_v3_transport_response_t *r=ctx;
    if(attempt)s_retries++;
    ESP_LOGI(TAG,"registration_attempt=%u body_bytes=%u",attempt+1,(unsigned)bytes);
    bool okay=request(CP_V3_HTTP_POST,"/api/v3/device/capabilities",body,bytes,r);
    /* Budget/preflight failure (IDLE) or explicit certificate-verification
     * failure cannot benefit from another startup request. */
    *retryable=!okay&&s_error_retryable&&r->stage!=CP_V3_TRANSPORT_IDLE&&!r->tls_verify_flags;
    return okay;
}
static bool registration_wait(void *ctx,uint32_t delay_ms) {
    (void)ctx;
    while(delay_ms&&!s_stop){uint32_t step=delay_ms<100?delay_ms:100;vTaskDelay(pdMS_TO_TICKS(step));delay_ms-=step;}
    return !s_stop;
}
static bool control_match(void *ctx,const cp_v3_expected_t *e,const void *body,size_t bytes,const void *receipt,size_t length) {
    (void)ctx;return cp_v3_control_match_frozen_receipt(s_workspace,&e->scope,body,bytes,receipt,length,cp_v3_transport_sha256,NULL)==CP_V3_CONTROL_OK;
}
static void body_hash(const void *body,size_t bytes,char out[65]) {
    uint8_t digest[32];(void)cp_v3_transport_sha256(NULL,body,bytes,digest);for(unsigned i=0;i<32;i++)snprintf(out+2*i,3,"%02x",digest[i]);
}
static bool control_exchange(const char *stream,const char *path,const char *body,size_t bytes,uint32_t seq,bool lease) {
    cp_v3_expected_t e={.scope=s_control->policy.scope,.seq_first=seq,.seq_last=seq,.accepted_count=1,.body_bytes=bytes};uuid4(e.batch_id);strcpy(e.stream,stream);body_hash(body,bytes,e.body_sha256);
    unsigned slot;xSemaphoreTake(s_tf,portMAX_DELAY);
    size_t encoded=cp_v3_queue_encoded_size(s_queue,bytes);
    if(!encoded||!write_charge(NULL,edge_lifecycle_charge(encoded))){xSemaphoreGive(s_tf);return false;}
    s_publish_authorized=true;s_publish_allowance=edge_lifecycle_charge(encoded);
    cp_v3_queue_result_t saved=cp_v3_queue_push_expiring(s_queue,CP_V3_QUEUE_CONTROL,&e,body,bytes,s_control->policy.accept_until_utc_ms,&slot);s_publish_authorized=false;xSemaphoreGive(s_tf);
    if(saved!=CP_V3_QUEUE_OK){ESP_LOGE(TAG,"control_durability_failed=%u",(unsigned)saved);return false;}
    cp_v3_expected_t frozen;size_t frozen_bytes;
    xSemaphoreTake(s_tf,portMAX_DELAY);cp_v3_queue_result_t read=cp_v3_queue_read(s_queue,slot,s_network_body,BODY_MAX,&frozen_bytes,&frozen);xSemaphoreGive(s_tf);
    if(read!=CP_V3_QUEUE_OK||frozen_bytes!=bytes||strcmp(frozen.body_sha256,e.body_sha256)||memcmp(s_network_body,body,bytes))return false;
    for(unsigned attempt=0;attempt<s_control->policy.retry_max_attempts&&!s_stop;attempt++){
        if(attempt)s_retries++;
        cp_v3_transport_response_t r;if(request(CP_V3_HTTP_POST,path,s_network_body,frozen_bytes,&r)){
            cp_v3_time_t t;if(!current(&t))return false;
            cp_v3_control_result_t matched=lease?cp_v3_control_lease_receipt(s_control,s_reply,r.body_bytes,t):cp_v3_control_ack_receipt(s_control,s_reply,r.body_bytes,t);
            if(matched!=CP_V3_CONTROL_OK){s_ack_failures++;return false;}
            xSemaphoreTake(s_tf,portMAX_DELAY);cp_v3_queue_result_t reclaimed=cp_v3_queue_ack_control(s_queue,slot,s_reply,r.body_bytes,control_match,NULL);xSemaphoreGive(s_tf);
            if(reclaimed!=CP_V3_QUEUE_OK)return false;
            ESP_LOGI(TAG,"control_committed_reclaimed stream=%s seq=%lu",stream,(unsigned long)seq);return true;
        }
        vTaskDelay(pdMS_TO_TICKS(s_control->policy.retry_min_ms));
    }
    return false;
}
/* A pending handoff's body+UUID+sequence are assigned exactly once. An uncertain
 * write never releases the volatile handoff or substitutes a new identity. */
typedef struct {
    bool active,window,event,budget_prepaid;uint32_t prepaid_day;cp_v3_queue_kind_t kind;cp_v3_expected_t expected;
    uint64_t reports,drops;
    uint64_t rssi_samples;int64_t rssi_sum;int16_t rssi_min,rssi_max;
    uint64_t expiry;size_t bytes;char body[BODY_MAX];
    uint32_t window_seq,revision;uint64_t generation;uint8_t event_id[16];
} pending_t;
static bool persist_pending(pending_t *p) {
    if(!p->active)return true;
    xSemaphoreTake(s_tf,portMAX_DELAY);unsigned slot;
    uint64_t lower,upper;bool day_known=queue_clock(NULL,&lower,&upper)&&lower/86400000==upper/86400000;
    size_t encoded=cp_v3_queue_encoded_size(s_queue,p->bytes);
    if(!day_known||!encoded||(!p->budget_prepaid||p->prepaid_day!=(uint32_t)(lower/86400000))){
        if(!encoded||!write_charge(NULL,encoded?edge_lifecycle_charge(encoded):1)){xSemaphoreGive(s_tf);s_storage_fault=true;(void)cp_v3_capture_pause(s_capture,CP_V3_TEMPORAL_CAPACITY,0);return false;}
        p->budget_prepaid=true;p->prepaid_day=s_budget.record.utc_day;
    }
    s_publish_authorized=true;s_publish_allowance=edge_lifecycle_charge(encoded);
    cp_v3_queue_result_t result=cp_v3_queue_push_expiring(s_queue,p->kind,&p->expected,p->body,p->bytes,p->expiry,&slot);
    s_publish_authorized=false;xSemaphoreGive(s_tf);
    if(result!=CP_V3_QUEUE_OK){
        if(result!=CP_V3_QUEUE_FULL){s_storage_fault=true;ESP_LOGE(TAG,"freeze_uncertain kind=%u result=%u identity_preserved=1",(unsigned)p->kind,(unsigned)result);}
        if(result==CP_V3_QUEUE_FULL)s_storage_backpressure=true;
        (void)cp_v3_capture_pause(s_capture,CP_V3_TEMPORAL_CAPACITY,0);
        return false;
    }
    bool released=true;if(p->window)released=cp_v3_capture_window_release(s_capture,p->window_seq,p->generation);
    if(p->event)released=cp_v3_capture_event_release(s_capture,p->event_id,p->revision);
    if(!released){s_storage_fault=true;return false;}
    if(p->window){
        s_last_durable_window=p->window_seq;s_windows++;
        portENTER_CRITICAL(&s_lock);s_last_body=p->bytes;s_ui_last_reports=p->reports;s_ui_last_drops=p->drops;s_ui_last_known=true;
        s_display.rssi_known=p->rssi_samples&&p->rssi_samples<=INT64_MAX;s_display.rssi_samples=ui_count(p->rssi_samples);
        memmove(s_display.rssi_bins,s_display.rssi_bins+1,9*sizeof s_display.rssi_bins[0]);memmove(s_display.rssi_bin_known,s_display.rssi_bin_known+1,9*sizeof s_display.rssi_bin_known[0]);
        s_display.rssi_bin_known[9]=s_display.rssi_known;
        if(s_display.rssi_known){s_display.rssi_min=p->rssi_min;s_display.rssi_max=p->rssi_max;s_display.rssi_mean=(int16_t)(p->rssi_sum/(int64_t)p->rssi_samples);s_display.rssi_bins[9]=s_display.rssi_mean;}else s_display.rssi_bins[9]=0;
        portEXIT_CRITICAL(&s_lock);ESP_LOGI(TAG,"window_frozen w=%lu body_bytes=%u",(unsigned long)p->window_seq,(unsigned)p->bytes);
    }
    memset(p,0,sizeof *p);return true;
}
static void storage_task(void *unused) {
    (void)unused;pending_t *p=psram(sizeof *p);cp_v3_capture_window_t *w=psram(sizeof *w);cp_v3_capture_event_t *event=psram(sizeof *event);
    if(!p||!w||!event){s_storage_fault=true;s_storage_done=true;vTaskDelete(NULL);return;}
    s_storage_ready=true;
    while(!s_storage_gate&&!s_storage_stop)vTaskDelay(pdMS_TO_TICKS(10));
    if(s_storage_stop){heap_caps_free(p);heap_caps_free(w);heap_caps_free(event);s_storage_done=true;vTaskDelete(NULL);return;}
    uint32_t last_status_window=0;
    for(;;){
        xSemaphoreTake(s_tf,portMAX_DELAY);(void)cp_v3_queue_expire(s_queue);xSemaphoreGive(s_tf);
        if(p->active){if(!persist_pending(p)){vTaskDelay(pdMS_TO_TICKS(100));continue;}}
        bool got=false;char batch[37];
        if(cp_v3_capture_window(s_capture,w,0)){
            ESP_LOGI(TAG,"window_source w=%lu reports=%llu callback_loss=%llu aggregation_loss=%llu overflow=%llu history_slices=%u tracks=%u coverage=%lu flags=%lu",(unsigned long)w->window_seq,(unsigned long long)w->statistics.received_reports,(unsigned long long)w->statistics.callback_drops,(unsigned long long)w->statistics.aggregation_drops,(unsigned long long)w->statistics.address_overflow_reports,w->temporal.history_slices,w->temporal.tracks,(unsigned long)w->statistics.scan_coverage_ms,(unsigned long)w->statistics.quality_mask);
            if(s_window_seq==UINT32_MAX){s_storage_fault=true;break;}uuid4(batch);
            p->kind=CP_V3_QUEUE_WINDOW;p->window=true;p->window_seq=w->window_seq;p->generation=w->scope.assignment_generation;
            p->reports=w->statistics.received_reports;p->drops=w->statistics.callback_drops+w->statistics.aggregation_drops;
            p->rssi_samples=w->statistics.rssi_samples;p->rssi_sum=w->statistics.rssi_sum;p->rssi_min=w->statistics.rssi_min;p->rssi_max=w->statistics.rssi_max;
            if(cp_v3_small_window_body(&w->scope,&w->statistics,w->end_time,batch,++s_window_seq,cp_v3_transport_sha256,NULL,p->body,s_control->policy.max_body_bytes,&p->bytes,&p->expected)!=CP_V3_OK||!edge_retention_expiry(w->end_time,w->statistics.duration_ms,s_control->policy.source_retention_hours,&p->expiry)){s_storage_fault=true;break;}
            p->active=true;got=true;
        }else if(cp_v3_capture_event(s_capture,event,0)){
            if(!event->report_allowed){s_storage_fault=true;break;}
            if(s_event_seq==UINT32_MAX){s_storage_fault=true;break;}uuid4(batch);p->kind=CP_V3_QUEUE_EVENT;p->event=true;
            memcpy(p->event_id,event->event.event_id,16);p->revision=event->event.revision;
            if(cp_v3_small_event_body(&event->scope,&event->event,event->slice_ms,batch,++s_event_seq,cp_v3_transport_sha256,NULL,p->body,s_control->policy.max_body_bytes,&p->bytes,&p->expected)!=CP_V3_OK||!edge_retention_expiry(event->event.start,0,s_control->policy.source_retention_hours,&p->expiry)){s_storage_fault=true;break;}p->active=true;got=true;
        }else if(s_windows>last_status_window){
            cp_v3_small_status_t status={0};if(!clock_copy(NULL,monotonic_ms(),&status.time)){s_storage_fault=true;break;}
            cp_v3_capture_status_t cs;cp_v3_capture_status(s_capture,&cs);status.state=cs.failed?CP_V3_SMALL_FAILED:cs.running?CP_V3_SMALL_RUNNING:CP_V3_SMALL_PAUSED;
            status.resource_known_mask=31;status.resources[0]=heap_caps_get_free_size(MALLOC_CAP_INTERNAL|MALLOC_CAP_8BIT);status.resources[1]=heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL|MALLOC_CAP_8BIT);status.resources[2]=heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL|MALLOC_CAP_8BIT);status.resources[3]=heap_caps_get_free_size(MALLOC_CAP_SPIRAM);status.resources[4]=cs.collector_stack_min;
            if(status.resources[2]>status.resources[0])status.resource_known_mask&=~4u;
            xSemaphoreTake(s_tf,portMAX_DELAY);cp_v3_queue_kind_t kinds[]={CP_V3_QUEUE_WINDOW,CP_V3_QUEUE_EVENT,CP_V3_QUEUE_STATUS};for(unsigned k=0;k<3;k++){status.queue[k*2]=cp_v3_queue_pending(s_queue,kinds[k]);status.queue[k*2+1]=cp_v3_queue_pending_bytes(s_queue,kinds[k]);}xSemaphoreGive(s_tf);
            /* Backpressure is not a discarded window/event. Handoffs are retained. */
            status.losses[0]=0;status.losses[1]=0;
            if(s_windows-last_status_window>1)s_status_coalesced+=s_windows-last_status_window-1;
            status.losses[2]=s_status_coalesced;status.losses[3]=s_upload_failures;status.losses[4]=s_ack_failures;status.losses[5]=s_retries;
            local_raw_status_t raw;local_raw_snapshot(s_raw,&raw);status.local_raw_counters_known=s_control->policy.local_raw.enabled;memcpy(status.local_raw,raw.counters,sizeof status.local_raw);
            cp_v3_scope_t scope=s_control->policy.scope;scope.window_seq=s_windows;uuid4(batch);p->kind=CP_V3_QUEUE_STATUS;
            if(s_status_seq==UINT32_MAX||cp_v3_small_status_body(&scope,&status,batch,++s_status_seq,cp_v3_transport_sha256,NULL,p->body,s_control->policy.max_body_bytes,&p->bytes,&p->expected)!=CP_V3_OK||!edge_retention_expiry(status.time,0,s_control->policy.source_retention_hours,&p->expiry)){s_storage_fault=true;break;}
            p->active=true;got=true;last_status_window=s_windows;
        }
        if(!got&&s_storage_stop)break;
        if(!got&&s_storage_backpressure&&!s_storage_fault){
            cp_v3_capture_status_t status;cp_v3_capture_status(s_capture,&status);
            if(status.quiescent&&!status.window_handoffs&&!status.event_handoffs&&edge_storage_resume_ready(status.paused,status.running,status.bounded_complete,s_last_durable_window,status.last_closed_window_seq,status.temporal.terminal_events,status.temporal.pending_terminals))s_storage_resume=true;
        }
        /* The collector enforces the exact full-window trial boundary. */
        if(!got)vTaskDelay(pdMS_TO_TICKS(25));
    }
    if(s_storage_fault)(void)cp_v3_capture_pause(s_capture,CP_V3_TEMPORAL_CAPACITY,2000);
    /* On uncertainty deliberately retain p and its exact body/identity in RAM. */
    if(!s_storage_fault){heap_caps_free(p);heap_caps_free(w);heap_caps_free(event);}s_storage_done=true;vTaskDelete(NULL);
}
/* Validate the already hash-checked frozen JSON's observation upper bound.
 * Ingest requires all timestamps to have aged before sending; body bytes stay
 * unchanged, including on old-boot replay and unknown-clock deferral. */
static bool frozen_aged(const char *body,size_t bytes) {
    uint64_t upper;cp_v3_temporal_time_t t;
    return edge_frozen_upper(body,bytes,&upper)&&clock_copy(NULL,monotonic_ms(),&t)&&edge_time_aged(t,upper);
}
static bool replay_historical_controls(void) {
    for(;;){
        unsigned slot;size_t bytes;cp_v3_expected_t e;
        xSemaphoreTake(s_tf,portMAX_DELAY);cp_v3_queue_result_t next=cp_v3_queue_oldest(s_queue,CP_V3_QUEUE_CONTROL,&slot);
        cp_v3_queue_result_t read=next==CP_V3_QUEUE_OK?cp_v3_queue_read(s_queue,slot,s_network_body,BODY_MAX,&bytes,&e):next;xSemaphoreGive(s_tf);
        if(next==CP_V3_QUEUE_NOT_FOUND)return true;
        if(read!=CP_V3_QUEUE_OK)return false;
        /* Never use a historical receipt to authorize this fresh boot. */
        if(!strcmp(e.scope.boot_id,s_boot))return false;
        const char *path=!strcmp(e.stream,"lease")?"/api/v3/device/lease":"/api/v3/device/config/ack";
        cp_v3_transport_response_t r;if(!request_mode(CP_V3_HTTP_POST,path,s_network_body,bytes,&r,true))return false;
        xSemaphoreTake(s_tf,portMAX_DELAY);cp_v3_queue_result_t ack=cp_v3_queue_ack_control(s_queue,slot,s_reply,r.body_bytes,control_match,NULL);xSemaphoreGive(s_tf);
        if(ack!=CP_V3_QUEUE_OK){s_ack_failures++;return false;}
        ESP_LOGI(TAG,"historical_control_reclaimed=1 current_boot_authority=0");
    }
}
static bool upload_one(cp_v3_queue_kind_t kind) {
    unsigned slot=0;size_t bytes=0;cp_v3_expected_t e;
    xSemaphoreTake(s_tf,portMAX_DELAY);cp_v3_queue_result_t next=edge_upload_oldest_ready(s_queue,kind,monotonic_ms(),s_attempt_hash,s_attempts,s_next_attempt,s_control->policy.retry_max_attempts,&slot);
    cp_v3_queue_result_t read=next==CP_V3_QUEUE_OK?cp_v3_queue_read(s_queue,slot,s_network_body,BODY_MAX,&bytes,&e):next;xSemaphoreGive(s_tf);
    if(next==CP_V3_QUEUE_NOT_FOUND)return true;
    if(read==CP_V3_QUEUE_CLOCK_UNKNOWN)return true;
    if(read!=CP_V3_QUEUE_OK)return false;
    if(!frozen_aged(s_network_body,bytes))return true;
    cp_v3_time_t t;if(!current(&t)||!cp_v3_control_permissions(s_control,t).uplink)return true;
    if(strcmp(s_attempt_hash[slot],e.body_sha256)){strcpy(s_attempt_hash[slot],e.body_sha256);s_attempts[slot]=0;s_next_attempt[slot]=0;}
    if(monotonic_ms()<s_next_attempt[slot])return true;
    if(s_attempts[slot]>=s_control->policy.retry_max_attempts)return true;
    if(s_attempts[slot])s_retries++;
    s_attempts[slot]++;
    uint64_t delay=s_control->policy.retry_min_ms;
    for(unsigned n=1;n<s_attempts[slot]&&delay<s_control->policy.retry_max_ms;n++)delay*=2;
    if(delay>s_control->policy.retry_max_ms)delay=s_control->policy.retry_max_ms;
    s_next_attempt[slot]=monotonic_ms()+delay;
    cp_v3_transport_response_t r;s_tx_bytes+=bytes;
    if(!request(CP_V3_HTTP_POST,"/api/v3/statistics/ingest",s_network_body,bytes,&r)){
        if(r.complete&&r.http_status>=400&&r.http_status<500&&!s_error_retryable){s_next_attempt[slot]=UINT64_MAX;ESP_LOGW(TAG,"batch_retained_rejected stream=%u code=%s retry_this_boot=0",(unsigned)kind,s_error_code);}
        return true;
    }
    if(!cp_v3_statistics_receipt_matches(s_reply,r.body_bytes,&e)){s_ack_failures++;return false;}
    bool historical=strcmp(e.scope.boot_id,s_boot)!=0;
    if(!historical&&!s_retry_tested&&s_bootstrap.max_windows&&kind==CP_V3_QUEUE_WINDOW){
        /* Exact first-window retry is an explicit controlled-test check only;
         * same frozen body and server receipt, before any queue reclamation. */
        char first[2048];if(r.body_bytes>=sizeof first)return false;size_t length=r.body_bytes;memcpy(first,s_reply,length);
        s_tx_bytes+=bytes;s_attempts[slot]++;s_retries++;
        if(!request(CP_V3_HTTP_POST,"/api/v3/statistics/ingest",s_network_body,bytes,&r)||!cp_v3_statistics_receipt_matches(s_reply,r.body_bytes,&e)||r.body_bytes!=length||memcmp(first,s_reply,length))return false;
        s_retry_tested=true;ESP_LOGI(TAG,"exact_retry_same_receipt=1 body_bytes=%u",(unsigned)bytes);
    }
    xSemaphoreTake(s_tf,portMAX_DELAY);cp_v3_queue_result_t ack=cp_v3_queue_ack(s_queue,slot,s_reply,r.body_bytes);xSemaphoreGive(s_tf);
    if(ack!=CP_V3_QUEUE_OK)return false;
    if(historical)s_historical_acks++;
    else if(kind==CP_V3_QUEUE_WINDOW)s_window_acks++;else if(kind==CP_V3_QUEUE_EVENT)s_event_acks++;else s_status_acks++;
    ESP_LOGI(TAG,"durable_acked stream=%u bytes=%u historical=%u window_acks=%lu status_acks=%lu",(unsigned)kind,(unsigned)bytes,(unsigned)historical,(unsigned long)s_window_acks,(unsigned long)s_status_acks);return true;
}
static bool run(void) {
    cp_v3_transport_config_t config={.origin=s_bootstrap.origin,.server_ca_pem=s_bootstrap.server_ca_pem[0]?s_bootstrap.server_ca_pem:NULL,.clock_seed=s_bootstrap.clock_seed,.wifi_timeout_ms=30000,.request_timeout_ms=edge_request_timeout_ms(s_bootstrap.origin),.server_clock_error_ms=100,.mode=s_bootstrap.transport,.active_boot=s_boot};
    phase("WIFI CONNECT");if(cp_v3_transport_start(&s_bootstrap.settings,&config)!=ESP_OK)return false;s_transport_started=true;
    ui_network_snapshot();
    cp_v3_time_t t;if(!current(&t))return false;
    /* Preserve original drift reference; transport's derived now is never used
     * as a freshly rounded anchor. All workers share the physical seed. */
    uint64_t free_bytes;xSemaphoreTake(s_tf,portMAX_DELAY);bool storage=raw_storage_space(&free_bytes)==ESP_OK;xSemaphoreGive(s_tf);if(!storage)return false;
    size_t bytes=capabilities(s_network_body,4096,t,free_bytes);
    if(!bytes||cp_v3_control_init(s_control,s_workspace,s_node,s_boot,s_network_body,bytes,t,cp_v3_transport_sha256,NULL)!=CP_V3_CONTROL_OK)return false;
    const char *body;if(cp_v3_control_registration(s_control,1,t.mono_ms,&body,&bytes)!=CP_V3_CONTROL_OK)return false;
    cp_v3_transport_response_t r;phase("REGISTER CAPS");
    edge_registration_io_t registration={&r,registration_stopped,registration_attempt,registration_wait};
    if(!edge_registration_exchange(&registration,body,bytes)||!current(&t)||cp_v3_control_registration_receipt(s_control,s_reply,r.body_bytes,t)!=CP_V3_CONTROL_OK)return false;
    if(!replay_historical_controls())return false;
    char path[128];snprintf(path,sizeof path,"/api/v3/device/config?boot_id=%s",s_boot);phase("WAIT POLICY");bool offered=false;
    for(unsigned i=0;i<180&&!s_stop;i++){
        if(request(CP_V3_HTTP_GET,path,NULL,0,&r)&&current(&t)&&cp_v3_control_offer(s_control,s_reply,r.body_bytes,t)==CP_V3_CONTROL_OK){offered=true;break;}
        vTaskDelay(pdMS_TO_TICKS(1000));
    }
    if(!offered||!current(&t))return false;
    cp_v3_boundary_t boundary={0};if(cp_v3_control_apply(s_control,t,boundary,++s_control_seq,actual_apply,NULL)!=CP_V3_CONTROL_OK)return false;
    body=cp_v3_control_ack_bytes(s_control,&bytes);phase("ACK DURABLE");
    if(!body||!control_exchange("config_ack","/api/v3/device/config/ack",body,bytes,s_control_seq,false))return false;
    if(s_control->apply_result!=CP_V3_APPLY_OK){ESP_LOGE(TAG,"failed_apply_committed result=%u",(unsigned)s_control->apply_result);return false;}
    ESP_LOGI(TAG,"policy_applied_committed=1 control_reclaimed=1");
    cp_v3_control_permissions_t permission={0};
    for(unsigned i=0;i<300&&!s_stop;i++){
        if(!current(&t))return false;
        permission=cp_v3_control_permissions(s_control,t);
        if(permission.collection)break;
        if(permission.reason!=CP_V3_CONTROL_WAIT)return false;
        vTaskDelay(pdMS_TO_TICKS(50));
    }
    if(!permission.collection||s_stop)return false;
    if(s_control->policy.local_raw.enabled){
        cp_v3_control_raw_t *p=&s_control->policy.local_raw;local_raw_config_t raw={p->max_segment_bytes,p->max_total_bytes,p->min_free_bytes,p->sync_interval_ms};uint8_t session[16];esp_fill_random(session,sizeof session);
        if(!permission.local_raw||local_raw_start(s_raw,&raw,s_boot,session)!=ESP_OK)return false;
    }
    if(cp_v3_capture_start(s_capture,&s_control->policy.scope,1,s_control->policy.scan_interval_units,s_control->policy.scan_window_units,permission.deadline_mono_ms)!=ESP_OK)return false;
    s_storage_gate=true;
    phase("SMALL COLLECT");uint64_t lease_at=monotonic_ms()+s_control->policy.lease_ms/3;uint32_t contact=0;
    bool okay=true;
    while(!s_stop&&!s_storage_fault){
        if(!current(&t)){okay=false;break;}permission=cp_v3_control_permissions(s_control,t);
        cp_v3_capture_status_t bounded;cp_v3_capture_status(s_capture,&bounded);
        if(bounded.bounded_complete)break;
        if(!permission.collection){(void)cp_v3_capture_pause(s_capture,CP_V3_TEMPORAL_LEASE_EXPIRED,2000);phase("LEASE PAUSED");}
        if(monotonic_ms()>=lease_at){
            if(contact==UINT32_MAX||cp_v3_control_lease_request(s_control,++contact,t.mono_ms,&body,&bytes)!=CP_V3_CONTROL_OK||!control_exchange("lease","/api/v3/device/lease",body,bytes,++s_control_seq,true)){okay=false;break;}
            if(!current(&t)){okay=false;break;}permission=cp_v3_control_permissions(s_control,t);
            cp_v3_capture_status_t state;cp_v3_capture_status(s_capture,&state);
            if(permission.collection&&state.running)(void)cp_v3_capture_deadline(s_capture,permission.deadline_mono_ms);
            lease_at=monotonic_ms()+s_control->policy.lease_ms/3;
        }
        if(permission.collection){
            cp_v3_capture_status_t paused;cp_v3_capture_status(s_capture,&paused);
            bool pressure_clear=!s_storage_backpressure||s_storage_resume;
            if(pressure_clear&&paused.paused&&paused.quiescent&&!paused.bounded_complete&&!paused.window_handoffs&&!paused.event_handoffs&&paused.last_closed_window_seq<UINT32_MAX&&cp_v3_capture_start(s_capture,&s_control->policy.scope,paused.last_closed_window_seq+1,s_control->policy.scan_interval_units,s_control->policy.scan_window_units,permission.deadline_mono_ms)==ESP_OK){s_storage_resume=false;s_storage_backpressure=false;phase("SMALL COLLECT");}
        }
        if(!upload_one(CP_V3_QUEUE_WINDOW)||!upload_one(CP_V3_QUEUE_EVENT)||!upload_one(CP_V3_QUEUE_STATUS)){okay=false;break;}
        cp_v3_capture_status_t state;cp_v3_capture_status(s_capture,&state);
        if(state.failed){okay=false;break;}
        portENTER_CRITICAL(&s_lock);s_display.received=state.callback_reports;s_display.dropped=state.callback_drops;portEXIT_CRITICAL(&s_lock);
        vTaskDelay(pdMS_TO_TICKS(s_control->policy.retry_min_ms));
    }
    if(cp_v3_capture_pause(s_capture,CP_V3_TEMPORAL_SCAN_GAP,5000)!=ESP_OK)okay=false;
    s_storage_stop=true;
    for(unsigned i=0;i<600&&!s_storage_done;i++){
        /* Draining uplink can free occupied slots while the last handoffs freeze. */
        if(!s_stop){(void)upload_one(CP_V3_QUEUE_WINDOW);(void)upload_one(CP_V3_QUEUE_EVENT);(void)upload_one(CP_V3_QUEUE_STATUS);}
        vTaskDelay(pdMS_TO_TICKS(50));
    }
    if(!s_storage_done||s_storage_fault)okay=false;
    if(!s_stop&&okay){
        for(unsigned i=0;i<300;i++){
            xSemaphoreTake(s_tf,portMAX_DELAY);uint64_t pending=edge_upload_pending_current(s_queue,CP_V3_QUEUE_WINDOW,s_boot)+edge_upload_pending_current(s_queue,CP_V3_QUEUE_EVENT,s_boot)+edge_upload_pending_current(s_queue,CP_V3_QUEUE_STATUS,s_boot);xSemaphoreGive(s_tf);
            if(!pending)break;
            if(!upload_one(CP_V3_QUEUE_WINDOW)||!upload_one(CP_V3_QUEUE_EVENT)||!upload_one(CP_V3_QUEUE_STATUS)){okay=false;break;}vTaskDelay(pdMS_TO_TICKS(100));
        }
    }
    if(s_bootstrap.max_windows){
        xSemaphoreTake(s_tf,portMAX_DELAY);uint64_t pending=edge_upload_pending_current(s_queue,CP_V3_QUEUE_WINDOW,s_boot)+edge_upload_pending_current(s_queue,CP_V3_QUEUE_EVENT,s_boot)+edge_upload_pending_current(s_queue,CP_V3_QUEUE_STATUS,s_boot);xSemaphoreGive(s_tf);
        okay=okay&&!pending&&s_window_acks>=s_bootstrap.max_windows&&s_status_acks&&s_retry_tested;
    }
    ESP_LOGI(TAG,"run_finished windows=%lu window_acks=%lu status_acks=%lu events=%lu retry=%u boot_write_charges=%llu boot_tx_bytes=%llu storage_fault=%u",(unsigned long)s_windows,(unsigned long)s_window_acks,(unsigned long)s_status_acks,(unsigned long)s_event_acks,s_retry_tested,(unsigned long long)s_writes,(unsigned long long)s_tx_bytes,(unsigned)s_storage_fault);
    xSemaphoreTake(s_tf,portMAX_DELAY);uint64_t total_pending=cp_v3_queue_pending(s_queue,CP_V3_QUEUE_WINDOW)+cp_v3_queue_pending(s_queue,CP_V3_QUEUE_EVENT)+cp_v3_queue_pending(s_queue,CP_V3_QUEUE_STATUS);uint64_t current_pending=edge_upload_pending_current(s_queue,CP_V3_QUEUE_WINDOW,s_boot)+edge_upload_pending_current(s_queue,CP_V3_QUEUE_EVENT,s_boot)+edge_upload_pending_current(s_queue,CP_V3_QUEUE_STATUS,s_boot);xSemaphoreGive(s_tf);
    ESP_LOGI(TAG,"backlog current=%llu historical=%llu historical_acks=%lu",(unsigned long long)current_pending,(unsigned long long)(total_pending-current_pending),(unsigned long)s_historical_acks);
    return okay;
}
static void safe_usb_standby(void) {
    /* This boot's scanner arena cannot be reallocated. Keep the single USB
     * reader honest: HELLO exposes restart_required; START is never accepted. */
    char line[64]={0};size_t used=0;bool overflow=false;puts("V3 SAFE RESTART REQUIRED");fflush(stdout);
    while(s_usb_stop&&s_safe){
        unsigned char byte;if(read(STDIN_FILENO,&byte,1)!=1){vTaskDelay(pdMS_TO_TICKS(10));continue;}
        if(byte=='\r')continue;
        if(byte!='\n'){if(byte<32||byte>126||used+1>=sizeof line)overflow=true;else if(!overflow)line[used++]=(char)byte;continue;}
        line[used]=0;
        if(!overflow&&!strcmp(line,"RESTART")){volatile char *wipe=line;for(size_t i=0;i<sizeof line;i++)wipe[i]=0;esp_restart();}
        bool nonce=!overflow&&used==38&&!strncmp(line,"HELLO ",6);
        for(size_t i=6;nonce&&i<38;i++)if(!((line[i]>='0'&&line[i]<='9')||(line[i]>='a'&&line[i]<='f')))nonce=false;
        if(nonce)printf("V3 HELLO {\"node_id\":\"%s\",\"boot_id\":\"%s\",\"request_id\":\"%s\",\"mono_ms\":%llu,\"restart_required\":true}\n",s_node,s_boot,line+6,(unsigned long long)monotonic_ms());
        else puts("V3 START REJECTED restart_required");
        fflush(stdout);volatile char *wipe=line;for(size_t i=0;i<sizeof line;i++)wipe[i]=0;used=0;overflow=false;
    }
}
static void main_task(void *unused) {
    (void)unused;if(raw_power_init()!=ESP_OK)fault("power");
    if(nvs_flash_init()!=ESP_OK)fault("nvs");
    uint8_t mac[6];if(esp_efuse_mac_get_default(mac)!=ESP_OK)fault("identity");snprintf(s_node,sizeof s_node,"cp_%02x%02x%02x%02x%02x%02x",mac[0],mac[1],mac[2],mac[3],mac[4],mac[5]);memset(mac,0,sizeof mac);
    bootloader_random_enable();uuid4(s_boot);bootloader_random_disable();(void)raw_clock_init();
    if(xTaskCreate(display_task,"v3_display",6144,NULL,1,NULL)!=pdPASS)fault("display_task");
    if(xTaskCreate(key_task,"v3_keys",3072,NULL,2,NULL)!=pdPASS)fault("key_task");
    phase("WAIT USB");
    if(trial_bootstrap_wait(s_node,s_boot,&s_bootstrap,cancelled)!=ESP_OK){s_safe=true;vTaskDelete(NULL);return;}
    s_selected_mqtt=s_bootstrap.transport==CP_V3_TRANSPORT_MQTT_TLS;s_bootstrapped=true;s_usb_stop=false;publish_anchor(s_bootstrap.clock_seed);
    s_tf=xSemaphoreCreateMutex();s_control=psram(sizeof *s_control);s_workspace=psram(sizeof *s_workspace);s_queue=psram(sizeof *s_queue);s_store=psram(sizeof *s_store);s_reply=psram(CP_V3_TRANSPORT_RESPONSE_MAX);s_network_body=psram(4096);
    bool okay=s_tf&&s_control&&s_workspace&&s_queue&&s_store&&s_reply&&s_network_body;
    if(okay){xSemaphoreTake(s_tf,portMAX_DELAY);okay=budget_open()&&uplink_open();xSemaphoreGive(s_tf);}
    if(okay){okay=local_raw_prepare(s_tf,media_sync,NULL,&s_raw)==ESP_OK;s_raw_ready=okay;}
    if(okay)okay=local_raw_set_budget(s_raw,write_charge,NULL)==ESP_OK;
    if(okay)okay=local_raw_set_clock(s_raw,clock_copy,NULL,RAW_CLOCK_HOST_CALIBRATED_RTC,false)==ESP_OK;
    if(okay){
        s_storage_started=xTaskCreate(storage_task,"v3_storage",8192,NULL,4,NULL)==pdPASS;okay=s_storage_started;
        for(unsigned i=0;okay&&!s_storage_ready&&!s_storage_fault&&i<500;i++)vTaskDelay(pdMS_TO_TICKS(10));
        okay=okay&&s_storage_ready&&!s_storage_fault;
    }
    if(okay){s_mounted=raw_storage_mount()==ESP_OK;okay=s_mounted;}
    cp_v3_queue_store_t store={0};
    if(okay){
        xSemaphoreTake(s_tf,portMAX_DELAY);okay=write_charge(NULL,4096)&&raw_v3_queue_store_prepare(s_store,"/sdcard/cpv3small",raw_v3_queue_sd_sync,raw_storage_card_handle(),&s_base_store);
        if(okay){s_lifecycle_ready=lifecycle_directory();okay=s_lifecycle_ready;}
        store=(cp_v3_queue_store_t){NULL,queue_load,queue_store,queue_reclaim};
        raw_v3_queue_store_set_hash(s_store,cp_v3_transport_sha256,NULL);
        cp_v3_queue_profile_config_t profile={.profile=CP_V3_QUEUE_SMALL_RESULTS,.clock=queue_clock,.expire=queue_expire,.limits={4,4,2,2,BODY_MAX},.allow_historical_small=true,.allow_historical_control_reclaim=true};
        if(okay)okay=cp_v3_queue_open_profile(s_queue,store,s_node,s_boot,cp_v3_transport_sha256,NULL,&profile)==CP_V3_QUEUE_OK&&!s_queue->corrupt_slots&&!s_queue->retired_slots;
        if(okay)s_queue_ready=true;
        xSemaphoreGive(s_tf);
    }
    if(okay){ESP_LOGI(TAG,"queue_open profile=small body_pool=24576 filesystem_pool=262144 historical=%lu",(unsigned long)s_queue->historical_slots);okay=run();}
    s_stop=true;phase("STOPPING");
    if(s_capture_ready&&(cp_v3_capture_pause(s_capture,CP_V3_TEMPORAL_SCAN_GAP,5000)!=ESP_OK))okay=false;
    s_storage_stop=true;
    esp_err_t raw_stop=s_raw?local_raw_stop(s_raw,10000):ESP_OK;
    esp_err_t network_stop=cp_v3_transport_stop();trial_bootstrap_clear(&s_bootstrap);
    if(network_stop==ESP_OK){portENTER_CRITICAL(&s_lock);s_display.wifi_enabled=false;s_display.wifi_connected=false;s_display.wifi_rssi_known=false;s_display.wifi_ssid[0]=0;s_display.ip[0]=0;portEXIT_CRITICAL(&s_lock);}
    local_raw_status_t raw={.safe_to_unmount=true};if(s_raw_ready)local_raw_snapshot(s_raw,&raw);
    for(unsigned i=0;i<200&&s_storage_started&&!s_storage_done;i++)vTaskDelay(pdMS_TO_TICKS(50));
    cp_v3_capture_status_t closed={.quiescent=true};
    if(s_capture_ready){for(unsigned i=0;i<200;i++){cp_v3_capture_status(s_capture,&closed);if(closed.quiescent)break;vTaskDelay(pdMS_TO_TICKS(10));}}
    bool capture_safe=!s_capture_ready||(closed.quiescent&&!closed.window_handoffs&&!closed.event_handoffs&&s_last_durable_window==closed.last_closed_window_seq);
    bool writers_safe=capture_safe&&(!s_storage_started||s_storage_done)&&!s_storage_fault&&raw.safe_to_unmount&&!raw.io_failed_latched;
    if(s_raw_ready){
        ESP_LOGI(TAG,"raw_final enqueued=%llu written=%llu synced=%llu drops=%llu errors=%llu limits=%llu bytes=%llu anchors=%llu safe=%u",(unsigned long long)raw.counters[0],(unsigned long long)raw.counters[1],(unsigned long long)raw.counters[2],(unsigned long long)raw.counters[3],(unsigned long long)raw.counters[4],(unsigned long long)raw.counters[5],(unsigned long long)raw.managed_bytes,(unsigned long long)raw.clock_anchors,(unsigned)raw.safe_to_unmount);
        if(s_capture_ready&&s_control->policy.local_raw.enabled&&writers_safe&&s_mounted){
            local_raw_verify_summary_t verified={0};esp_err_t check=local_raw_verify_closed(s_raw,&verified);
            ESP_LOGI(TAG,"raw_crc_check result=%ld files=%llu reports=%llu bytes=%llu anchors=%llu",(long)check,(unsigned long long)verified.files,(unsigned long long)verified.reports,(unsigned long long)verified.bytes,(unsigned long long)verified.anchors);
            if(check!=ESP_OK)okay=false;
        }
    }
    esp_err_t unmount=ESP_ERR_INVALID_STATE;
    if(writers_safe&&s_mounted){xSemaphoreTake(s_tf,portMAX_DELAY);bool sync=media_sync(NULL);unmount=sync?raw_storage_unmount():ESP_FAIL;if(unmount==ESP_OK)s_mounted=false;xSemaphoreGive(s_tf);}
    else if(!s_mounted)unmount=ESP_OK;
    bool safe=writers_safe&&network_stop==ESP_OK&&unmount==ESP_OK;
    s_run_failed=!(okay&&safe);
    budget_log();
    ESP_LOGI(TAG,"lifecycle_cleanup covered=%llu completed=%llu general_credit_granted=0",(unsigned long long)s_cleanup_covered,(unsigned long long)s_cleanup_completed);
    ESP_LOGI(TAG,"cleanup safe=%u storage=%ld raw=%ld network=%ld",(unsigned)safe,(long)unmount,(long)raw_stop,(long)network_stop);
    phase(okay&&safe?"SMALL TEST PASSED":"SMALL STOPPED ERROR");
    s_safe=safe;
    /* A safe long-BOOT enters physical USB standby, never automatic Wi-Fi.
     * Reboot is required to allocate a changed policy's one-instance scanner. */
    if(s_safe&&!s_power_stop){s_usb_stop=true;phase("USB SAFE REBOOT");safe_usb_standby();}
    vTaskDelete(NULL);
}
void app_main(void){if(xTaskCreate(main_task,"v3_network",20480,NULL,4,NULL)!=pdPASS)fault("main_task");}
