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
static uint32_t clock_epoch=1;
static uint64_t api_wait_elapsed_us;
static bool reset_before_rebind_commit;
static unsigned rebind_handoff_takes;
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
int xSemaphoreTake(SemaphoreHandle_t s,TickType_t wait) {
    (void)wait;assert(!s->held);s->held=1;
    if(instance&&s==instance->api){clock_us+=api_wait_elapsed_us;api_wait_elapsed_us=0;}
    if(instance&&s==instance->handoff&&instance->rebind_requested&&reset_before_rebind_commit&&++rebind_handoff_takes==2){
        reset_before_rebind_commit=false;reset(1);
    }
    return pdTRUE;
}
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
    (void)ctx;*out=(cp_v3_temporal_time_t){.mono_ms=mono,.utc_ms=1898553600000ULL+mono,.clock_epoch=clock_epoch,.utc_known=true};return true;
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
    clock_epoch=1;api_wait_elapsed_us=0;
    reset_before_rebind_commit=false;rebind_handoff_takes=0;
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
static cp_v3_scope_t next_scope(void) {
    cp_v3_scope_t next=scope();next.assignment_generation=2;strcpy(next.policy_id,"new-policy");
    memset(next.policy_sha256,'b',64);strcpy(next.placement_id,"new-place");strcpy(next.dataset,"field");return next;
}
static void rebind_tests(void) {
    clear();cp_v3_capture_t *s=prepare(true);
    cp_v3_scope_t old=scope(),next=next_scope();cp_v3_temporal_context_t context={1,2,2};
    assert(cp_v3_capture_rebind(s,&next,&context,100)==ESP_ERR_INVALID_STATE); /* Still scanning. */
    report_at(1100000,1,false);report_at(1200000,2,false);report_at(1300000,3,false);step(s);
    assert(s->status.callback_drops==1);
    assert(cp_v3_capture_pause(s,CP_V3_TEMPORAL_PLACEMENT_CHANGE,100)==ESP_OK);
    cp_v3_capture_window_t old_window,again_window;
    assert(cp_v3_capture_window(s,&old_window,0)&&old_window.scope.assignment_generation==1);
    assert(cp_v3_capture_rebind(s,&next,&context,100)==ESP_ERR_INVALID_STATE);
    assert(cp_v3_capture_window(s,&again_window,0)&&!memcmp(&old_window,&again_window,sizeof old_window));
    release_windows(s);step(s);
    cp_v3_capture_event_t old_event,again_event;uint32_t last_event_seq=0;uint8_t last_id[16];
    while(cp_v3_capture_event(s,&old_event,0)) {
        assert(old_event.scope.assignment_generation==1&&old_event.event.context.config_generation==1);
        assert(cp_v3_capture_rebind(s,&next,&context,100)==ESP_ERR_INVALID_STATE);
        assert(cp_v3_capture_event(s,&again_event,0)&&!memcmp(&old_event,&again_event,sizeof old_event));
        last_event_seq=old_event.event.event_seq;memcpy(last_id,old_event.event.event_id,sizeof last_id);
        assert(cp_v3_capture_event_release(s,old_event.event.event_id,old_event.event.revision));
    }
    step(s);assert(last_event_seq&&s->status.quiescent);
    cp_v3_capture_status_t before=s->status;uint32_t next_window=s->next_window_seq,full_windows=s->full_windows;
    unsigned old_allocations=allocation_count,old_starts=starts,old_entropy=entropy_counter;
    StaticQueue_t free_before=*s->free,ready_before=*s->ready;uint16_t window_head=s->window_head;
    assert(cp_v3_capture_rebind(s,&next,&context,100)==ESP_OK);
    assert(starts==old_starts&&!scan_active&&ble_init_count==1&&allocation_count==old_allocations&&entropy_counter==old_entropy);
    assert(s->status.quiescent&&s->status.paused&&!s->accept&&!s->want_running&&!s->have_window);
    assert(s->next_window_seq==next_window&&s->full_windows==full_windows&&s->window_head==window_head);
    assert(!memcmp(&free_before,s->free,sizeof free_before)&&!memcmp(&ready_before,s->ready,sizeof ready_before));
    assert(s->status.callback_reports==before.callback_reports&&s->status.callback_drops==before.callback_drops&&
        s->status.windows_closed==before.windows_closed&&s->status.raw_reports==before.raw_reports&&
        s->status.raw_drops==before.raw_drops&&s->status.temporal.reports==before.temporal.reports);
    assert(s->temporal_context.config_generation==2&&s->temporal_context.placement_generation==2&&
        s->config.context.config_generation==2&&s->status.temporal.tracks==0&&s->status.temporal.history_slices==1);
    assert(cp_v3_capture_start(s,&old,next_window,160,160,30000)==ESP_ERR_INVALID_STATE);
    assert(cp_v3_capture_start(s,&next,next_window-1,160,160,30000)==ESP_ERR_INVALID_STATE);
    assert(cp_v3_capture_start(s,&next,next_window,160,160,30000)==ESP_OK&&starts==old_starts+1);
    report_at(clock_us+100000,4,false);step(s);
    assert(cp_v3_capture_pause(s,CP_V3_TEMPORAL_CONFIG_CHANGE,100)==ESP_OK);
    assert(cp_v3_capture_window(s,&again_window,0)&&again_window.window_seq==next_window&&
        again_window.scope.assignment_generation==2&&!strcmp(again_window.scope.dataset,"field")&&
        again_window.statistics.worker_reports==1&&again_window.statistics.unique_keys==1);
    assert(cp_v3_capture_event(s,&again_event,0)&&again_event.event.event_seq>last_event_seq&&
        memcmp(last_id,again_event.event.event_id,sizeof last_id)&&again_event.scope.assignment_generation==2&&
        again_event.event.context.config_generation==2&&again_event.event.context.placement_generation==2);
    release_windows(s);assert(cp_v3_capture_event_release(s,again_event.event.event_id,again_event.event.revision));step(s);
    /* Policy-only changes preserve the placement generation; dataset changes
     * require a real new placement context even if the place identifier stays. */
    cp_v3_scope_t third=next;third.assignment_generation=3;strcpy(third.policy_id,"third-policy");
    context=(cp_v3_temporal_context_t){1,3,2};clock_epoch=2;old_starts=starts;
    assert(cp_v3_capture_rebind(s,&third,&context,100)==ESP_OK&&s->last_temporal.clock_epoch==2&&starts==old_starts);
    cp_v3_scope_t fourth=third;fourth.assignment_generation=4;strcpy(fourth.dataset,"demo");
    context=(cp_v3_temporal_context_t){1,4,2};assert(cp_v3_capture_rebind(s,&fourth,&context,100)==ESP_ERR_INVALID_STATE);
    context.placement_generation=3;assert(cp_v3_capture_rebind(s,&fourth,&context,100)==ESP_OK);

    clear();s=prepare(false);report_at(1100000,1,false);step(s);
    assert(cp_v3_capture_pause(s,CP_V3_TEMPORAL_SCAN_GAP,100)==ESP_OK);release_windows(s);step(s);
    next=next_scope();context=(cp_v3_temporal_context_t){1,2,2};
    cp_v3_scope_t bad=next;strcpy(bad.node_id,"other-node");assert(cp_v3_capture_rebind(s,&bad,&context,100)==ESP_ERR_INVALID_STATE);
    bad=next;bad.boot_id[35]='2';assert(cp_v3_capture_rebind(s,&bad,&context,100)==ESP_ERR_INVALID_STATE);
    bad=next;bad.assignment_generation=1;assert(cp_v3_capture_rebind(s,&bad,&context,100)==ESP_ERR_INVALID_STATE);
    context.boot_generation=2;assert(cp_v3_capture_rebind(s,&next,&context,100)==ESP_ERR_INVALID_STATE);context.boot_generation=1;
    context.config_generation=3;assert(cp_v3_capture_rebind(s,&next,&context,100)==ESP_ERR_INVALID_STATE);context.config_generation=2;
    context.placement_generation=1;assert(cp_v3_capture_rebind(s,&next,&context,100)==ESP_ERR_INVALID_STATE);context.placement_generation=2;
    assert(cp_v3_capture_rebind(s,&next,&context,0)==ESP_ERR_INVALID_ARG);
    assert(cp_v3_capture_rebind(s,&next,NULL,100)==ESP_ERR_INVALID_ARG);
    /* Direct state checks reject stale quiescent snapshots. No faulty test
     * state is stepped: each is restored before trying the next condition. */
    bool *busy[]={&s->accept,&s->scanning,&s->want_running,&s->have_window,&s->pending_window_valid,
        &s->held_valid,&s->start_requested,&s->rebind_requested,&s->pause_requested,&s->scan_transition,
        &s->event_ready,&s->event_release_requested,&s->status.bounded_complete};
    for(unsigned i=0;i<sizeof busy/sizeof *busy;i++){assert(!*busy[i]);*busy[i]=true;
        assert(cp_v3_capture_rebind(s,&next,&context,100)==ESP_ERR_INVALID_STATE);*busy[i]=false;}
    s->callbacks=1;assert(cp_v3_capture_rebind(s,&next,&context,100)==ESP_ERR_INVALID_STATE);s->callbacks=0;
    s->window_count=1;assert(cp_v3_capture_rebind(s,&next,&context,100)==ESP_ERR_INVALID_STATE);s->window_count=0;
    s->command=UINT32_MAX;assert(cp_v3_capture_rebind(s,&next,&context,100)==ESP_ERR_INVALID_STATE);s->command=s->completed_command;
    uint16_t index;assert(xQueueReceive(s->free,&index,0)==pdTRUE&&xQueueSend(s->ready,&index,0)==pdTRUE);
    assert(cp_v3_capture_rebind(s,&next,&context,100)==ESP_ERR_INVALID_STATE);
    assert(xQueueReceive(s->ready,&index,0)==pdTRUE&&xQueueSend(s->free,&index,0)==pdTRUE);
    scan_active=true;assert(cp_v3_capture_rebind(s,&next,&context,100)==ESP_ERR_INVALID_STATE);scan_active=false;step(s);
    assert(s->scope.assignment_generation==1&&starts==1);
    assert(cp_v3_capture_rebind(s,&next,&context,100)==ESP_OK);
    assert(cp_v3_capture_rebind(s,&next,&context,100)==ESP_ERR_INVALID_STATE); /* No generation regression/reuse. */

    /* Inject an old episode after the published quiescent snapshot. The worker
     * fences it under OLD scope/context, rejects this rebind, and waits for its
     * exact terminal release. Clock change must not relabel that old terminal. */
    clear();s=prepare(true);assert(cp_v3_capture_pause(s,CP_V3_TEMPORAL_SCAN_GAP,100)==ESP_OK);release_windows(s);step(s);
    assert(s->status.quiescent);cp_v3_temporal_time_t at=mapped(s,clock_us);uint8_t address[6]={9};
    assert(cp_v3_temporal_set_coverage(s->temporal,at,true)==CP_V3_TEMPORAL_OK);
    assert(cp_v3_temporal_report(s->temporal,at,0,address,true,-60,NULL)==CP_V3_TEMPORAL_OK);
    next=next_scope();context=(cp_v3_temporal_context_t){1,2,2};clock_epoch=2;
    assert(cp_v3_capture_rebind(s,&next,&context,100)==ESP_ERR_INVALID_STATE);
    assert(s->scope.assignment_generation==1&&s->temporal_context.config_generation==1&&starts==1);
    assert(cp_v3_capture_event(s,&old_event,0)&&old_event.scope.assignment_generation==1&&
        old_event.event.context.config_generation==1&&old_event.event.reason==CP_V3_TEMPORAL_CLOCK_CHANGE);
    assert(cp_v3_capture_event_release(s,old_event.event.event_id,old_event.event.revision));step(s);
    assert(cp_v3_capture_rebind(s,&next,&context,100)==ESP_OK&&starts==1&&s->last_temporal.clock_epoch==2);
    assert(cp_v3_capture_start(s,&next,s->next_window_seq,160,160,30000)==ESP_OK);
    report_at(clock_us+100000,10,false);step(s);assert(cp_v3_capture_pause(s,CP_V3_TEMPORAL_CONFIG_CHANGE,100)==ESP_OK);
    assert(cp_v3_capture_event(s,&again_event,0)&&again_event.event.event_seq>old_event.event.event_seq&&
        memcmp(again_event.event.event_id,old_event.event.event_id,16)&&again_event.event.context.config_generation==2);

    /* A host reset after the temporal boundary but before scope commit leaves
     * both the public scope and the engine context old. No teardown/reinit. */
    clear();s=prepare(true);assert(cp_v3_capture_pause(s,CP_V3_TEMPORAL_SCAN_GAP,100)==ESP_OK);release_windows(s);step(s);
    next=next_scope();context=(cp_v3_temporal_context_t){1,2,2};reset_before_rebind_commit=true;
    assert(cp_v3_capture_rebind(s,&next,&context,100)==ESP_ERR_INVALID_STATE);
    assert(!s->synchronized&&s->scope.assignment_generation==1&&s->temporal_context.config_generation==1&&
        s->status.ble_resets==1&&starts==1&&ble_init_count==1);
    synchronized();old=scope();assert(cp_v3_capture_start(s,&old,s->next_window_seq,160,160,30000)==ESP_OK);
    report_at(clock_us+100000,8,false);step(s);assert(cp_v3_capture_pause(s,CP_V3_TEMPORAL_CONFIG_CHANGE,100)==ESP_OK);
    assert(cp_v3_capture_event(s,&old_event,0)&&old_event.scope.assignment_generation==1&&old_event.event.context.config_generation==1);

    /* Expiring the wait before the worker runs cannot grant capture. The queued
     * command fences ordinary start until it is processed, and stays paused. */
    clear();s=prepare(false);assert(cp_v3_capture_pause(s,CP_V3_TEMPORAL_SCAN_GAP,100)==ESP_OK);release_windows(s);step(s);
    next=next_scope();context=(cp_v3_temporal_context_t){1,2,2};api_wait_elapsed_us=200000;
    uint32_t saved_command=s->command;
    assert(cp_v3_capture_rebind(s,&next,&context,100)==ESP_ERR_TIMEOUT&&s->rebind_requested&&s->scope.assignment_generation==1);
    assert(cp_v3_capture_start(s,&old,s->next_window_seq,160,160,30000)==ESP_ERR_INVALID_STATE);
    step(s);assert(s->completed_command==saved_command+1&&s->command_result==ESP_OK&&!scan_active&&starts==1);

    /* A temporal-disabled capture uses the same command without creating an
     * arena. Rebind also cannot replenish a finite trial's consumed allowance. */
    clear();cp_v3_capture_config_t config=configuration(false);config.temporal_enabled=false;config.stop_after_windows=2;
    assert(cp_v3_capture_prepare(&config,&s)==ESP_OK);old=scope();assert(cp_v3_capture_start(s,&old,1,160,160,30000)==ESP_OK);
    advance(s,2100000);assert(cp_v3_capture_pause(s,CP_V3_TEMPORAL_SCAN_GAP,100)==ESP_OK);release_windows(s);step(s);
    assert(s->full_windows==1);next=next_scope();context=(cp_v3_temporal_context_t){1,2,2};
    assert(cp_v3_capture_rebind(s,&next,&context,100)==ESP_OK&&s->full_windows==1&&!s->temporal);
    assert(cp_v3_capture_start(s,&next,s->next_window_seq,160,160,30000)==ESP_OK);advance(s,clock_us+1100000);release_windows(s);step(s);
    assert(s->full_windows==2&&s->status.bounded_complete);third=next;third.assignment_generation=3;context.config_generation=3;
    assert(cp_v3_capture_rebind(s,&third,&context,100)==ESP_ERR_INVALID_STATE);
    clear();
}
static void late_bounded_pause_test(void) {
    clear();cp_v3_capture_config_t config=configuration(false);config.stop_after_windows=20;
    cp_v3_capture_t *s;assert(cp_v3_capture_prepare(&config,&s)==ESP_OK);cp_v3_scope_t policy=scope();
    assert(cp_v3_capture_start(s,&policy,1,160,160,60000)==ESP_OK);
    uint64_t epoch=s->epoch_us;
    for(uint32_t sequence=1;sequence<=20;sequence++) {
        advance(s,epoch+(uint64_t)sequence*1000000);
        cp_v3_capture_window_t w;assert(cp_v3_capture_window(s,&w,0)&&w.window_seq==sequence&&w.statistics.window_closed);
        assert(cp_v3_capture_window_release(s,sequence,1));
    }
    /* Network owner notices completion five seconds late, while the worker's
     * bounded pause is still pending. It must fence at window 20, not now. */
    clock_us=epoch+25000000;assert(cp_v3_capture_pause(s,CP_V3_TEMPORAL_SCAN_GAP,100)==ESP_OK);step(s);
    assert(s->status.bounded_complete&&s->status.quiescent&&!s->pause_requested&&!s->have_window&&!s->pending_window_valid);
    assert(s->status.windows_closed==20&&s->status.last_closed_window_seq==20&&s->next_window_seq==21&&s->full_windows==20);
    assert(starts==1&&!scan_active&&!s->accept&&!s->want_running&&!s->status.failed);
    assert(!cp_v3_capture_window(s,&(cp_v3_capture_window_t){0},0)&&!s->status.window_handoffs);
    clock_us+=5000000;assert(cp_v3_capture_pause(s,CP_V3_TEMPORAL_SCAN_GAP,100)==ESP_OK);step(s);
    assert(s->status.quiescent&&s->status.windows_closed==20&&!s->have_window&&!s->status.failed);
    clear();
}
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
int main(void) {
    tests();rebind_tests();late_bounded_pause_test();
    puts("capture scope rebind boundaries, identity, sequence, worker and resource preservation passed");
    puts("20-window completion followed by late repeated pause stays quiescent without window 21");return 0;
}
