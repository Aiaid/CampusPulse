#include "cp_v3_capture.h"
#include <limits.h>
#include <stdio.h>
#include <string.h>
#include "esp_heap_caps.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "host/ble_gap.h"
#include "host/ble_hs.h"
#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"

#define REPORT_MAX 512u
#define WINDOW_MAX 16u
#define EVENT_MAX 64u
typedef struct { cp_v3_stats_report_t report; uint8_t payload[1650]; } report_slot_t;
typedef struct { uint64_t index,seen,drops,invalid; bool used; } source_ledger_t;
struct cp_v3_capture {
    cp_v3_capture_config_t config;
    cp_v3_capture_status_t status;
    portMUX_TYPE source;
    StaticQueue_t free_control,ready_control;
    QueueHandle_t free,ready;
    StaticSemaphore_t handoff_control,api_control;
    SemaphoreHandle_t handoff,api;
    TaskHandle_t worker;
    report_slot_t *reports;
    uint8_t *free_indices,*ready_indices;
    cp_v3_capture_window_t *windows,pending_window;
    cp_v3_capture_event_t *events;
    source_ledger_t *ledger;
    uint16_t ledger_count,window_head,window_count;
    bool event_ready,event_release_requested;
    uint8_t released_event_id[16]; uint32_t released_event_revision;
    cp_v3_stats_t *statistics;
    cp_v3_temporal_t *temporal;
    cp_v3_scope_t scope,requested_scope;
    cp_v3_temporal_time_t window_start_time,last_temporal;
    cp_v3_temporal_context_t temporal_context;
    uint64_t epoch_us,window_start_us,window_end_us,window_index,deadline_ms,trial_end_us;
    uint64_t pause_us,scan_transition_us;
    uint32_t next_window_seq,requested_seq,interval_units,window_units;
    uint32_t full_windows;
    uint32_t callbacks,command,completed_command;
    esp_err_t command_result;
    cp_v3_temporal_reason_t pause_reason;
    bool synchronized,accept,scanning,want_running,pause_requested,manual_pause;
    bool start_requested,have_window,pending_window_valid,held_valid,scan_transition;
    uint16_t held;
};
static cp_v3_capture_t *instance;
static cp_v3_capture_status_t preparation;
static bool attempted;

static uint64_t now_us(void) { return (uint64_t)esp_timer_get_time(); }
static bool identifier(const char *value,size_t capacity) {
    const char *end=memchr(value,0,capacity); if(!end||end==value) return false;
    for(const char *p=value;p<end;p++) if(!((*p>='a'&&*p<='z')||(*p>='0'&&*p<='9')||
        (p>value&&(*p=='_'||*p=='-')))) return false;
    return true;
}
static bool scope_valid(const cp_v3_scope_t *s) {
    if(!s||!identifier(s->node_id,sizeof s->node_id)||!identifier(s->policy_id,sizeof s->policy_id)||
       !identifier(s->placement_id,sizeof s->placement_id)||!memchr(s->boot_id,0,sizeof s->boot_id)||
       strlen(s->boot_id)!=36||s->boot_id[14]!='4'||!strchr("89ab",s->boot_id[19])||
       !memchr(s->policy_sha256,0,sizeof s->policy_sha256)||strlen(s->policy_sha256)!=64||
       !memchr(s->dataset,0,sizeof s->dataset)||!s->assignment_generation||s->assignment_generation>UINT32_MAX) return false;
    for(unsigned i=0;i<36;i++) {
        char c=s->boot_id[i]; if(i==8||i==13||i==18||i==23) { if(c!='-') return false; }
        else if(!((c>='0'&&c<='9')||(c>='a'&&c<='f'))) return false;
    }
    for(unsigned i=0;i<64;i++) if(!((s->policy_sha256[i]>='0'&&s->policy_sha256[i]<='9')||
        (s->policy_sha256[i]>='a'&&s->policy_sha256[i]<='f'))) return false;
    return !strcmp(s->dataset,"field")||!strcmp(s->dataset,"demo")||!strcmp(s->dataset,"controlled_test");
}
static void heap_snapshot(cp_v3_capture_status_t *s) {
    s->internal_free=(uint32_t)heap_caps_get_free_size(MALLOC_CAP_INTERNAL|MALLOC_CAP_8BIT);
    s->internal_largest=(uint32_t)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL|MALLOC_CAP_8BIT);
    s->psram_free=(uint32_t)heap_caps_get_free_size(MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT);
    s->psram_largest=(uint32_t)heap_caps_get_largest_free_block(MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT);
}
static bool floors(const cp_v3_capture_config_t *c,cp_v3_capture_status_t *s,const char *stage) {
    heap_snapshot(s);
    if(s->internal_free<c->min_internal_free||s->internal_largest<c->min_internal_largest||
       s->psram_free<c->min_psram_free||s->psram_largest<c->min_psram_largest) {
        s->failed=true; s->last_error=ESP_ERR_NO_MEM; snprintf(s->failure_stage,sizeof s->failure_stage,"%s",stage); return false;
    }
    return true;
}
static void fail(cp_v3_capture_t *s,const char *stage,esp_err_t error) {
    portENTER_CRITICAL(&s->source);
    s->status.failed=true; s->status.last_error=error; s->accept=false; s->want_running=false;
    s->pause_requested=true; s->manual_pause=true;
    if(!s->pause_us) s->pause_us=now_us();
    snprintf(s->status.failure_stage,sizeof s->status.failure_stage,"%s",stage);
    portEXIT_CRITICAL(&s->source);
}
static void *allocate_aligned(cp_v3_capture_t *s,const char *stage,size_t bytes,uint32_t capabilities,size_t alignment) {
    char label[32]; snprintf(label,sizeof label,"%s_before",stage);
    if(!bytes||!floors(&s->config,&s->status,label)) return NULL;
    /* IDF5.5.3 ordinary capability calloc follows TLSF's 4-byte alignment.
     * Arena APIs explicitly require their reported max_align_t alignment. */
    void *p=alignment?heap_caps_aligned_calloc(alignment,1,bytes,capabilities):heap_caps_calloc(1,bytes,capabilities);
    if(!p) { snprintf(label,sizeof label,"%s_alloc",stage); fail(s,label,ESP_ERR_NO_MEM); return NULL; }
    snprintf(label,sizeof label,"%s_after",stage);
    if(!floors(&s->config,&s->status,label)) return NULL;
    return p;
}
static void *allocate(cp_v3_capture_t *s,const char *stage,size_t bytes,uint32_t capabilities) {
    return allocate_aligned(s,stage,bytes,capabilities,0);
}
static cp_v3_temporal_time_t mapped(cp_v3_capture_t *s,uint64_t us) {
    cp_v3_temporal_time_t t={.mono_ms=us/1000,.clock_epoch=1};
    cp_v3_temporal_time_t supplied;
    if(s->config.clock&&s->config.clock(s->config.context_pointer,t.mono_ms,&supplied)&&
       supplied.mono_ms==t.mono_ms&&supplied.clock_epoch&&supplied.utc_ms<=8640000000000000ULL&&supplied.uncertainty_ms<=5000)
        t=supplied;
    return t;
}
static void request_pause_locked(cp_v3_capture_t *s,cp_v3_temporal_reason_t reason,uint64_t at,bool manual) {
    /* Repeated stop after a completed boundary must not invent a later tail
     * window. Existing handoffs/terminals keep draining without a new cutoff. */
    if(!s->want_running&&!s->scanning&&!s->have_window&&!s->pause_requested)return;
    /* A late caller cannot move a known authority/trial boundary forward. */
    if(s->want_running||s->scanning||s->have_window) {
        if(s->deadline_ms&&at>=s->deadline_ms*1000) {
            at=s->deadline_ms*1000;reason=CP_V3_TEMPORAL_LEASE_EXPIRED;manual=true;
        }
        if(s->trial_end_us&&at>=s->trial_end_us) {
            at=s->trial_end_us;reason=CP_V3_TEMPORAL_SCAN_GAP;manual=true;
        }
    }
    s->accept=false;
    if(!s->pause_requested||at<s->pause_us) { s->pause_us=at; s->pause_reason=reason; }
    s->pause_requested=true;
    if(manual) { s->manual_pause=true; s->want_running=false; }
}
static void authority_cutoff_locked(cp_v3_capture_t *s,uint64_t at) {
    if(!s->want_running)return;
    uint64_t cutoff=s->deadline_ms*1000;
    cp_v3_temporal_reason_t reason=CP_V3_TEMPORAL_LEASE_EXPIRED;
    if(s->trial_end_us&&s->trial_end_us<=cutoff){cutoff=s->trial_end_us;reason=CP_V3_TEMPORAL_SCAN_GAP;}
    if(at>=cutoff){
        if(reason==CP_V3_TEMPORAL_LEASE_EXPIRED)++s->status.authority_pauses;
        request_pause_locked(s,reason,cutoff,true);
    }
}
static int gap(struct ble_gap_event *event,void *context) {
    cp_v3_capture_t *s=context;
    portENTER_CRITICAL(&s->source); s->callbacks++;
    uint64_t at=now_us();
    if(event->type==BLE_GAP_EVENT_DISC_COMPLETE) {
        s->scanning=false; s->status.running=false; s->status.paused=true;
        s->scan_transition=true; s->scan_transition_us=at;
        if(s->accept) { s->status.scan_failures++; request_pause_locked(s,CP_V3_TEMPORAL_SCAN_GAP,at,false); }
        s->callbacks--; portEXIT_CRITICAL(&s->source); return 0;
    }
    if(event->type!=BLE_GAP_EVENT_DISC&&event->type!=BLE_GAP_EVENT_EXT_DISC) {
        s->callbacks--; portEXIT_CRITICAL(&s->source); return 0;
    }
    if(!s->accept||at/1000>=s->deadline_ms||(s->trial_end_us&&at>=s->trial_end_us)) {
        s->status.ignored_reports++;
        if(s->accept) {
            if(s->trial_end_us&&at>=s->trial_end_us) {
                request_pause_locked(s,CP_V3_TEMPORAL_SCAN_GAP,s->trial_end_us,true);
            } else { s->status.authority_pauses++; request_pause_locked(s,CP_V3_TEMPORAL_LEASE_EXPIRED,s->deadline_ms*1000,true); }
        }
        s->callbacks--; portEXIT_CRITICAL(&s->source); return 0;
    }
    uint64_t sequence=++s->status.callback_reports;
    uint64_t index=(at-s->epoch_us)/((uint64_t)s->config.statistics.window_ms*1000);
    source_ledger_t *ledger=&s->ledger[index%s->ledger_count];
    if(ledger->used&&ledger->index!=index) {
        s->status.source_ledger_overflow++; s->status.callback_drops++;
        request_pause_locked(s,CP_V3_TEMPORAL_CAPACITY,at,false);
        s->callbacks--; portEXIT_CRITICAL(&s->source); return 0;
    }
    ledger->used=true; ledger->index=index; ledger->seen++;
    const uint8_t *bytes=event->type==BLE_GAP_EVENT_DISC?event->disc.data:event->ext_disc.data;
    size_t length=event->type==BLE_GAP_EVENT_DISC?event->disc.length_data:event->ext_disc.length_data;
    if(length>1650||(length&&!bytes)) {
        ledger->invalid++; s->status.invalid_reports++;
        request_pause_locked(s,CP_V3_TEMPORAL_SCAN_GAP,at,false);
        s->callbacks--; portEXIT_CRITICAL(&s->source); return 0;
    }
    uint16_t slot;
    if(xQueueReceive(s->free,&slot,0)!=pdTRUE) {
        ledger->drops++; s->status.callback_drops++;
        request_pause_locked(s,CP_V3_TEMPORAL_CAPACITY,at,false);
        s->callbacks--; portEXIT_CRITICAL(&s->source); return 0;
    }
    report_slot_t *r=&s->reports[slot]; memset(&r->report,0,sizeof r->report);
    r->report.seq=sequence; r->report.mono_us=at; r->report.length=length;
    r->report.payload=r->payload; r->report.tx_power=127; r->report.sid=255;
    if(event->type==BLE_GAP_EVENT_DISC) {
        const struct ble_gap_disc_desc *d=&event->disc;
        r->report.event_type=d->event_type; r->report.address_type=d->addr.type; memcpy(r->report.address,d->addr.val,6);
        r->report.direct_address_type=d->direct_addr.type; memcpy(r->report.direct_address,d->direct_addr.val,6);
        r->report.rssi=d->rssi; r->report.primary_phy=BLE_HCI_LE_PHY_1M;
    } else {
        const struct ble_gap_ext_disc_desc *d=&event->ext_disc;
        r->report.kind=1; r->report.event_type=d->legacy_event_type; r->report.props=d->props; r->report.data_status=d->data_status;
        r->report.address_type=d->addr.type; memcpy(r->report.address,d->addr.val,6);
        r->report.direct_address_type=d->direct_addr.type; memcpy(r->report.direct_address,d->direct_addr.val,6);
        r->report.rssi=d->rssi; r->report.tx_power=d->tx_power; r->report.sid=d->sid;
        r->report.primary_phy=d->prim_phy; r->report.secondary_phy=d->sec_phy; r->report.periodic_interval=d->periodic_adv_itvl;
    }
    if(length) memcpy(r->payload,bytes,length);
    /* Timestamp, source ledger and publication share one bounded lock. No
     * callback can publish a later timestamp ahead of an earlier copied slot. */
    if(xQueueSend(s->ready,&slot,0)!=pdTRUE) {
        ledger->drops++; s->status.callback_drops++; (void)xQueueSend(s->free,&slot,0);
    }
    s->callbacks--; portEXIT_CRITICAL(&s->source); return 0;
}
static void synchronized(void) {
    cp_v3_capture_t *s=instance; if(!s) return;
    portENTER_CRITICAL(&s->source); s->synchronized=true; s->status.ble_ready=true; portEXIT_CRITICAL(&s->source);
}
static void reset(int reason) {
    (void)reason; cp_v3_capture_t *s=instance; if(!s) return;
    portENTER_CRITICAL(&s->source); s->status.ble_resets++; s->synchronized=false; s->status.ble_ready=false;
    s->scanning=false; s->status.running=false; s->status.paused=true;
    request_pause_locked(s,CP_V3_TEMPORAL_SCAN_GAP,now_us(),false); portEXIT_CRITICAL(&s->source);
}
static void host(void *unused) {
    (void)unused; nimble_port_run();
    if(instance) fail(instance,"host_returned",ESP_FAIL);
    /* No observer-host stop/deinit: lifetime is until reboot. */
    for(;;) vTaskDelay(pdMS_TO_TICKS(1000));
}
static bool flush_window(cp_v3_capture_t *s) {
    if(!s->pending_window_valid) return true;
    xSemaphoreTake(s->handoff,portMAX_DELAY);
    bool room=s->window_count<s->config.window_slots;
    if(room) { unsigned at=(s->window_head+s->window_count)%s->config.window_slots;
        s->windows[at]=s->pending_window; s->window_count++; s->pending_window_valid=false; }
    xSemaphoreGive(s->handoff); return room;
}
static bool close_window(cp_v3_capture_t *s,uint64_t end) {
    if(!s->have_window) return true;
    if(!flush_window(s)) return false;
    if(end<s->window_start_us) { fail(s,"window_time",ESP_FAIL); return false; }
    if(end==s->window_start_us) { s->have_window=false; return true; }
    cp_v3_stats_source_t source={.reports_seen_known=true,.queue_drops_known=true,.processing_losses_known=true};
    portENTER_CRITICAL(&s->source);
    source_ledger_t *ledger=&s->ledger[s->window_index%s->ledger_count];
    if(ledger->used&&ledger->index==s->window_index) {
        source.reports_seen=ledger->seen; source.queue_drops=ledger->drops+ledger->invalid; memset(ledger,0,sizeof *ledger);
    }
    if(s->status.source_ledger_overflow) source.reports_seen_known=source.queue_drops_known=false;
    portEXIT_CRITICAL(&s->source);
    cp_v3_temporal_time_t time=mapped(s,end);
    bool clock=s->window_start_time.utc_known&&time.utc_known&&s->window_start_time.clock_epoch==time.clock_epoch&&
        !s->window_start_time.uncertainty_ms&&!time.uncertainty_ms;
    (void)cp_v3_stats_set_clock_usable(s->statistics,clock);
    if(!cp_v3_stats_set_source(s->statistics,source)||!cp_v3_stats_snapshot(s->statistics,end,&s->pending_window.statistics)) {
        fail(s,"window_snapshot",ESP_FAIL); return false;
    }
    if(s->pause_requested&&s->pause_us>=s->window_start_us&&s->pause_us<end)
        s->pending_window.statistics.quality_mask|=1u;
    s->pending_window.scope=s->scope; s->pending_window.window_seq=s->next_window_seq;
    s->pending_window.scope.window_seq=s->next_window_seq; s->pending_window.end_time=time;
    if(s->temporal) cp_v3_temporal_status(s->temporal,&s->pending_window.temporal);
    s->pending_window_valid=true; s->have_window=false;
    portENTER_CRITICAL(&s->source); s->status.windows_closed++;
    s->status.last_closed_window_seq=s->next_window_seq;portEXIT_CRITICAL(&s->source);
    if(s->pending_window.statistics.window_closed&&!(s->pending_window.statistics.quality_mask&1)) {
        s->full_windows++;
        if(s->config.stop_after_windows&&s->full_windows>=s->config.stop_after_windows) {
            portENTER_CRITICAL(&s->source); s->status.bounded_complete=true;
            request_pause_locked(s,CP_V3_TEMPORAL_SCAN_GAP,end,true); portEXIT_CRITICAL(&s->source);
        }
    }
    if(s->next_window_seq==UINT32_MAX) { fail(s,"window_sequence",ESP_FAIL); return false; }
    s->next_window_seq++;
    if(!flush_window(s)) {
        portENTER_CRITICAL(&s->source); s->status.window_backpressure++;
        request_pause_locked(s,CP_V3_TEMPORAL_CAPACITY,now_us(),false); portEXIT_CRITICAL(&s->source); return false;
    }
    return true;
}
static bool begin_window(cp_v3_capture_t *s,uint64_t start) {
    s->window_start_us=start; s->window_end_us=start+(uint64_t)s->config.statistics.window_ms*1000;
    s->window_start_time=mapped(s,start);
    portENTER_CRITICAL(&s->source);
    bool scanning=s->scanning||(s->pause_requested&&start<s->pause_us);
    portEXIT_CRITICAL(&s->source);
    if(!cp_v3_stats_begin(s->statistics,start)||!cp_v3_stats_scan_state(s->statistics,start,scanning)) {
        fail(s,"window_begin",ESP_FAIL); return false;
    }
    s->have_window=true; return true;
}
static bool rotate_to(cp_v3_capture_t *s,uint64_t at) {
    while(s->have_window&&at>=s->window_end_us) {
        uint64_t end=s->window_end_us;
        if(!close_window(s,end)) return false;
        if(s->status.bounded_complete) return false;
        s->window_index++;
        if(!begin_window(s,end)) return false;
    }
    return true;
}
static void drain_events(cp_v3_capture_t *s) {
    if(!s->temporal) return;
    xSemaphoreTake(s->handoff,portMAX_DELAY);
    if(s->event_ready&&s->event_release_requested) {
        cp_v3_temporal_event_t *e=&s->events[0].event;
        if(cp_v3_temporal_terminal_release(s->temporal,e->event_id,e->event_seq,e->revision)!=CP_V3_TEMPORAL_OK)
            fail(s,"event_release",ESP_FAIL);
        else { memcpy(s->released_event_id,e->event_id,16); s->released_event_revision=e->revision;
            s->event_ready=false; s->event_release_requested=false; }
    }
    xSemaphoreGive(s->handoff);
    cp_v3_temporal_event_t event;
    while(cp_v3_temporal_terminal_peek(s->temporal,&event)==CP_V3_TEMPORAL_OK) {
        if(!s->config.report_events) {
            if(cp_v3_temporal_terminal_release(s->temporal,event.event_id,event.event_seq,event.revision)!=CP_V3_TEMPORAL_OK) {
                fail(s,"event_local_release",ESP_FAIL); return;
            }
            portENTER_CRITICAL(&s->source); s->status.events_consumed_local++; portEXIT_CRITICAL(&s->source); continue;
        }
        xSemaphoreTake(s->handoff,portMAX_DELAY);
        if(!s->event_ready) { s->events[0]=(cp_v3_capture_event_t){.scope=s->scope,.event=event,
                .slice_ms=s->config.temporal.slice_ms,.report_allowed=true}; s->event_ready=true; }
        xSemaphoreGive(s->handoff); break;
    }
    cp_v3_temporal_status_t status; cp_v3_temporal_status(s->temporal,&status);
    portENTER_CRITICAL(&s->source); s->status.temporal=status; portEXIT_CRITICAL(&s->source);
    if(status.blocked) {
        portENTER_CRITICAL(&s->source); s->status.event_backpressure++;
        request_pause_locked(s,CP_V3_TEMPORAL_CAPACITY,now_us(),false); portEXIT_CRITICAL(&s->source);
    }
}
static bool temporal_at(cp_v3_capture_t *s,uint64_t at,bool report,const cp_v3_stats_report_t *r) {
    if(!s->temporal) return true;
    cp_v3_temporal_time_t t=mapped(s,at);
    if(t.clock_epoch!=s->last_temporal.clock_epoch||t.utc_known!=s->last_temporal.utc_known) {
        cp_v3_temporal_result_t b=cp_v3_temporal_boundary(s->temporal,t,&s->temporal_context,CP_V3_TEMPORAL_CLOCK_CHANGE);
        if(b!=CP_V3_TEMPORAL_OK&&b!=CP_V3_TEMPORAL_BACKPRESSURE) { fail(s,"temporal_clock",ESP_FAIL); return false; }
        (void)cp_v3_temporal_set_coverage(s->temporal,t,s->scanning); s->last_temporal=t;
    }
    cp_v3_temporal_result_t result=report?
        cp_v3_temporal_report(s->temporal,t,r->address_type,r->address,r->rssi>=-127&&r->rssi<=20,r->rssi,NULL):
        cp_v3_temporal_advance(s->temporal,t);
    if(result==CP_V3_TEMPORAL_OK||result==CP_V3_TEMPORAL_BACKPRESSURE)s->last_temporal=t;
    if(result==CP_V3_TEMPORAL_INVALID||result==CP_V3_TEMPORAL_LATE||result==CP_V3_TEMPORAL_EXHAUSTED||result==CP_V3_TEMPORAL_ENTROPY_FAILED) {
        fail(s,"temporal_order",ESP_FAIL); return false;
    }
    drain_events(s); return true;
}
static bool start_scanner(cp_v3_capture_t *s) {
    uint64_t at=now_us();
    portENTER_CRITICAL(&s->source);
    bool allowed=s->synchronized&&s->want_running&&!s->manual_pause&&!s->pause_requested&&
        at/1000<s->deadline_ms&&!s->status.failed;
    portEXIT_CRITICAL(&s->source);
    if(!allowed||ble_gap_disc_active()) return false;
    struct ble_gap_ext_disc_params p={.itvl=s->interval_units,.window=s->window_units,.passive=1};
    /* cp-v3-small/1 negotiates exactly passive 1M. NimBLE's NULL coded
     * parameters explicitly disable coded-PHY scanning. */
    int result=ble_gap_ext_disc(BLE_OWN_ADDR_PUBLIC,0,0,0,0,0,&p,NULL,gap,s);
    if(result) { portENTER_CRITICAL(&s->source); s->status.scan_failures++; portEXIT_CRITICAL(&s->source); fail(s,"scan_start",ESP_FAIL); return false; }
    portENTER_CRITICAL(&s->source);
    at=now_us();
    allowed=s->want_running&&!s->manual_pause&&!s->pause_requested&&at/1000<s->deadline_ms&&!s->status.failed;
    if(!allowed) {
        s->scanning=true;
        if(!s->pause_requested) request_pause_locked(s,CP_V3_TEMPORAL_LEASE_EXPIRED,s->deadline_ms*1000,true);
        portEXIT_CRITICAL(&s->source);
        (void)ble_gap_disc_cancel();
        return false;
    }
    s->epoch_us=at/1000*1000; s->window_index=0; memset(s->ledger,0,(size_t)s->ledger_count*sizeof *s->ledger);
    s->trial_end_us=s->config.stop_after_windows?
        s->epoch_us+(uint64_t)(s->config.stop_after_windows-s->full_windows)*s->config.statistics.window_ms*1000:0;
    s->scanning=true; s->scan_transition=false; s->pause_us=0; s->pause_requested=false;
    s->status.running=true; s->status.paused=false;
    portEXIT_CRITICAL(&s->source);
    if(!begin_window(s,s->epoch_us)) return false;
    /* Statistics boundaries are integral milliseconds. The fractional initial
     * interval before the acknowledged scan start remains an explicit gap. */
    (void)cp_v3_stats_scan_state(s->statistics,s->epoch_us,false);
    (void)cp_v3_stats_scan_state(s->statistics,at,true);
    if(s->temporal) { cp_v3_temporal_time_t t=mapped(s,at); (void)temporal_at(s,at,false,NULL);
        (void)cp_v3_temporal_set_coverage(s->temporal,t,true); }
    portENTER_CRITICAL(&s->source);
    if(at/1000<s->deadline_ms&&!s->pause_requested&&s->want_running&&!s->manual_pause&&s->scanning&&!s->status.failed) s->accept=true;
    else request_pause_locked(s,CP_V3_TEMPORAL_LEASE_EXPIRED,at,true);
    portEXIT_CRITICAL(&s->source); return true;
}
static bool idle_barrier(cp_v3_capture_t *s,uint64_t *at) {
    portENTER_CRITICAL(&s->source);
    bool idle=!s->callbacks&&!uxQueueMessagesWaiting(s->ready)&&!s->held_valid;
    if(idle) {
        *at=now_us(); /* Future callback timestamps use this same source lock. */
        authority_cutoff_locked(s,*at);
        if(s->pause_requested&&s->pause_us<*at)*at=s->pause_us;
    }
    portEXIT_CRITICAL(&s->source); return idle;
}
static void step(cp_v3_capture_t *s) {
    drain_events(s);
    if(s->start_requested) {
        bool initial=s->scope.boot_id[0]==0;
        s->scope=s->requested_scope; s->next_window_seq=s->requested_seq;
        if(initial){s->full_windows=0;s->status.bounded_complete=false;}
        bool ok=start_scanner(s);
        portENTER_CRITICAL(&s->source); s->start_requested=false; s->command_result=ok?ESP_OK:ESP_ERR_INVALID_STATE;
        s->completed_command=s->command; portEXIT_CRITICAL(&s->source);
    }
    portENTER_CRITICAL(&s->source);
    uint64_t now=now_us();
    authority_cutoff_locked(s,now);
    bool pause=s->pause_requested; bool scanning=s->scanning;
    portEXIT_CRITICAL(&s->source);
    if(pause&&scanning) {
        int result=ble_gap_disc_cancel();
        if(result&&result!=BLE_HS_EALREADY) { fail(s,"scan_cancel",ESP_FAIL); }
        portENTER_CRITICAL(&s->source); s->scanning=false; s->status.running=false; s->status.paused=true; portEXIT_CRITICAL(&s->source);
    }
    if(!flush_window(s)) return;
    if(!s->have_window&&s->pause_requested&&s->epoch_us&&s->pause_us>s->window_end_us) {
        uint64_t start=s->window_end_us; s->window_index++;
        if(!begin_window(s,start)) return;
    }
    for(unsigned work=0;work<64;work++) {
        uint16_t index;
        if(s->held_valid) index=s->held;
        else if(xQueueReceive(s->ready,&index,0)!=pdTRUE) break;
        s->held=index; s->held_valid=true;
        cp_v3_stats_report_t *r=&s->reports[index].report;
        if(!s->have_window) { if(!begin_window(s,s->window_start_us+(uint64_t)s->config.statistics.window_ms*1000)) return; s->window_index++; }
        if(!rotate_to(s,r->mono_us)) return;
        if(s->config.raw) {
            bool accepted=s->config.raw(s->config.context_pointer,r);
            portENTER_CRITICAL(&s->source); s->status.raw_reports++;
            if(accepted) s->status.raw_accepted++; else s->status.raw_drops++; portEXIT_CRITICAL(&s->source);
        }
        cp_v3_stats_result_t result=cp_v3_stats_observe(s->statistics,r);
        if(result==CP_V3_STATS_INVALID||result==CP_V3_STATS_OUTSIDE_WINDOW) { fail(s,"statistics_order",ESP_FAIL); return; }
        (void)temporal_at(s,r->mono_us,true,r);
        s->held_valid=false; (void)xQueueSend(s->free,&index,0);
    }
    uint64_t at=0;
    if(!idle_barrier(s,&at)) return;
    portENTER_CRITICAL(&s->source); pause=s->pause_requested; uint64_t stop=s->pause_us; portEXIT_CRITICAL(&s->source);
    if(pause) {
        if(!stop) stop=at;
        /* A manual pause can arrive after the idle barrier. Its later interval
         * may already contain newly queued callbacks: drain on the next step
         * before closing or advancing to that stop timestamp. */
        if(stop>at)return;
        /* The idle barrier may have discovered expiry after the early scanner
         * cancellation point in this step. Stop hardware before clearing pause. */
        portENTER_CRITICAL(&s->source);scanning=s->scanning;portEXIT_CRITICAL(&s->source);
        if(scanning) {
            int result=ble_gap_disc_cancel();
            if(result&&result!=BLE_HS_EALREADY)fail(s,"scan_cancel",ESP_FAIL);
            portENTER_CRITICAL(&s->source);s->scanning=false;s->status.running=false;s->status.paused=true;portEXIT_CRITICAL(&s->source);
        }
        if(s->have_window) {
            if(!rotate_to(s,stop)) return;
            (void)cp_v3_stats_scan_state(s->statistics,stop,false);
            uint64_t rounded=(stop+999)/1000*1000;
            portENTER_CRITICAL(&s->source); uint64_t limit=s->deadline_ms*1000; portEXIT_CRITICAL(&s->source);
            if(rounded>limit) rounded=limit;
            if(!close_window(s,rounded)) return;
        }
        if(s->temporal) {
            cp_v3_temporal_time_t t=mapped(s,stop);
            cp_v3_temporal_result_t ended;
            if(t.clock_epoch!=s->last_temporal.clock_epoch||t.utc_known!=s->last_temporal.utc_known)
                ended=cp_v3_temporal_boundary(s->temporal,t,&s->temporal_context,CP_V3_TEMPORAL_CLOCK_CHANGE);
            else if(s->pause_reason>=CP_V3_TEMPORAL_CLOCK_CHANGE&&s->pause_reason<=CP_V3_TEMPORAL_REBOOT)
                ended=cp_v3_temporal_boundary(s->temporal,t,&s->temporal_context,s->pause_reason);
            else {
                cp_v3_temporal_reason_t reason=s->pause_reason;
                if(reason!=CP_V3_TEMPORAL_TIMEOUT&&reason!=CP_V3_TEMPORAL_CAPACITY&&reason!=CP_V3_TEMPORAL_LEASE_EXPIRED&&
                    reason!=CP_V3_TEMPORAL_SCAN_GAP&&reason!=CP_V3_TEMPORAL_LATE_REPORT) reason=CP_V3_TEMPORAL_SCAN_GAP;
                ended=cp_v3_temporal_censor(s->temporal,t,reason);
            }
            if(ended!=CP_V3_TEMPORAL_OK&&ended!=CP_V3_TEMPORAL_BACKPRESSURE) {
                /* Never leave an open/known episode alive after a failed stop.
                 * Fence at its last actually processed time, retain terminals,
                 * and fail the collector instead of inventing past coverage. */
                (void)cp_v3_temporal_boundary(s->temporal,s->last_temporal,&s->temporal_context,CP_V3_TEMPORAL_CLOCK_CHANGE);
                fail(s,"temporal_pause",ESP_FAIL);
            } else s->last_temporal=t;
            drain_events(s);
        }
        portENTER_CRITICAL(&s->source); s->status.running=false; s->status.paused=true;
        s->pause_requested=false; s->scan_transition=false; portEXIT_CRITICAL(&s->source);
    } else if(s->have_window) {
        if(!rotate_to(s,at)) return;
        (void)temporal_at(s,at,false,NULL);
    } else if(s->temporal) (void)temporal_at(s,at,false,NULL);
    if(s->want_running&&!s->manual_pause&&!s->have_window&&!s->pending_window_valid&&!s->status.failed) {
        xSemaphoreTake(s->handoff,portMAX_DELAY); bool room=s->window_count<s->config.window_slots; xSemaphoreGive(s->handoff);
        cp_v3_temporal_status_t temporal={0}; if(s->temporal) cp_v3_temporal_status(s->temporal,&temporal);
        if(room&&!temporal.blocked) (void)start_scanner(s);
    }
    cp_v3_temporal_status_t temporal={0}; if(s->temporal) cp_v3_temporal_status(s->temporal,&temporal);
    xSemaphoreTake(s->handoff,portMAX_DELAY);
    uint16_t windows=s->window_count,events=s->event_ready?1:0;
    xSemaphoreGive(s->handoff);
    cp_v3_capture_status_t measured={0}; heap_snapshot(&measured);
    portENTER_CRITICAL(&s->source); s->status.temporal=temporal;
    s->status.window_handoffs=windows;s->status.event_handoffs=events;
    s->status.quiescent=!s->status.running&&!s->want_running&&!s->have_window&&!s->pending_window_valid&&
        !s->held_valid&&!s->callbacks&&!s->start_requested&&!s->pause_requested&&!windows&&!events&&
        !temporal.open_events&&!temporal.pending_terminals&&!temporal.terminal_events;
    s->status.collector_stack_min=(uint32_t)uxTaskGetStackHighWaterMark(NULL);
    s->status.internal_free=measured.internal_free; s->status.internal_largest=measured.internal_largest;
    s->status.psram_free=measured.psram_free; s->status.psram_largest=measured.psram_largest; portEXIT_CRITICAL(&s->source);
}
static void collector(void *context) { cp_v3_capture_t *s=context; for(;;) { step(s); vTaskDelay(pdMS_TO_TICKS(5)); } }

esp_err_t cp_v3_capture_prepare(const cp_v3_capture_config_t *config,cp_v3_capture_t **out) {
    if(out) *out=NULL;
    if(!config||!out||attempted||!config->clock||!config->entropy||!cp_v3_stats_memory_bytes(config->statistics.capacity)||
       !config->context.boot_generation||!config->context.config_generation||!config->context.placement_generation||
       config->report_slots>REPORT_MAX||config->window_slots>WINDOW_MAX||config->event_slots>EVENT_MAX||config->stop_after_windows>1000000||
       (config->report_events&&!config->temporal_enabled)||
       (config->temporal_enabled&&(config->temporal.history_ms!=600000||!cp_v3_temporal_memory_bytes(&config->temporal)))) {
        if(!attempted) { preparation.failed=true; preparation.last_error=ESP_ERR_INVALID_ARG; strcpy(preparation.failure_stage,"configuration"); }
        return ESP_ERR_INVALID_ARG;
    }
    attempted=true; memset(&preparation,0,sizeof preparation);
    if(!floors(config,&preparation,"instance_before")) return ESP_ERR_NO_MEM;
    cp_v3_capture_t *s=heap_caps_calloc(1,sizeof *s,MALLOC_CAP_INTERNAL|MALLOC_CAP_8BIT);
    if(!s) { preparation.failed=true; preparation.last_error=ESP_ERR_NO_MEM; strcpy(preparation.failure_stage,"instance_alloc"); return ESP_ERR_NO_MEM; }
    s->source=(portMUX_TYPE)portMUX_INITIALIZER_UNLOCKED; s->config=*config; *out=instance=s;
    s->status=preparation; s->status.paused=true; s->temporal_context=config->context;
    if(!s->config.report_slots) s->config.report_slots=128;
    if(!s->config.window_slots) s->config.window_slots=4;
    if(!s->config.event_slots) s->config.event_slots=1;
    if(!s->config.collector_stack_bytes) s->config.collector_stack_bytes=8192;
    if(!floors(&s->config,&s->status,"instance_after")) return ESP_ERR_NO_MEM;
    s->handoff=xSemaphoreCreateMutexStatic(&s->handoff_control); s->api=xSemaphoreCreateMutexStatic(&s->api_control);
    if(!s->handoff||!s->api) { fail(s,"mutex",ESP_ERR_NO_MEM); return ESP_ERR_NO_MEM; }
    s->status.statistics_bytes=cp_v3_stats_memory_bytes(config->statistics.capacity);
    s->status.statistics_alignment=(uint16_t)cp_v3_stats_memory_alignment();s->status.statistics_alignment_remainder=UINT16_MAX;
    void *statistics=allocate_aligned(s,"statistics",s->status.statistics_bytes,MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT,s->status.statistics_alignment);
    if(!statistics) return ESP_ERR_NO_MEM;
    s->status.statistics_alignment_remainder=(uint16_t)((uintptr_t)statistics%s->status.statistics_alignment);
    if(s->status.statistics_alignment_remainder){fail(s,"statistics_alignment",ESP_ERR_INVALID_STATE);return ESP_ERR_INVALID_STATE;}
    s->statistics=cp_v3_stats_init(statistics,s->status.statistics_bytes,&config->statistics);
    if(!s->statistics) { fail(s,"statistics_config",ESP_ERR_INVALID_ARG); return ESP_ERR_INVALID_ARG; }
    s->status.report_bytes=(size_t)s->config.report_slots*sizeof *s->reports;
    s->reports=allocate(s,"reports",s->status.report_bytes,MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT); if(!s->reports) return ESP_ERR_NO_MEM;
    s->status.window_bytes=(size_t)s->config.window_slots*sizeof *s->windows;
    s->windows=allocate(s,"windows",s->status.window_bytes,MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT); if(!s->windows) return ESP_ERR_NO_MEM;
    s->status.event_bytes=(size_t)s->config.event_slots*sizeof *s->events;
    s->events=allocate(s,"events",s->status.event_bytes,MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT); if(!s->events) return ESP_ERR_NO_MEM;
    s->ledger_count=s->config.window_slots+2; s->status.ledger_bytes=(size_t)s->ledger_count*sizeof *s->ledger;
    s->ledger=allocate(s,"source_ledger",s->status.ledger_bytes,MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT); if(!s->ledger) return ESP_ERR_NO_MEM;
    s->status.index_bytes=(size_t)s->config.report_slots*sizeof(uint16_t)*2;
    s->free_indices=allocate(s,"free_indices",s->status.index_bytes/2,MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT); if(!s->free_indices) return ESP_ERR_NO_MEM;
    s->ready_indices=allocate(s,"ready_indices",s->status.index_bytes/2,MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT); if(!s->ready_indices) return ESP_ERR_NO_MEM;
    s->free=xQueueCreateStatic(s->config.report_slots,sizeof(uint16_t),s->free_indices,&s->free_control);
    s->ready=xQueueCreateStatic(s->config.report_slots,sizeof(uint16_t),s->ready_indices,&s->ready_control);
    if(!s->free||!s->ready) { fail(s,"index_queues",ESP_ERR_NO_MEM); return ESP_ERR_NO_MEM; }
    for(uint16_t i=0;i<s->config.report_slots;i++) (void)xQueueSend(s->free,&i,0);
    if(s->config.temporal_enabled) {
        s->status.temporal_bytes=cp_v3_temporal_memory_bytes(&s->config.temporal);
        s->status.temporal_alignment=(uint16_t)cp_v3_temporal_memory_alignment();s->status.temporal_alignment_remainder=UINT16_MAX;
        void *memory=allocate_aligned(s,"temporal",s->status.temporal_bytes,MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT,s->status.temporal_alignment); if(!memory) return ESP_ERR_NO_MEM;
        s->status.temporal_alignment_remainder=(uint16_t)((uintptr_t)memory%s->status.temporal_alignment);
        if(s->status.temporal_alignment_remainder){fail(s,"temporal_alignment",ESP_ERR_INVALID_STATE);return ESP_ERR_INVALID_STATE;}
        cp_v3_temporal_time_t at=mapped(s,now_us()); s->last_temporal=at;
        if(cp_v3_temporal_init(memory,s->status.temporal_bytes,&s->config.temporal,&s->temporal_context,at,s->config.entropy,
            s->config.context_pointer,&s->temporal)!=CP_V3_TEMPORAL_OK) { fail(s,"temporal_config",ESP_ERR_INVALID_ARG); return ESP_ERR_INVALID_ARG; }
    }
    if(!floors(&s->config,&s->status,"ble_before")) return ESP_ERR_NO_MEM;
    esp_err_t error=nimble_port_init(); if(error!=ESP_OK) { heap_snapshot(&s->status); fail(s,"ble_init",error); return error; }
    if(!floors(&s->config,&s->status,"ble_after")) return ESP_ERR_NO_MEM;
    ble_hs_cfg.sync_cb=synchronized; ble_hs_cfg.reset_cb=reset;
    if(!floors(&s->config,&s->status,"host_before")) return ESP_ERR_NO_MEM;
    nimble_port_freertos_init(host);
    if(!floors(&s->config,&s->status,"host_after")) return ESP_ERR_NO_MEM;
    uint64_t sync_limit=now_us()+5000000;
    for(;;) {
        portENTER_CRITICAL(&s->source); bool ready=s->synchronized; portEXIT_CRITICAL(&s->source);
        if(ready) break;
        if(now_us()>=sync_limit) { fail(s,"ble_sync",ESP_ERR_TIMEOUT); return ESP_ERR_TIMEOUT; }
        vTaskDelay(pdMS_TO_TICKS(10));
    }
    if(!floors(&s->config,&s->status,"sync_after")) return ESP_ERR_NO_MEM;
    if(!floors(&s->config,&s->status,"worker_before")) return ESP_ERR_NO_MEM;
    if(xTaskCreate(collector,"cp_capture",s->config.collector_stack_bytes,s,5,&s->worker)!=pdPASS) { fail(s,"worker_task",ESP_ERR_NO_MEM); return ESP_ERR_NO_MEM; }
    if(!floors(&s->config,&s->status,"worker_after")) return ESP_ERR_NO_MEM;
    s->status.prepared=true; preparation=s->status; return ESP_OK;
}
static void wait_tick(cp_v3_capture_t *s) {
#ifdef CP_V3_CAPTURE_TEST
    step(s);
#else
    (void)s;
#endif
    vTaskDelay(pdMS_TO_TICKS(5));
}
esp_err_t cp_v3_capture_start(cp_v3_capture_t *s,const cp_v3_scope_t *scope,uint32_t next,uint32_t interval,uint32_t window,uint64_t deadline) {
    if(!s||!scope_valid(scope)||!next||!interval||window>interval||!window||interval>UINT16_MAX||!s->status.prepared||s->status.failed||
       deadline>UINT64_MAX/1000) return ESP_ERR_INVALID_ARG;
    xSemaphoreTake(s->api,portMAX_DELAY);
    portENTER_CRITICAL(&s->source);
    bool ready=!s->status.running&&!s->want_running&&!s->have_window&&!s->pending_window_valid&&!s->held_valid&&!uxQueueMessagesWaiting(s->ready)&&!s->start_requested&&
        !s->status.bounded_complete&&(!s->scope.boot_id[0]||s->status.quiescent)&&
        s->synchronized&&deadline>now_us()/1000&&scope->assignment_generation==s->config.context.config_generation&&
        (!s->scope.boot_id[0]||(!strcmp(s->scope.boot_id,scope->boot_id)&&!strcmp(s->scope.node_id,scope->node_id)&&
            !strcmp(s->scope.policy_id,scope->policy_id)&&!strcmp(s->scope.policy_sha256,scope->policy_sha256)&&
            !strcmp(s->scope.placement_id,scope->placement_id)&&!strcmp(s->scope.dataset,scope->dataset)&&next>=s->next_window_seq));
    if(s->temporal&&(s->status.temporal.terminal_events||s->status.temporal.pending_terminals)) ready=false;
    if(!ready) { portEXIT_CRITICAL(&s->source); xSemaphoreGive(s->api); return ESP_ERR_INVALID_STATE; }
    s->requested_scope=*scope; s->requested_seq=next; s->interval_units=interval; s->window_units=window; s->deadline_ms=deadline;
    s->command++; uint32_t command=s->command; s->want_running=true; s->manual_pause=false;
    s->start_requested=true; portEXIT_CRITICAL(&s->source);
    uint64_t stop=now_us()+5000000;
    while(s->completed_command!=command&&now_us()<stop) wait_tick(s);
    esp_err_t result=s->completed_command==command?s->command_result:ESP_ERR_TIMEOUT;
    xSemaphoreGive(s->api); return result;
}
esp_err_t cp_v3_capture_deadline(cp_v3_capture_t *s,uint64_t deadline) {
    if(!s||!s->status.prepared||deadline>UINT64_MAX/1000) return ESP_ERR_INVALID_ARG;
    portENTER_CRITICAL(&s->source); uint64_t now=now_us()/1000;
    bool valid=s->want_running&&!s->manual_pause&&now<s->deadline_ms&&deadline>now&&deadline>=s->deadline_ms;
    if(valid) s->deadline_ms=deadline;
    portEXIT_CRITICAL(&s->source); return valid?ESP_OK:ESP_ERR_INVALID_STATE;
}
esp_err_t cp_v3_capture_pause(cp_v3_capture_t *s,cp_v3_temporal_reason_t reason,uint32_t timeout) {
    if(!s||!s->status.prepared||(unsigned)reason>CP_V3_TEMPORAL_LATE_REPORT) return ESP_ERR_INVALID_ARG;
    portENTER_CRITICAL(&s->source); request_pause_locked(s,reason,now_us(),true); portEXIT_CRITICAL(&s->source);
    if(!timeout) return ESP_OK;
    uint64_t end=now_us()+(uint64_t)timeout*1000;
    while((s->status.running||s->have_window||s->pause_requested)&&now_us()<end) wait_tick(s);
    return !s->status.running&&!s->have_window&&!s->pause_requested?ESP_OK:ESP_ERR_TIMEOUT;
}
bool cp_v3_capture_window(cp_v3_capture_t *s,cp_v3_capture_window_t *out,uint32_t timeout) {
    if(!s||!out||!s->status.prepared) return false;
    uint64_t end=now_us()+(uint64_t)timeout*1000;
    do { xSemaphoreTake(s->handoff,portMAX_DELAY); bool have=s->window_count!=0;
        if(have) *out=s->windows[s->window_head];
        xSemaphoreGive(s->handoff); if(have) return true;
        if(!timeout) return false;
        wait_tick(s);
    } while(now_us()<end); return false;
}
bool cp_v3_capture_window_release(cp_v3_capture_t *s,uint32_t seq,uint64_t generation) {
    if(!s||!s->status.prepared) return false;
    xSemaphoreTake(s->handoff,portMAX_DELAY); bool match=s->window_count&&s->windows[s->window_head].window_seq==seq&&
        s->windows[s->window_head].scope.assignment_generation==generation;
    if(match) { s->window_head=(s->window_head+1)%s->config.window_slots; s->window_count--; }
    xSemaphoreGive(s->handoff); return match;
}
bool cp_v3_capture_event(cp_v3_capture_t *s,cp_v3_capture_event_t *out,uint32_t timeout) {
    if(!s||!out||!s->status.prepared) return false;
    uint64_t end=now_us()+(uint64_t)timeout*1000;
    do { xSemaphoreTake(s->handoff,portMAX_DELAY); bool have=s->event_ready&&!s->event_release_requested;
        if(have) *out=s->events[0];
        xSemaphoreGive(s->handoff); if(have) return true;
        if(!timeout) return false;
        wait_tick(s);
    } while(now_us()<end); return false;
}
bool cp_v3_capture_event_release(cp_v3_capture_t *s,const uint8_t id[16],uint32_t revision) {
    if(!s||!id||!revision||!s->status.prepared) return false;
    xSemaphoreTake(s->handoff,portMAX_DELAY);
    bool match=s->event_ready&&s->events[0].event.revision==revision&&!memcmp(s->events[0].event.event_id,id,16);
    if(match) s->event_release_requested=true;
    bool already=s->released_event_revision==revision&&!memcmp(s->released_event_id,id,16);
    xSemaphoreGive(s->handoff);
    if(!match) return already;
    uint64_t stop=now_us()+1000000;
    do { wait_tick(s); xSemaphoreTake(s->handoff,portMAX_DELAY);
        bool done=s->released_event_revision==revision&&!memcmp(s->released_event_id,id,16); xSemaphoreGive(s->handoff);
        if(done) return true;
    } while(now_us()<stop); return false;
}
void cp_v3_capture_status(cp_v3_capture_t *s,cp_v3_capture_status_t *out) {
    if(!s||!out) return;
    portENTER_CRITICAL(&s->source); *out=s->status; portEXIT_CRITICAL(&s->source);
}
void cp_v3_capture_prepare_status(cp_v3_capture_status_t *out) { if(!out) return; if(instance) cp_v3_capture_status(instance,out); else *out=preparation; }
#ifdef CP_V3_CAPTURE_TEST
void cp_v3_capture_test_step(cp_v3_capture_t *s) { step(s); }
#endif
