/* New bounded statistics entry. Legacy feature/coordinator experiments remain
 * separate. NVS commit+exact reopen is implemented; arbitrary physical power
 * loss, GC endurance and whole-medium rollback protection are not certified. */
#include "small_runtime.h"
#include "small_runtime_logic.h"
#include "small_runtime_requests.h"
#include "small_runtime_requests_json.h"
#include "trial_bootstrap.h"
#include "board_budget.h"
#include "board_small_queue.h"
#include "board_window_freeze.h"
#include "local_guard.h"
#include "cp_v3_capture.h"
#include "cp_v3_small_results.h"
#include "cp_v3_transport.h"
#include "bootloader_random.h"
#include "esp_mac.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "esp_partition.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "nvs.h"
#include "nvs_flash.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include <stdio.h>
#include <string.h>
#include <time.h>

#define TE_RESPONSE CP_V3_TRANSPORT_RESPONSE_MAX
#define TE_NVS_PROFILE_ENTRIES (128u+3u*(2048u/32u+4u)+24u)
static const char *TAG="te-v3-small";
static char node[16],boot[37];
static trial_bootstrap_t bootstrap;
static cp_v3_time_t anchor;
static portMUX_TYPE anchor_lock=portMUX_INITIALIZER_UNLOCKED;
static SemaphoreHandle_t nvs_lock;
static te_board_budget_t budgets;
static te_v3_small_queue_t *queue,*reopened;
static cp_v3_control_t *control;
static cp_v3_control_workspace_t *workspace;
static cp_v3_capture_t *capture;
static cp_v3_capture_window_t *window;
static char *body,*reply,*verify;
static size_t frozen_bytes;
static cp_v3_expected_t frozen;
static uint64_t frozen_expiry;
static uint32_t window_seq,status_seq,control_seq,contact_seq,windows_acked,status_acked,retries,failures,ack_failures;
static bool transport_started,retry_verified,window_frozen,request_stop;

static uint64_t mono(void){return (uint64_t)esp_timer_get_time()/1000u;}
static void *external(size_t n){return heap_caps_aligned_calloc(8,1,n,MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT);}
static bool cancelled(void){return false;}
static bool lock_try(void *p){(void)p;return nvs_lock&&xSemaphoreTake(nvs_lock,0)==pdTRUE;}
static void lock_release(void *p){(void)p;xSemaphoreGive(nvs_lock);}
static bool clock_copy(void *p,uint64_t m,cp_v3_temporal_time_t *out){
    (void)p;cp_v3_time_t a;portENTER_CRITICAL(&anchor_lock);a=anchor;portEXIT_CRITICAL(&anchor_lock);
    return te_small_clock_at(a,m,out);
}
static bool utc(void *p,uint64_t *lo,uint64_t *hi){
    (void)p;cp_v3_temporal_time_t t;
    if(!clock_copy(NULL,mono(),&t)||t.utc_ms<t.uncertainty_ms||t.utc_ms>UINT64_MAX-t.uncertainty_ms)return false;
    *lo=t.utc_ms-t.uncertainty_ms;*hi=t.utc_ms+t.uncertainty_ms;return true;
}
static bool current(cp_v3_time_t *t){return cp_v3_transport_time(t)==ESP_OK;}
static bool entropy(void *p,uint8_t out[16]){(void)p;esp_fill_random(out,16);return true;}
static void uuid(char out[37]){
    uint8_t b[16];esp_fill_random(b,16);b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;
    snprintf(out,37,"%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",b[0],b[1],b[2],b[3],b[4],b[5],b[6],b[7],b[8],b[9],b[10],b[11],b[12],b[13],b[14],b[15]);
}
static void phase(const char *name){
    ESP_LOGI(TAG,"phase=%s internal=%u minimum=%u largest=%u psram=%u psram_largest=%u stack=%u",name,
        (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL|MALLOC_CAP_8BIT),
        (unsigned)heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL|MALLOC_CAP_8BIT),
        (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL|MALLOC_CAP_8BIT),
        (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT),
        (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT),
        (unsigned)uxTaskGetStackHighWaterMark(NULL));
}
static bool geometry(void){
    const esp_partition_t *n=esp_partition_find_first(ESP_PARTITION_TYPE_DATA,ESP_PARTITION_SUBTYPE_DATA_NVS,"nvs");
    const esp_partition_t *a=esp_partition_find_first(ESP_PARTITION_TYPE_APP,ESP_PARTITION_SUBTYPE_APP_FACTORY,"factory");
    const esp_partition_t *q=esp_partition_find_first(ESP_PARTITION_TYPE_DATA,0x40,"cpqueue");
    /* No queue reads/writes, no repartition, no erase. */
    return n&&n->address==0x9000&&n->size==0x6000&&a&&a->address==0x10000&&a->size==0x300000&&q&&q->address==0x360000&&q->size==0x400000;
}
/* Detect unknown keys/types rather than pretending the three known keys are
 * the complete medium. Other namespaces (including all v2 settings) are left
 * alone. Caller owns the one NVS mutex. */
static bool audit(bool require_empty,size_t *available){
    nvs_stats_t stats;if(nvs_get_stats(NULL,&stats)!=ESP_OK)return false;
    if(available)*available=stats.available_entries;
    nvs_iterator_t it=NULL;esp_err_t e=nvs_entry_find("nvs","cpv3stats1",NVS_TYPE_ANY,&it);
    while(e==ESP_OK){
        nvs_entry_info_t info;if(nvs_entry_info(it,&info)!=ESP_OK){nvs_release_iterator(it);return false;}
        const char *k=info.key;
        if(info.type!=NVS_TYPE_BLOB||(k[0]!='q'&&k[0]!='t')||k[1]<'0'||k[1]>'9'||k[2]<'0'||k[2]>'9'||k[3]||
           (unsigned)(k[1]-'0')*10u+(unsigned)(k[2]-'0')>=CP_V3_QUEUE_SLOTS){nvs_release_iterator(it);return false;}
        e=nvs_entry_next(&it);
    }
    nvs_release_iterator(it);
    if(e!=ESP_ERR_NVS_NOT_FOUND)return false;
    if(require_empty){
        if(!queue||!queue->opened||queue->queue.corrupt_slots||queue->queue.retired_slots)return false;
        for(unsigned i=0;i<CP_V3_QUEUE_SLOTS;i++){
            size_t bytes=0;
            int loaded=queue->raw_store.load(queue->raw_store.context,i,queue->queue.scratch,sizeof queue->queue.scratch,&bytes);
            /* A valid committed expiry tombstone is FREE capacity and may be
             * reused only by the adapter's increasing-ordinal transition. */
            if(!te_small_slot_reusable(queue->queue.slots[i].state,loaded))return false;
        }
    }
    return true;
}
static bool admit(void *p,cp_v3_queue_kind_t kind,const cp_v3_expected_t *e,size_t bytes,uint64_t expiry){
    (void)p;if(!control->small_statistics||!te_small_scope(&e->scope,&control->policy.scope)||
       bytes>control->policy.max_body_bytes||expiry>control->policy.accept_until_utc_ms)return false;
    if(kind==CP_V3_QUEUE_CONTROL)return control->state==CP_V3_CONTROL_ACK_PENDING||control->state==CP_V3_CONTROL_APPLIED;
    return te_small_policy(&control->policy)&&(kind==CP_V3_QUEUE_WINDOW||kind==CP_V3_QUEUE_STATUS)&&control->state==CP_V3_CONTROL_APPLIED;
}
static te_v3_small_queue_config_t queue_config(void){
    return (te_v3_small_queue_config_t){.sha256=cp_v3_transport_sha256,.clock=utc,.write_budget=&budgets.storage,
        .try_lock=te_board_budget_try_lock,.unlock=te_board_budget_unlock,.lock_context=&budgets,.admit_new=admit};
}
static bool open_storage(void){
    if(!geometry())return false;
    /* Deliberately no nvs_flash_erase fallback. Initialization may finish SDK
     * interrupted updates; private preflight backups are taken by the operator. */
    if(nvs_flash_init()!=ESP_OK)return false;
    size_t entries=0;if(!lock_try(NULL))return false;
    bool checked=audit(false,&entries);lock_release(NULL);
    ESP_LOGI(TAG,"nvs_available=%u required_for_new_profile=%u",(unsigned)entries,TE_NVS_PROFILE_ENTRIES);
    if(!checked)return false;
    te_board_budget_config_t cfg={.sha256=cp_v3_transport_sha256,.try_lock=lock_try,.unlock=lock_release,.trusted_utc=utc};
    if(te_board_budget_open(&budgets,node,&cfg)!=TE_BOARD_BUDGET_OK)return false;
    te_board_budget_local_test_t auth={.authorization=TE_BUDGET_EXPLICIT_LOCAL_TEST,.storage_limit=TE_SMALL_STORAGE_DAY,
        .uplink_limit=TE_SMALL_UPLINK_DAY,.storage_quantum=32768,.uplink_quantum=8192};strcpy(auth.node_id,node);
    if(te_board_budget_accept_local_test(&budgets,&auth)!=TE_BOARD_BUDGET_OK)return false;
    te_v3_small_queue_config_t qcfg=queue_config();
    if(te_v3_small_queue_open(queue,node,boot,&qcfg)!=TE_SMALL_QUEUE_OK||queue->queue.corrupt_slots||queue->queue.retired_slots)return false;
    return true;
}
static bool request_stopped(void *p){(void)p;return request_stop||cancelled();}
static bool charge_post(void *p,size_t n){
    (void)p;te_board_budget_result_t result=te_board_budget_charge(&budgets,TE_BUDGET_UPLINK,n);
    if(result!=TE_BOARD_BUDGET_OK){failures++;ESP_LOGE(TAG,"uplink_budget_denied=%u no_http=1",(unsigned)result);return false;}return true;
}
static esp_err_t transport_exchange(void *p,cp_v3_http_method_t method,const char *path,const void *bytes,size_t n,bool receipt_only,cp_v3_transport_response_t *r){
    (void)p;uint64_t started=mono();
    esp_err_t e=receipt_only?cp_v3_transport_request_receipt_only(method,path,bytes,n,reply,TE_RESPONSE,r):
        cp_v3_transport_request(method,path,bytes,n,reply,TE_RESPONSE,r);
    if(e==ESP_ERR_INVALID_STATE)request_stop=true;
    if(e!=ESP_OK||!r->complete||r->http_status<200||r->http_status>=300||r->tls_verify_flags){
        failures++;ESP_LOGW(TAG,"request_failed error=%ld status=%d parsed_http_status=%d stage=%u elapsed_ms=%llu dns=%ld resolved_ipv4=%lu tls_connected=%ld io=%ld last_read=%ld last_write=%ld rx=%lu tx=%lu tls_esp_error=%ld tls_stack_error=%ld tls_verify_flags=%ld whole_flush_attempted=%u whole_flush_succeeded=%u whole_flush_error=%ld",
            (long)e,r->http_status,r->parsed_http_status,(unsigned)r->stage,(unsigned long long)(mono()-started),
            (long)r->dns_error,(unsigned long)r->resolved_ipv4,(long)r->tls_connected,(long)r->io_error,(long)r->last_read,(long)r->last_write,
            (unsigned long)r->received_bytes,(unsigned long)r->written_bytes,(long)r->tls_esp_error,(long)r->tls_stack_error,(long)r->tls_verify_flags,
            (unsigned)r->whole_flush_attempted,(unsigned)r->whole_flush_succeeded,(long)r->whole_flush_error);
    }return e;
}
static bool server_retryable(void *p,const cp_v3_transport_response_t *r){(void)p;return te_small_server_retryable(reply,r->body_bytes);}
static const te_small_request_io_t http_io={NULL,request_stopped,charge_post,transport_exchange,server_retryable};
static bool request(cp_v3_http_method_t method,const char *path,const void *bytes,size_t n,bool receipt_only,cp_v3_transport_response_t *r){
    return te_small_request_once(&http_io,method,path,bytes,n,receipt_only,r)==TE_REQUEST_OK;
}
static bool registration_wait(void *p,uint32_t delay){
    (void)p;while(delay&&!request_stopped(NULL)){uint32_t step=delay<100?delay:100;vTaskDelay(pdMS_TO_TICKS(step));delay-=step;}
    return !request_stopped(NULL);
}
static void registration_attempt(void *p,unsigned index,size_t n){
    (void)p;if(index)retries++;
    ESP_LOGI(TAG,"registration_attempt=%u frozen_body_bytes=%u",index+1,(unsigned)n);
}
static bool control_match(void *p,const cp_v3_expected_t *e,const void *bytes,size_t n,const void *receipt,size_t rn){
    (void)p;return cp_v3_control_match_frozen_receipt(workspace,&e->scope,bytes,n,receipt,rn,cp_v3_transport_sha256,NULL)==CP_V3_CONTROL_OK;
}
static bool digest(const void *bytes,size_t n,char out[65]){
    uint8_t d[32];if(!cp_v3_transport_sha256(NULL,bytes,n,d))return false;
    static const char h[]="0123456789abcdef";for(unsigned i=0;i<32;i++){out[2*i]=h[d[i]>>4];out[2*i+1]=h[d[i]&15];}out[64]=0;return true;
}
static bool age_ready(cp_v3_queue_kind_t kind,const void *bytes,size_t n,const cp_v3_expected_t *e,uint64_t expiry){
    cp_v3_time_t t;if(!current(&t))return false;
    te_local_guard_time_t time={t,expiry,UINT64_C(168)*3600000};te_local_guard_report_t report;
    te_local_guard_inspect(kind,e,node,bytes,n,&time,cp_v3_transport_sha256,NULL,&report);
    return report.check==TE_LOCAL_GUARD_STRUCTURE_MATCHED;
}
/* Read-only fresh-open confirms the exact committed encoding, not merely the
 * live queue's RAM view. No resetting an uncertain owner to hide failure. */
static bool persist(cp_v3_queue_kind_t kind,const cp_v3_expected_t *e,const void *bytes,size_t n,uint64_t expiry,unsigned *slot){
    te_v3_small_queue_result_t saved=te_v3_small_queue_push(queue,kind,e,bytes,n,expiry,slot);
    if(saved!=TE_SMALL_QUEUE_OK){ESP_LOGE(TAG,"queue_store_denied=%u frozen_retained=1",(unsigned)saved);return false;}
    te_v3_small_queue_config_t cfg=queue_config();
    if(te_v3_small_queue_open(reopened,node,boot,&cfg)!=TE_SMALL_QUEUE_OK)return false;
    cp_v3_expected_t checked;size_t actual=0;
    if(te_v3_small_queue_read(reopened,*slot,verify,TE_SMALL_BODY,&actual,&checked)!=TE_SMALL_QUEUE_OK||actual!=n||memcmp(bytes,verify,n)||memcmp(e,&checked,sizeof checked))return false;
    ESP_LOGI(TAG,"nvs_commit_readback_reopen=1 body_bytes=%u",(unsigned)n);return true;
}
static bool recover(void){
    const cp_v3_queue_kind_t kinds[]={CP_V3_QUEUE_CONTROL,CP_V3_QUEUE_WINDOW,CP_V3_QUEUE_STATUS};
    bool blocked=false;
    for(unsigned k=0;k<3;k++)for(unsigned attempt=0;attempt<CP_V3_QUEUE_SLOTS+1;attempt++){
        unsigned slot;te_v3_small_queue_result_t found=te_v3_small_queue_oldest(queue,kinds[k],&slot);
        if(found==TE_SMALL_QUEUE_NOT_FOUND)break;
        if(found!=TE_SMALL_QUEUE_OK)return false;
        cp_v3_expected_t e;size_t n=0;
        te_v3_small_queue_result_t read=te_v3_small_queue_read(queue,slot,body,TE_SMALL_BODY,&n,&e);
        if(read==TE_SMALL_QUEUE_EXPIRED)continue;
        if(read!=TE_SMALL_QUEUE_OK||!n||strcmp(e.scope.node_id,node)||!strcmp(e.scope.boot_id,boot))return false;
        uint64_t expiry=queue->queue.slots[slot].source_expires_at_ms;
        cp_v3_transport_response_t r={0};bool ack=false;
        if(kinds[k]==CP_V3_QUEUE_CONTROL){
            const char *path=!strcmp(e.stream,"config_ack")?"/api/v3/device/config/ack":!strcmp(e.stream,"lease")?"/api/v3/device/lease":NULL;
            ack=path&&request(CP_V3_HTTP_POST,path,body,n,true,&r)&&control_match(NULL,&e,body,n,reply,r.body_bytes)&&
                te_v3_small_queue_ack_control(queue,slot,reply,r.body_bytes,control_match,NULL)==TE_SMALL_QUEUE_OK;
        }else{
            for(unsigned wait=0;wait<120&&!age_ready(kinds[k],body,n,&e,expiry);wait++)vTaskDelay(pdMS_TO_TICKS(100));
            ack=age_ready(kinds[k],body,n,&e,expiry)&&request(CP_V3_HTTP_POST,"/api/v3/statistics/ingest",body,n,false,&r)&&
                cp_v3_statistics_receipt_matches(reply,r.body_bytes,&e)&&te_v3_small_queue_ack(queue,slot,reply,r.body_bytes)==TE_SMALL_QUEUE_OK;
        }
        if(!ack){
            ESP_LOGE(TAG,"historical_recovery_blocked kind=%u retained=1",(unsigned)kinds[k]);
            /* A missing control receipt cannot grant authority, but need not
             * prevent an independent old-window/status receipt recovery. */
            blocked=true;break;
        }
        ESP_LOGI(TAG,"historical_exact_recovered kind=%u",(unsigned)kinds[k]);
    }
    if(!te_board_budget_try_lock(&budgets))return false;
    size_t entries=0;bool empty=audit(true,&entries);te_board_budget_unlock(&budgets);
    ESP_LOGI(TAG,"nvs_recovery_empty=%u available=%u required=%u",empty,(unsigned)entries,TE_NVS_PROFILE_ENTRIES);
    ESP_LOGI(TAG,"recovery_expired items=%llu encoded_bytes=%llu",
        (unsigned long long)queue->queue.expired_items,(unsigned long long)queue->queue.expired_bytes);
    return !blocked&&empty&&entries>=TE_NVS_PROFILE_ENTRIES;
}
static void iso(uint64_t ms,char out[25]){
    time_t sec=(time_t)(ms/1000);struct tm t;gmtime_r(&sec,&t);strftime(out,20,"%Y-%m-%dT%H:%M:%S",&t);snprintf(out+19,6,".%03uZ",(unsigned)(ms%1000));
}
static size_t capabilities(cp_v3_time_t t){
    char issued[25],until[25],id[37];iso(t.utc_ms-5000,issued);iso(t.utc_ms+1800000,until);uuid(id);
    /* Supported recovery protocol, NOT a claimed physical cut-power result.
     * The old evidence-gated builder remains unchanged as a separate experiment. */
    int n=snprintf(reply,TE_RESPONSE,"{\"schema\":\"device-capabilities/1\",\"capability_id\":\"bounded-%s\",\"node_id\":\"%s\",\"boot_id\":\"%s\",\"producer_version\":\"%s\",\"policy_schemas\":[\"device-config/3\"],\"issued_at\":\"%s\",\"expires_at\":\"%s\","
        "\"scanner\":{\"modes\":[\"passive\"],\"phys\":[\"1m\"],\"duplicate_filter\":[false],\"min_interval_units\":4,\"max_interval_units\":16384},"
        "\"summary\":{\"max_addresses\":512,\"max_bins\":12,\"max_window_ms\":60000},\"statistics\":{\"schemas\":[\"window-statistics/1\"],\"extractor_versions\":[\"cp-v3-stats/1\"],\"ruleset_versions\":[\"unclassified-v1\"]},"
        "\"temporal\":{\"slice_ms\":[2000],\"max_history_ms\":600000,\"max_tracks\":512,\"max_open_events\":64,\"max_event_ms\":3600000,\"event_schemas\":[\"candidate-event/1\"],\"report_modes\":[\"off\"]},\"local_raw\":null,"
        "\"uplink\":{\"transports\":[\"https\"],\"streams\":[\"window_statistics\",\"node_status\"],\"max_batch_items\":1,\"max_body_bytes\":1024,\"max_sample_reports_per_window\":0,\"cpraw_archive\":false},"
        "\"queue\":{\"media\":[{\"medium\":\"flash_journal\",\"usable_bytes\":3072,\"max_items\":3,\"power_loss_recovery\":true}]},\"resources\":{\"max_working_bytes\":%u,\"max_storage_write_bytes_per_day\":%u,\"tf_usable_bytes\":null}}",
        id,node,boot,CP_V3_SMALL_PRODUCER,issued,until,TE_SMALL_WORKING,TE_SMALL_STORAGE_DAY);
    return n>0&&n<CP_V3_CONTROL_CAP_MAX?(size_t)n:0;
}
static cp_v3_apply_result_t apply(void *p,const cp_v3_trial_policy_t *policy,cp_v3_boundary_t *boundary){
    (void)p;if(boundary->window_open||boundary->segment_open||capture)return CP_V3_APPLY_BOUNDARY_FAILED;
    if(!te_small_policy(policy))return CP_V3_APPLY_UNSUPPORTED;
    if(te_board_budget_bind_policy(&budgets,control)!=TE_BOARD_BUDGET_OK)return CP_V3_APPLY_STORAGE_FAILED;
    if(!te_board_budget_try_lock(&budgets))return CP_V3_APPLY_STORAGE_FAILED;
    size_t entries=0;bool space=audit(true,&entries)&&entries>=TE_NVS_PROFILE_ENTRIES;te_board_budget_unlock(&budgets);
    if(!space)return CP_V3_APPLY_RESOURCE_EXHAUSTED;
    cp_v3_capture_config_t cfg={.statistics={.capacity=policy->stats_max_addresses,.window_ms=policy->window_ms,.bin_ms=policy->bin_ms,.rules_version=CP_V3_STATS_RULESET},
        .temporal_enabled=policy->temporal.rolling,.report_events=false,.context={1,policy->scope.assignment_generation,policy->scope.assignment_generation},
        .report_slots=128,.window_slots=2,.event_slots=1,.stop_after_windows=bootstrap.max_windows,
        .min_internal_free=56000,.min_internal_largest=20000,.min_psram_free=512u*1024,.min_psram_largest=128u*1024,.clock=clock_copy,.entropy=entropy};
    cfg.temporal=(cp_v3_temporal_config_t){policy->temporal.max_tracks,policy->temporal.max_open_events,4,(uint16_t)policy->temporal.slice_ms,policy->temporal.history_ms,policy->temporal.gap_ms,policy->temporal.max_event_ms};
    size_t temporal=cfg.temporal_enabled?cp_v3_temporal_memory_bytes(&cfg.temporal):0;
    size_t estimate=temporal+cp_v3_stats_memory_bytes(policy->stats_max_addresses)+128u*(sizeof(cp_v3_stats_report_t)+1650u)+2u*sizeof(cp_v3_capture_window_t)+sizeof(cp_v3_capture_event_t)+65536u;
    if((cfg.temporal_enabled&&!temporal)||estimate>policy->working_bytes)return CP_V3_APPLY_RESOURCE_EXHAUSTED;
    esp_err_t e=cp_v3_capture_prepare(&cfg,&capture);
    cp_v3_capture_status_t s;if(e==ESP_OK)cp_v3_capture_status(capture,&s);else cp_v3_capture_prepare_status(&s);
    ESP_LOGI(TAG,"capture_prepare error=%ld stats=%u temporal=%u stats_align=%u/%u temporal_align=%u/%u",(long)e,(unsigned)s.statistics_bytes,(unsigned)s.temporal_bytes,s.statistics_alignment,s.statistics_alignment_remainder,s.temporal_alignment,s.temporal_alignment_remainder);
    return e==ESP_OK&&s.prepared&&!s.running&&!s.failed?CP_V3_APPLY_OK:CP_V3_APPLY_RESOURCE_EXHAUSTED;
}
static bool exchange(const char *stream,const char *path,const char *bytes,size_t n,uint32_t seq,bool lease){
    cp_v3_expected_t e={.scope=control->policy.scope,.seq_first=seq,.seq_last=seq,.accepted_count=1,.body_bytes=n};uuid(e.batch_id);strcpy(e.stream,stream);
    if(!digest(bytes,n,e.body_sha256))return false;
    unsigned slot;if(!persist(CP_V3_QUEUE_CONTROL,&e,bytes,n,control->policy.accept_until_utc_ms,&slot))return false;
    /* The request may alias the control workspace; only the committed copy is
     * used for all retries. */
    cp_v3_expected_t checked;size_t stored=0;
    if(te_v3_small_queue_read(queue,slot,body,TE_SMALL_BODY,&stored,&checked)!=TE_SMALL_QUEUE_OK||stored!=n||memcmp(&e,&checked,sizeof e))return false;
    for(unsigned i=0;i<control->policy.retry_max_attempts;i++){
        if(i)retries++;
        cp_v3_transport_response_t r={0};
        if(request(CP_V3_HTTP_POST,path,body,stored,false,&r)){
            cp_v3_time_t t;if(!current(&t)||!control_match(NULL,&e,body,stored,reply,r.body_bytes))return false;
            cp_v3_control_result_t accepted=lease?cp_v3_control_lease_receipt(control,reply,r.body_bytes,t):cp_v3_control_ack_receipt(control,reply,r.body_bytes,t);
            if(accepted!=CP_V3_CONTROL_OK||te_v3_small_queue_ack_control(queue,slot,reply,r.body_bytes,control_match,NULL)!=TE_SMALL_QUEUE_OK)return false;
            ESP_LOGI(TAG,"control_committed_reclaimed stream=%s seq=%u",stream,(unsigned)seq);return true;
        }
        vTaskDelay(pdMS_TO_TICKS(control->policy.retry_min_ms));
    }return false;
}
static bool send_statistics(cp_v3_queue_kind_t kind,unsigned slot,bool test_retry){
    cp_v3_expected_t e;size_t n=0;
    if(te_v3_small_queue_read(queue,slot,body,TE_SMALL_BODY,&n,&e)!=TE_SMALL_QUEUE_OK)return false;
    uint64_t expiry=queue->queue.slots[slot].source_expires_at_ms;
    for(unsigned wait=0;wait<120&&!age_ready(kind,body,n,&e,expiry);wait++)vTaskDelay(pdMS_TO_TICKS(100));
    if(!age_ready(kind,body,n,&e,expiry))return false;
    for(unsigned i=0;i<control->policy.retry_max_attempts;i++){
        if(i)retries++;
        cp_v3_transport_response_t r={0};
        if(request(CP_V3_HTTP_POST,"/api/v3/statistics/ingest",body,n,false,&r)){
            if(!cp_v3_statistics_receipt_matches(reply,r.body_bytes,&e)){ack_failures++;return false;}
            if(test_retry){
                size_t rn=r.body_bytes;if(rn>TE_SMALL_BODY)return false;memcpy(verify,reply,rn);
                if(!request(CP_V3_HTTP_POST,"/api/v3/statistics/ingest",body,n,false,&r)||r.body_bytes!=rn||memcmp(verify,reply,rn)||!cp_v3_statistics_receipt_matches(reply,r.body_bytes,&e))return false;
                retry_verified=true;retries++;
            }
            if(te_v3_small_queue_ack(queue,slot,reply,r.body_bytes)!=TE_SMALL_QUEUE_OK)return false;
            ESP_LOGI(TAG,"statistics_committed_reclaimed kind=%u seq=%u bytes=%u exact_retry=%u",(unsigned)kind,(unsigned)e.seq_first,(unsigned)n,test_retry);return true;
        }
        vTaskDelay(pdMS_TO_TICKS(control->policy.retry_min_ms));
    }return false;
}
static bool window_step(void){
    if(!window_frozen){
        if(!cp_v3_capture_window(capture,window,0))return true;
        if(window_seq==UINT32_MAX)return false;
        char id[37];uuid(id);frozen_bytes=0;
        if(cp_v3_small_window_body(&window->scope,&window->statistics,window->end_time,id,++window_seq,cp_v3_transport_sha256,NULL,
            body,TE_SMALL_BODY+1,&frozen_bytes,&frozen)!=CP_V3_OK||!te_small_expiry(window->end_time,window->statistics.duration_ms,
            control->policy.source_retention_hours,control->policy.accept_until_utc_ms,&frozen_expiry))return false;
        window_frozen=true;
    }
    unsigned slot;
    /* body remains unchanged until durable commit/readback. On failure no
     * release or fresh UUID; cleanup reports the unresolved volatile handoff. */
    if(!persist(CP_V3_QUEUE_WINDOW,&frozen,body,frozen_bytes,frozen_expiry,&slot))return false;
    if(!cp_v3_capture_window_release(capture,window->window_seq,window->scope.assignment_generation))return false;
    window_frozen=false;
#if CONFIG_TE_SMALL_TEST_HOLD_FIRST_COMMIT
    if(windows_acked==0){
        esp_err_t stopped=cp_v3_capture_pause(capture,CP_V3_TEMPORAL_SCAN_GAP,5000);
        cp_v3_capture_status_t s={0};bool drained=false;
        for(unsigned wait=0;wait<200&&stopped==ESP_OK;wait++){
            cp_v3_capture_status(capture,&s);
            if(s.quiescent&&!s.running&&!s.window_handoffs&&s.bounded_complete){drained=true;break;}
            vTaskDelay(pdMS_TO_TICKS(10));
        }
        if(stopped!=ESP_OK||!drained)return false;
        ESP_LOGI(TAG,"normal_reboot_checkpoint durable_windows=1 no_post=1 volatile_handoffs=0 reset_required=1");
        for(;;)vTaskDelay(pdMS_TO_TICKS(1000));
    }
#endif
    ESP_LOGI(TAG,"window_frozen window=%u reports=%llu callback_drops=%llu processing_drops=%llu overflow=%llu bytes=%u",
        (unsigned)window->window_seq,(unsigned long long)window->statistics.received_reports,
        (unsigned long long)window->statistics.callback_drops,(unsigned long long)window->statistics.aggregation_drops,
        (unsigned long long)window->statistics.address_overflow_reports,(unsigned)frozen_bytes);
    if(!send_statistics(CP_V3_QUEUE_WINDOW,slot,!retry_verified))return false;
    windows_acked++;return true;
}
static bool status(void){
    cp_v3_temporal_time_t t;if(!clock_copy(NULL,mono(),&t)||status_seq==UINT32_MAX)return false;
    cp_v3_small_status_t s={.time=t,.state=CP_V3_SMALL_PAUSED,.resource_known_mask=31};
    s.resources[0]=heap_caps_get_free_size(MALLOC_CAP_INTERNAL|MALLOC_CAP_8BIT);s.resources[1]=heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL|MALLOC_CAP_8BIT);
    s.resources[2]=heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL|MALLOC_CAP_8BIT);s.resources[3]=heap_caps_get_free_size(MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT);s.resources[4]=uxTaskGetStackHighWaterMark(NULL);
    s.losses[3]=failures;s.losses[4]=ack_failures;s.losses[5]=retries;
    char id[37];uuid(id);size_t n=0;cp_v3_expected_t e;
    if(cp_v3_small_status_body(&control->policy.scope,&s,id,++status_seq,cp_v3_transport_sha256,NULL,body,TE_SMALL_BODY+1,&n,&e)!=CP_V3_OK)return false;
    uint64_t expiry;if(!te_small_expiry(t,0,control->policy.source_retention_hours,control->policy.accept_until_utc_ms,&expiry))return false;
    unsigned slot;if(!persist(CP_V3_QUEUE_STATUS,&e,body,n,expiry,&slot)||!send_statistics(CP_V3_QUEUE_STATUS,slot,false))return false;
    status_acked++;return true;
}
void app_main(void){
    if(xTaskCreate(te_small_runtime,"te_small",16384,NULL,4,NULL)!=pdPASS)ESP_LOGE(TAG,"runtime_task_allocation_failed=1");
}
static bool run(void){
    cp_v3_transport_config_t cfg={.origin=bootstrap.origin,.server_ca_pem=bootstrap.server_ca_pem[0]?bootstrap.server_ca_pem:NULL,
        .clock_seed=bootstrap.clock_seed,.wifi_timeout_ms=10000,.request_timeout_ms=te_small_request_timeout_ms(bootstrap.origin),.server_clock_error_ms=1000,
        .flush_dns_on_network_failure=!strcmp(bootstrap.origin,CP_API_ORIGIN)};
    transport_started=true;if(cp_v3_transport_start(&bootstrap.settings,&cfg)!=ESP_OK)return false;
    if(!recover())return false;
    cp_v3_time_t t;if(!current(&t))return false;
    size_t n=capabilities(t);if(!n||cp_v3_control_init(control,workspace,node,boot,reply,n,t,cp_v3_transport_sha256,NULL)!=CP_V3_CONTROL_OK)return false;
    const char *bytes;if(cp_v3_control_registration(control,1,t.mono_ms,&bytes,&n)!=CP_V3_CONTROL_OK)return false;
    cp_v3_transport_response_t r={0};phase("REGISTER");
    te_small_registration_io_t registration={&http_io,NULL,registration_wait,registration_attempt};
    if(!te_small_registration_exchange(&registration,bytes,n,&r)||!current(&t)||cp_v3_control_registration_receipt(control,reply,r.body_bytes,t)!=CP_V3_CONTROL_OK)return false;
    char path[128];snprintf(path,sizeof path,"/api/v3/device/config?boot_id=%s",boot);bool offered=false;phase("WAIT POLICY");
    for(unsigned i=0;i<180&&!request_stopped(NULL);i++){
        if(request(CP_V3_HTTP_GET,path,NULL,0,false,&r)&&current(&t)&&cp_v3_control_offer(control,reply,r.body_bytes,t)==CP_V3_CONTROL_OK){offered=true;break;}
        vTaskDelay(pdMS_TO_TICKS(1000));
    }
    if(!offered||!current(&t))return false;
    cp_v3_boundary_t boundary={0};if(cp_v3_control_apply(control,t,boundary,++control_seq,apply,NULL)!=CP_V3_CONTROL_OK)return false;
    bytes=cp_v3_control_ack_bytes(control,&n);
    if(!bytes||!exchange("config_ack","/api/v3/device/config/ack",bytes,n,control_seq,false)||control->apply_result!=CP_V3_APPLY_OK)return false;
    if(!current(&t)||cp_v3_control_lease_request(control,++contact_seq,t.mono_ms,&bytes,&n)!=CP_V3_CONTROL_OK||!exchange("lease","/api/v3/device/lease",bytes,n,++control_seq,true))return false;
    if(!current(&t))return false;
    cp_v3_control_permissions_t permission={0};
    for(unsigned i=0;i<300;i++){
        if(!current(&t))return false;
        permission=cp_v3_control_permissions(control,t);
        if(permission.collection)break;
        if(permission.reason!=CP_V3_CONTROL_WAIT)return false;
        vTaskDelay(pdMS_TO_TICKS(50));
    }
    uint64_t growth=(control->policy.window_ms+1999u)/2000u;
    if(!permission.collection||permission.deadline_mono_ms<=t.mono_ms+control->policy.window_ms+growth||
       cp_v3_capture_start(capture,&control->policy.scope,1,control->policy.scan_interval_units,control->policy.scan_window_units,permission.deadline_mono_ms-growth)!=ESP_OK)return false;
    phase("COLLECT");uint64_t renew_at=mono()+control->policy.lease_ms/3;bool okay=true;
    for(unsigned tick=0;tick<30000;tick++){
        if(!current(&t)){okay=false;break;}permission=cp_v3_control_permissions(control,t);
        cp_v3_capture_status_t s;cp_v3_capture_status(capture,&s);
        if(s.failed){okay=false;break;}
        if(!window_step()){okay=false;break;}
        cp_v3_capture_status(capture,&s);
        if(s.failed){okay=false;break;}
        if(s.bounded_complete){
            if(s.window_handoffs==0)break;
            /* Shared status refresh is asynchronous after exact release.
             * Completed capture only drains; it never renews a stopped radio. */
            vTaskDelay(pdMS_TO_TICKS(10));continue;
        }
        if(!permission.collection){okay=false;break;}
        if(mono()>=renew_at){
            if(!current(&t)||cp_v3_control_lease_request(control,++contact_seq,t.mono_ms,&bytes,&n)!=CP_V3_CONTROL_OK||!exchange("lease","/api/v3/device/lease",bytes,n,++control_seq,true)||!current(&t)){okay=false;break;}
            permission=cp_v3_control_permissions(control,t);
            if(!permission.collection||permission.deadline_mono_ms<=growth||cp_v3_capture_deadline(capture,permission.deadline_mono_ms-growth)!=ESP_OK){okay=false;break;}
            renew_at=mono()+control->policy.lease_ms/3;
        }
        vTaskDelay(pdMS_TO_TICKS(20));
    }
    if(cp_v3_capture_pause(capture,CP_V3_TEMPORAL_SCAN_GAP,5000)!=ESP_OK)okay=false;
    if(okay)for(unsigned i=0;i<2;i++){cp_v3_capture_status_t s;cp_v3_capture_status(capture,&s);if(!s.window_handoffs)break;if(!window_step()){okay=false;break;}}
    if(okay)okay=status();
    return okay&&windows_acked==bootstrap.max_windows&&status_acked&&retry_verified;
}
void te_small_runtime(void *unused){
    (void)unused;phase("WAIT USB");
    uint8_t mac[6];if(esp_efuse_mac_get_default(mac)!=ESP_OK)goto done;
    snprintf(node,sizeof node,"cp_%02x%02x%02x%02x%02x%02x",mac[0],mac[1],mac[2],mac[3],mac[4],mac[5]);memset(mac,0,sizeof mac);
    bootloader_random_enable();uuid(boot);bootloader_random_disable();
    if(trial_bootstrap_wait(node,boot,&bootstrap,cancelled)!=ESP_OK)goto done;
    if(bootstrap.max_windows<1||bootstrap.max_windows>3){ESP_LOGE(TAG,"bounded_windows_required=1 maximum=3");goto done;}
#if CONFIG_TE_SMALL_TEST_HOLD_FIRST_COMMIT
    if(bootstrap.max_windows!=1){ESP_LOGE(TAG,"checkpoint_requires_one_window=1");goto done;}
#endif
    portENTER_CRITICAL(&anchor_lock);anchor=bootstrap.clock_seed;portEXIT_CRITICAL(&anchor_lock);
    nvs_lock=xSemaphoreCreateMutex();queue=external(sizeof *queue);reopened=external(sizeof *reopened);
    control=external(sizeof *control);workspace=external(sizeof *workspace);window=external(sizeof *window);
    body=external(TE_SMALL_BODY+1);reply=external(TE_RESPONSE);verify=external(TE_SMALL_BODY+1);
    bool okay=nvs_lock&&queue&&reopened&&control&&workspace&&window&&body&&reply&&verify&&open_storage()&&run();
    if(capture){
        esp_err_t paused=cp_v3_capture_pause(capture,CP_V3_TEMPORAL_SCAN_GAP,5000);cp_v3_capture_status_t s;cp_v3_capture_status(capture,&s);
        ESP_LOGI(TAG,"capture_final reports=%llu callback_drops=%llu invalid=%llu handoffs=%u failed=%u pause=%ld",
            (unsigned long long)s.callback_reports,(unsigned long long)s.callback_drops,(unsigned long long)s.invalid_reports,s.window_handoffs,s.failed,(long)paused);
        if(paused!=ESP_OK||s.running)okay=false;
    }
    esp_err_t stopped=transport_started?cp_v3_transport_stop():ESP_OK;
    if(stopped==ESP_OK)trial_bootstrap_clear(&bootstrap);
    if(queue&&queue->opened){
        unsigned pending=0;for(unsigned i=0;i<CP_V3_QUEUE_SLOTS;i++)if(queue->queue.slots[i].state==CP_V3_QUEUE_PENDING)pending++;
        ESP_LOGI(TAG,"queue_final durable_pending=%u expired_items=%llu expired_bytes=%llu uncertain=%u corrupt=%u retired=%u",
            pending,(unsigned long long)queue->queue.expired_items,(unsigned long long)queue->queue.expired_bytes,
            (unsigned)queue->storage.uncertain,(unsigned)queue->queue.corrupt_slots,(unsigned)queue->queue.retired_slots);
    }
    ESP_LOGI(TAG,"bounded_finished passed=%u windows=%u status=%u exact_retry=%u failures=%u retry_attempts=%u frozen_volatile=%u network_stop=%ld",
        okay&&stopped==ESP_OK,(unsigned)windows_acked,(unsigned)status_acked,retry_verified,(unsigned)failures,(unsigned)retries,window_frozen,(long)stopped);
    phase(okay&&stopped==ESP_OK?"BOUNDED PASSED":"BOUNDED FAILED");
done:
    /* No automatic restart, old settings restore, queue erase, or NimBLE deinit.
     * Owned allocations intentionally remain until explicit physical reboot. */
    vTaskDelete(NULL);
}
