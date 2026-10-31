/* Deterministic scheduler: compile the production adapter, replace only IDF.
 * Including source exposes its private idle barrier for an injected race. */
#define CP_V3_CAPTURE_TEST 1
#include "../capture.c"
#include <assert.h>
#include <stdlib.h>

struct test_hs_cfg ble_hs_cfg;
static uint64_t clock_us=1000000;
static unsigned lock_depth,allocation_count,fail_allocation,ble_init_count,starts,cancels,entropy_counter;
static size_t internal_used,psram_used;
static void *allocations[32]; static unsigned allocated;
static int (*gap_callback)(struct ble_gap_event *,void *); static void *gap_context;
static unsigned inject_timer_after; static bool deferred_report;
static unsigned jump_timer_after;static uint64_t jump_us;static bool pause_after_deferred;
static bool scan_active;
static uint64_t scan_start_delay_us;
static bool unaligned_normal_allocations;
static unsigned aligned_allocations,misalign_aligned_allocation;
static size_t arena_sizes[2];
static void report_at(uint64_t,uint8_t,bool);
void test_lock(void) { lock_depth++; }
void test_unlock(void) {
    assert(lock_depth); lock_depth--;
    if(!lock_depth&&deferred_report) {
        deferred_report=false;report_at(clock_us+1,9,false);
        if(pause_after_deferred){pause_after_deferred=false;assert(cp_v3_capture_pause(instance,CP_V3_TEMPORAL_SCAN_GAP,0)==ESP_OK);}
    }
}
int64_t esp_timer_get_time(void) {
    if(lock_depth&&jump_timer_after&&!--jump_timer_after)clock_us+=jump_us;
    if(lock_depth&&inject_timer_after&&!--inject_timer_after) deferred_report=true;
    return (int64_t)clock_us;
}
static void *test_allocate(size_t alignment,size_t n,size_t size,uint32_t caps) {
    assert(caps==(MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT)||caps==(MALLOC_CAP_INTERNAL|MALLOC_CAP_8BIT));
    if(++allocation_count==fail_allocation) return NULL;
    size_t guard=_Alignof(max_align_t)*2;
    void *base=calloc(1,n*size+guard);assert(base&&allocated<32);allocations[allocated++]=base;
    void *p=base;
    if(alignment){
        assert(alignment==cp_v3_stats_memory_alignment()||alignment==cp_v3_temporal_memory_alignment());
        assert(!(alignment&(alignment-1)));++aligned_allocations;
        p=(void *)(((uintptr_t)base+alignment-1)/alignment*alignment);
        if(aligned_allocations==misalign_aligned_allocation)p=(uint8_t *)p+alignment/2;
    }else if(unaligned_normal_allocations&&(caps&MALLOC_CAP_SPIRAM)&&
        (n*size==arena_sizes[0]||n*size==arena_sizes[1])){
        /* Opaque init checks reject this before dereferencing. Other host
         * structures retain their ABI alignment; only arena calloc is weak. */
        p=(uint8_t *)base+_Alignof(max_align_t)/2;
        assert((uintptr_t)p%_Alignof(max_align_t));
    }
    if(caps&MALLOC_CAP_SPIRAM) psram_used+=n*size; else internal_used+=n*size;
    return p;
}
void *heap_caps_calloc(size_t n,size_t size,uint32_t caps) {return test_allocate(0,n,size,caps);}
void *heap_caps_aligned_calloc(size_t alignment,size_t n,size_t size,uint32_t caps) {return test_allocate(alignment,n,size,caps);}
size_t heap_caps_get_free_size(uint32_t caps) { return caps&MALLOC_CAP_SPIRAM?8*1024*1024-psram_used:400000-internal_used; }
size_t heap_caps_get_largest_free_block(uint32_t caps) { return heap_caps_get_free_size(caps); }
QueueHandle_t xQueueCreateStatic(unsigned count,unsigned size,uint8_t *bytes,StaticQueue_t *q) {
    *q=(StaticQueue_t){.data=bytes,.capacity=count,.size=size}; return q;
}
int xQueueReceive(QueueHandle_t q,void *out,TickType_t wait) {
    assert(!wait); if(!q->count) return pdFALSE; memcpy(out,q->data+q->head*q->size,q->size);
    q->head=(q->head+1)%q->capacity; q->count--; return pdTRUE;
}
int xQueueSend(QueueHandle_t q,const void *value,TickType_t wait) {
    assert(!wait); if(q->count==q->capacity) return pdFALSE;
    memcpy(q->data+(q->head+q->count)%q->capacity*q->size,value,q->size); q->count++; return pdTRUE;
}
unsigned uxQueueMessagesWaiting(QueueHandle_t q) { return q->count; }
SemaphoreHandle_t xSemaphoreCreateMutexStatic(StaticSemaphore_t *s) { s->held=0; return s; }
int xSemaphoreTake(SemaphoreHandle_t s,TickType_t wait) { (void)wait; assert(!s->held); s->held=1; return pdTRUE; }
int xSemaphoreGive(SemaphoreHandle_t s) { assert(s->held); s->held=0; return pdTRUE; }
int xTaskCreate(void (*task)(void *),const char *name,unsigned stack,void *arg,unsigned priority,TaskHandle_t *out) {
    (void)task;(void)name;(void)arg;(void)priority;internal_used+=stack;*out=(void *)1;return pdPASS;
}
void vTaskDelay(TickType_t ticks) { assert(!lock_depth); clock_us+=(uint64_t)ticks*1000; }
unsigned uxTaskGetStackHighWaterMark(TaskHandle_t task) { (void)task;return 6000; }
esp_err_t nimble_port_init(void) { ble_init_count++;internal_used+=20000;return ESP_OK; }
void nimble_port_run(void) { assert(false); }
void nimble_port_freertos_init(void (*task)(void *)) { (void)task;internal_used+=6144;assert(ble_hs_cfg.sync_cb);ble_hs_cfg.sync_cb(); }
int ble_gap_ext_disc(uint8_t address,uint16_t duration,uint16_t period,uint8_t filter,uint8_t limited,uint8_t duplicates,
    const struct ble_gap_ext_disc_params *one,const struct ble_gap_ext_disc_params *coded,int (*callback)(struct ble_gap_event *,void *),void *ctx) {
    (void)address;assert(!duration&&!period&&!filter&&!limited&&!duplicates&&one&&one->passive&&!coded);
    gap_callback=callback;gap_context=ctx;starts++;scan_active=true;clock_us+=scan_start_delay_us;return 0;
}
int ble_gap_disc_cancel(void) { cancels++;scan_active=false;struct ble_gap_event event={.type=BLE_GAP_EVENT_DISC_COMPLETE};return gap_callback(&event,gap_context); }
int ble_gap_disc_active(void) { return scan_active; }
static bool wall(void *ctx,uint64_t mono,cp_v3_temporal_time_t *out) {
    (void)ctx;*out=(cp_v3_temporal_time_t){.mono_ms=mono,.utc_ms=1898553600000ULL+mono,.clock_epoch=1,.utc_known=true};return true;
}
static bool entropy(void *ctx,uint8_t out[16]) { (void)ctx;memset(out,0,16);out[15]=(uint8_t)++entropy_counter;return true; }
static unsigned raw_calls; static bool raw_ok=true;
static bool raw(void *ctx,const cp_v3_stats_report_t *r) {
    (void)ctx;assert(!lock_depth&&r->seq&&r->length<=1650);raw_calls++;
    if(r->kind) assert(r->props==0x20&&r->data_status==1&&r->sid==7&&r->primary_phy==3&&r->secondary_phy==2&&r->periodic_interval==99);
    return raw_ok;
}
static void clear(void) {
    for(unsigned i=0;i<allocated;i++) free(allocations[i]); allocated=0;
    instance=NULL;attempted=false;memset(&preparation,0,sizeof preparation);memset(&ble_hs_cfg,0,sizeof ble_hs_cfg);
    clock_us=1000000;lock_depth=allocation_count=fail_allocation=ble_init_count=starts=cancels=entropy_counter=0;
    internal_used=psram_used=raw_calls=0;raw_ok=true;inject_timer_after=jump_timer_after=0;jump_us=0;pause_after_deferred=false;
    deferred_report=false;gap_callback=NULL;scan_active=false;scan_start_delay_us=0;
    unaligned_normal_allocations=false;aligned_allocations=misalign_aligned_allocation=0;
    arena_sizes[0]=arena_sizes[1]=0;
}
static cp_v3_capture_config_t configuration(bool events) {
    cp_v3_capture_config_t c={.statistics={.capacity=512,.window_ms=1000,.bin_ms=1000,.rules_version=CP_V3_STATS_RULESET},
        .temporal_enabled=true,.report_events=events,.context={1,1,1},.report_slots=2,.window_slots=4,.event_slots=1,
        .clock=wall,.entropy=entropy,.raw=raw};
    c.temporal=cp_v3_temporal_default_config();c.temporal.max_tracks=16;c.temporal.max_open_events=4;
    c.temporal.max_terminal_events=2;c.temporal.slice_ms=1000;c.temporal.gap_ms=2000;c.temporal.max_event_ms=600000;
    return c;
}
static cp_v3_scope_t scope(void) {
    cp_v3_scope_t s={.assignment_generation=1};strcpy(s.node_id,"synthetic-node");strcpy(s.boot_id,"00000000-0000-4000-8000-000000000001");
    strcpy(s.placement_id,"synthetic-place");strcpy(s.policy_id,"synthetic-policy");memset(s.policy_sha256,'a',64);strcpy(s.dataset,"controlled_test");return s;
}
static cp_v3_capture_t *prepare(bool events) {
    cp_v3_capture_t *s;cp_v3_capture_config_t c=configuration(events);
    assert(cp_v3_capture_prepare(&c,&s)==ESP_OK&&s->status.prepared&&!s->status.running&&!starts&&ble_init_count==1);
    cp_v3_scope_t policy=scope();assert(cp_v3_capture_start(s,&policy,1,160,160,30000)==ESP_OK);return s;
}
static void report_at(uint64_t at,uint8_t address,bool extended) {
    clock_us=at;static const uint8_t payload[]={2,1,6};
    struct ble_gap_event event={.type=extended?BLE_GAP_EVENT_EXT_DISC:BLE_GAP_EVENT_DISC};
    event.disc=(struct ble_gap_disc_desc){.data=payload,.length_data=sizeof payload,.rssi=-60};event.disc.addr.val[0]=address;
    event.ext_disc=(struct ble_gap_ext_disc_desc){.data=payload,.length_data=sizeof payload,.rssi=-61,.props=0x20,.data_status=1,
        .sid=7,.prim_phy=3,.sec_phy=2,.periodic_adv_itvl=99};event.ext_disc.addr.val[0]=address;
    assert(gap_callback&&gap_callback(&event,gap_context)==0);
}
static void advance(cp_v3_capture_t *s,uint64_t at) { clock_us=at;step(s); }
static void release_windows(cp_v3_capture_t *s) { cp_v3_capture_window_t w;while(cp_v3_capture_window(s,&w,0)) assert(cp_v3_capture_window_release(s,w.window_seq,w.scope.assignment_generation)); }
static void tests(void) {
    clear();cp_v3_capture_t *s=prepare(false);
    report_at(1100000,1,false);step(s);report_at(1900000,1,true);raw_ok=false;step(s);advance(s,2100000);
    cp_v3_capture_window_t w,again;assert(cp_v3_capture_window(s,&w,0)&&w.window_seq==1&&w.statistics.worker_reports==2&&w.statistics.unique_keys==1);
    assert(w.statistics.received_reports==2&&!w.statistics.callback_drops&&w.statistics.scan_coverage_ms==1000);
    assert(cp_v3_capture_window(s,&again,0)&&!memcmp(&w,&again,sizeof w));assert(!cp_v3_capture_window_release(s,1,2));
    assert(s->status.raw_reports==2&&s->status.raw_accepted==1&&s->status.raw_drops==1&&raw_calls==2&&starts==1);
    assert(cp_v3_capture_window_release(s,1,1));
    /* Event report-off consumes terminals without clearing local history. */
    advance(s,4500000);release_windows(s);step(s);assert(s->status.events_consumed_local>=1&&!s->status.temporal.blocked);
    uint16_t history=cp_v3_temporal_history_count(s->temporal);assert(history>=3&&!cp_v3_capture_event(s,&(cp_v3_capture_event_t){0},0));
    assert(cp_v3_capture_pause(s,CP_V3_TEMPORAL_LEASE_EXPIRED,100)==ESP_OK);
    assert(cp_v3_temporal_history_count(s->temporal)>=history&&!s->status.running&&cancels);
    cp_v3_scope_t changed=scope();changed.assignment_generation=2;
    assert(cp_v3_capture_start(s,&changed,10,160,160,30000)==ESP_ERR_INVALID_STATE);
    changed=scope();strcpy(changed.placement_id,"other-place");
    assert(cp_v3_capture_start(s,&changed,10,160,160,30000)==ESP_ERR_INVALID_STATE);
    changed=scope();assert(cp_v3_capture_start(s,&changed,1,160,160,30000)==ESP_ERR_INVALID_STATE);
    assert(s->temporal_context.config_generation==1&&s->temporal_context.placement_generation==1);
    clear();s=prepare(false);s->config.window_slots=1;
    report_at(1100000,1,false);report_at(1200000,2,false);report_at(1300000,3,false);step(s);
    assert(s->status.callback_reports==3&&s->status.callback_drops==1&&!s->accept);
    assert(cp_v3_capture_window(s,&w,0)&&w.statistics.callback_drops==1&&w.statistics.received_reports==3&&w.statistics.worker_reports==2&&
        (w.statistics.quality_mask&1)&&(w.statistics.quality_mask&16));
    release_windows(s);step(s);assert(starts>=2&&s->accept); /* Resume only with live authority. */
    assert(cp_v3_capture_deadline(s,clock_us/1000+1000)==ESP_ERR_INVALID_STATE); /* Cannot shorten frozen authority. */
    s->deadline_ms=clock_us/1000+10;advance(s,clock_us+20000);assert(!s->accept&&!s->want_running&&s->status.authority_pauses);
    assert(cp_v3_capture_deadline(s,50000)==ESP_ERR_INVALID_STATE);
    clear();s=prepare(false);inject_timer_after=2;advance(s,1100000);step(s);
    assert(s->status.callback_reports==1&&s->status.temporal.late_reports==0&&s->status.temporal.invalid_reports==0);
    assert(s->status.raw_reports==1); /* Callback injected after idle barrier timestamp. */
    /* Expiry crosses between the early step check and the idle barrier. No
     * known coverage may advance beyond authority, and hardware must stop in
     * this same step rather than clearing pause with scanning still active. */
    clear();s=prepare(true);report_at(1100000,1,false);step(s);
    s->deadline_ms=1110;jump_timer_after=2;jump_us=20000;step(s);
    assert(!s->accept&&!s->scanning&&!scan_active&&!s->want_running&&!s->status.failed);
    assert(s->last_temporal.mono_ms==1110&&s->status.temporal.open_events==0);
    cp_v3_capture_event_t expired;assert(cp_v3_capture_event(s,&expired,0));
    assert(expired.event.state==CP_V3_TEMPORAL_CENSORED&&expired.event.reason==CP_V3_TEMPORAL_LEASE_EXPIRED&&
        expired.event.end.mono_ms==1110&&expired.event.observed_until.mono_ms<=1110);
    release_windows(s);assert(cp_v3_capture_event_release(s,expired.event.event_id,expired.event.revision));step(s);
    assert(s->status.quiescent&&!s->status.temporal.open_events);
    /* A report then a manual pause after the idle barrier must be drained on
     * the next step before closing the later stop timestamp. */
    clear();s=prepare(false);inject_timer_after=2;pause_after_deferred=true;advance(s,1100000);
    assert(s->pause_requested&&uxQueueMessagesWaiting(s->ready)==1&&s->have_window);
    step(s);assert(!s->status.failed&&!s->accept&&!s->scanning&&s->status.raw_reports==1);
    assert(cp_v3_capture_window(s,&w,0)&&w.statistics.worker_reports==1&&w.statistics.received_reports==1);
    /* Fault injection: a stale stop behind an already processed temporal
     * watermark must fence episodes and fail, never silently leave them open. */
    clear();s=prepare(true);report_at(1100000,1,false);step(s);advance(s,1500000);
    portENTER_CRITICAL(&s->source);request_pause_locked(s,CP_V3_TEMPORAL_LEASE_EXPIRED,1200000,true);portEXIT_CRITICAL(&s->source);
    step(s);assert(s->status.failed&&!strcmp(s->status.failure_stage,"temporal_pause")&&!s->status.temporal.open_events);
    clear();s=prepare(false);s->config.window_slots=1;
    advance(s,2100000);assert(cp_v3_capture_window(s,&w,0)&&w.window_seq==1);
    advance(s,3100000);assert(s->pending_window_valid&&s->status.window_backpressure==1);
    step(s);assert(!s->accept&&!s->status.running&&cp_v3_capture_window(s,&again,0)&&!memcmp(&w,&again,sizeof w));
    s->deadline_ms=3500;advance(s,4000000);assert(!s->want_running);
    assert(cp_v3_capture_window_release(s,1,1));step(s);
    assert(cp_v3_capture_window(s,&w,0)&&w.window_seq==2);assert(cp_v3_capture_window_release(s,2,1));step(s);
    assert(cp_v3_capture_window(s,&w,0)&&w.window_seq==3&&w.statistics.duration_ms==100&&w.statistics.scan_coverage_ms==100&&
        (w.statistics.quality_mask&1));assert(cp_v3_capture_window_release(s,3,1));step(s);assert(starts==1&&!s->accept);
    /* Fractional pause rounds only the empty paused tail to integer milliseconds
     * and keeps bin count/duration consistent for compact serialization. */
    clear();s=prepare(false);report_at(1999999,1,false);step(s);
    assert(cp_v3_capture_pause(s,CP_V3_TEMPORAL_CAPACITY,100)==ESP_OK);
    assert(cp_v3_capture_window(s,&w,0)&&w.statistics.duration_ms==1000&&w.statistics.bin_count==1&&
        (w.statistics.quality_mask&1)&&w.statistics.worker_reports==1);
    clear();cp_v3_capture_config_t bounded=configuration(false);bounded.stop_after_windows=3;
    assert(cp_v3_capture_prepare(&bounded,&s)==ESP_OK);cp_v3_scope_t bounded_scope=scope();
    assert(cp_v3_capture_start(s,&bounded_scope,1,160,160,30000)==ESP_OK);
    /* Even a delayed collector closes all3fullwindows and never creates4th. */
    advance(s,4500000);step(s);assert(s->status.bounded_complete&&!s->want_running&&!s->accept);
    unsigned full=0;while(cp_v3_capture_window(s,&w,0)) { assert(w.statistics.window_closed&&!(w.statistics.quality_mask&1));full++;
        assert(cp_v3_capture_window_release(s,w.window_seq,1)); }
    assert(full==3&&!s->have_window&&!s->pending_window_valid&&s->status.windows_closed==3);
    advance(s,5000000);assert(s->status.windows_closed==3&&starts==1);
    assert(cp_v3_capture_pause(s,CP_V3_TEMPORAL_SCAN_GAP,100)==ESP_OK);
    step(s);assert(s->status.windows_closed==3&&!s->have_window&&!s->pending_window_valid);
    assert(!cp_v3_capture_window(s,&w,0)&&s->status.quiescent);
    /* Manual pause drains a partial window but cannot reset the bounded full
     * window allowance, reuse a sequence or discard the local history. */
    clear();bounded=configuration(false);bounded.stop_after_windows=3;
    assert(cp_v3_capture_prepare(&bounded,&s)==ESP_OK);bounded_scope=scope();
    assert(cp_v3_capture_start(s,&bounded_scope,1,160,160,30000)==ESP_OK);
    report_at(1100000,1,false);step(s);advance(s,2250000);
    assert(s->full_windows==1&&s->status.last_closed_window_seq==1);
    assert(cp_v3_capture_pause(s,CP_V3_TEMPORAL_CAPACITY,100)==ESP_OK);
    assert(!s->status.quiescent&&s->status.window_handoffs==2);
    assert(cp_v3_capture_start(s,&bounded_scope,3,160,160,30000)==ESP_ERR_INVALID_STATE);
    release_windows(s);step(s);history=cp_v3_temporal_history_count(s->temporal);
    assert(s->status.quiescent&&s->status.last_closed_window_seq==2&&s->full_windows==1);
    assert(cp_v3_capture_start(s,&bounded_scope,2,160,160,30000)==ESP_ERR_INVALID_STATE);
    assert(cp_v3_capture_start(s,&bounded_scope,3,160,160,30000)==ESP_OK);
    assert(cp_v3_temporal_history_count(s->temporal)>=history);
    advance(s,clock_us+2500000);step(s);full=0;
    while(cp_v3_capture_window(s,&w,0)) {
        assert(w.window_seq==3+full&&w.statistics.window_closed&&!(w.statistics.quality_mask&1));full++;
        assert(cp_v3_capture_window_release(s,w.window_seq,1));
    }
    step(s);assert(full==2&&s->full_windows==3&&s->status.bounded_complete&&s->status.quiescent);
    assert(s->status.last_closed_window_seq==4&&s->status.windows_closed==4);
    assert(cp_v3_capture_start(s,&bounded_scope,5,160,160,30000)==ESP_ERR_INVALID_STATE);
    clear();bounded=configuration(false);assert(cp_v3_capture_prepare(&bounded,&s)==ESP_OK);
    scan_start_delay_us=200000;bounded_scope=scope();
    assert(cp_v3_capture_start(s,&bounded_scope,1,160,160,1100)==ESP_ERR_INVALID_STATE);
    assert(!s->accept&&!s->have_window&&!scan_active&&cancels==1&&s->status.windows_closed==0);
    clear();s=prepare(true);s->config.temporal.max_terminal_events=1; /* Actual arena still2; force queue pressure with3 episodes. */
    report_at(1100000,1,false);step(s);advance(s,4000000);release_windows(s);
    cp_v3_capture_event_t e;assert(cp_v3_capture_event(s,&e,0));cp_v3_temporal_status_t before;cp_v3_temporal_status(s->temporal,&before);assert(before.terminal_events==1);
    assert(cp_v3_capture_event(s,&(cp_v3_capture_event_t){0},0));cp_v3_temporal_status(s->temporal,&s->status.temporal);assert(s->status.temporal.terminal_events==1);
    assert(cp_v3_capture_event_release(s,e.event.event_id,e.event.revision));assert(cp_v3_capture_event_release(s,e.event.event_id,e.event.revision));
    assert(cp_v3_capture_pause(s,CP_V3_TEMPORAL_CAPACITY,100)==ESP_OK);
    clear();s=prepare(true);
    report_at(1100000,1,false);step(s);advance(s,3500000);release_windows(s);
    report_at(3600000,2,false);step(s);advance(s,6000000);release_windows(s);
    report_at(6100000,3,false);step(s);advance(s,8500000);step(s);
    assert(s->status.event_backpressure&&s->status.temporal.blocked&&!s->accept);
    assert(cp_v3_capture_event(s,&e,0));uint8_t original[16];memcpy(original,e.event.event_id,16);
    assert(cp_v3_capture_event_release(s,e.event.event_id,e.event.revision));
    assert(cp_v3_capture_event(s,&e,0)&&memcmp(original,e.event.event_id,16));
    clear();cp_v3_capture_config_t c=configuration(false);fail_allocation=3;assert(cp_v3_capture_prepare(&c,&s)==ESP_ERR_NO_MEM);
    cp_v3_capture_status_t status;cp_v3_capture_prepare_status(&status);assert(status.failed&&!strcmp(status.failure_stage,"reports_alloc")&&!ble_init_count);
    /* Ordinary heap alignment must not accidentally validate arena allocation
     * only on a desktop allocator. Both arena-specific aligned calls are used. */
    clear();unaligned_normal_allocations=true;c=configuration(false);
    arena_sizes[0]=cp_v3_stats_memory_bytes(c.statistics.capacity);arena_sizes[1]=cp_v3_temporal_memory_bytes(&c.temporal);s=prepare(false);
    assert(aligned_allocations==2&&s->status.statistics_alignment==cp_v3_stats_memory_alignment()&&
        !s->status.statistics_alignment_remainder&&s->status.temporal_alignment==cp_v3_temporal_memory_alignment()&&!s->status.temporal_alignment_remainder);
    report_at(1100000,1,false);step(s);assert(!s->status.failed&&s->status.temporal.tracks==1);
    clear();misalign_aligned_allocation=2;c=configuration(false);
    assert(cp_v3_capture_prepare(&c,&s)==ESP_ERR_INVALID_STATE);
    cp_v3_capture_prepare_status(&status);assert(status.failed&&!strcmp(status.failure_stage,"temporal_alignment")&&
        status.temporal_alignment_remainder&&status.temporal_alignment_remainder<status.temporal_alignment&&!ble_init_count);
    clear();c=configuration(false);c.min_internal_free=390000;assert(cp_v3_capture_prepare(&c,&s)==ESP_ERR_NO_MEM);
    cp_v3_capture_prepare_status(&status);assert(status.failed&&!strcmp(status.failure_stage,"ble_after")&&ble_init_count==1);
    clear();puts("capture deterministic orchestration, exact source/drop ledger, ordering barrier, raw hook, history, authority and memory gates passed");
}
int main(void) { tests();return 0; }
