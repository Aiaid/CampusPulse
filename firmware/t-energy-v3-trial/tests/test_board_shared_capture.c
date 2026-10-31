#include "board_shared_capture.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

/* Link-time doubles exercise adapter fences, not receipt parsing, NimBLE,
 * PSRAM placement, durability or device acceptance. */
struct cp_v3_capture { int unused; };
static struct cp_v3_capture collector;
static unsigned prepares,starts,pauses,extensions,window_peeks,event_peeks,window_releases,event_releases,permissions;
static bool allowed=true,release_ok=true;
static esp_err_t start_error=ESP_OK,prepare_error=ESP_OK,deadline_error=ESP_OK;
static cp_v3_capture_config_t seen_config;
static cp_v3_scope_t seen_scope;
static uint64_t seen_deadline;
static cp_v3_temporal_reason_t seen_reason;
static cp_v3_capture_window_t source_window;
static cp_v3_capture_event_t source_event;
static bool clock_map(void *ctx,uint64_t mono,cp_v3_temporal_time_t *out) {
    (void)ctx;*out=(cp_v3_temporal_time_t){.mono_ms=mono};return true;
}
static bool entropy(void *ctx,uint8_t out[16]) { (void)ctx;memset(out,1,16);return true; }
static bool forbidden_raw(void *ctx,const cp_v3_stats_report_t *r) { (void)ctx;(void)r;return true; }
esp_err_t cp_v3_capture_prepare(const cp_v3_capture_config_t *c,cp_v3_capture_t **out) {
    ++prepares;seen_config=*c;*out=prepare_error==ESP_OK?&collector:NULL;return prepare_error;
}
esp_err_t cp_v3_capture_start(cp_v3_capture_t *s,const cp_v3_scope_t *scope,uint32_t next,
    uint32_t interval,uint32_t window,uint64_t deadline) {
    assert(s==&collector && next==7 && interval==160 && window==80);
    ++starts;seen_scope=*scope;seen_deadline=deadline;return start_error;
}
esp_err_t cp_v3_capture_deadline(cp_v3_capture_t *s,uint64_t deadline) {
    assert(s==&collector);++extensions;seen_deadline=deadline;return deadline_error;
}
esp_err_t cp_v3_capture_pause(cp_v3_capture_t *s,cp_v3_temporal_reason_t why,uint32_t timeout) {
    assert(s==&collector && timeout==0);++pauses;seen_reason=why;return ESP_OK;
}
bool cp_v3_capture_window(cp_v3_capture_t *s,cp_v3_capture_window_t *out,uint32_t timeout) {
    assert(s==&collector && !timeout);++window_peeks;memcpy(out,&source_window,sizeof *out);return true;
}
bool cp_v3_capture_window_release(cp_v3_capture_t *s,uint32_t seq,uint64_t generation) {
    assert(s==&collector && seq==source_window.window_seq && generation==source_window.scope.assignment_generation);
    ++window_releases;return release_ok;
}
bool cp_v3_capture_event(cp_v3_capture_t *s,cp_v3_capture_event_t *out,uint32_t timeout) {
    assert(s==&collector && !timeout);++event_peeks;memcpy(out,&source_event,sizeof *out);return true;
}
bool cp_v3_capture_event_release(cp_v3_capture_t *s,const uint8_t id[16],uint32_t revision) {
    assert(s==&collector && !memcmp(id,source_event.event.event_id,16) && revision==source_event.event.revision);
    ++event_releases;return release_ok;
}
cp_v3_control_permissions_t cp_v3_control_permissions(cp_v3_control_t *c,cp_v3_time_t now) {
    (void)now;++permissions;
    return (cp_v3_control_permissions_t){.collection=allowed,.reason=CP_V3_CONTROL_OK,
        .deadline_mono_ms=c->deadline_mono_ms,.deadline_utc_ms=c->deadline_utc_ms};
}
static cp_v3_capture_config_t config(void) {
    return (cp_v3_capture_config_t){
        .statistics={.capacity=512,.window_ms=60000,.bin_ms=5000,.rules_version=CP_V3_STATS_RULESET},
        .context={11,42,13},.report_slots=64,.window_slots=2,.event_slots=1,
        .min_internal_free=64000,.min_internal_largest=16000,.min_psram_free=1000000,.min_psram_largest=100000,
        .clock=clock_map,.entropy=entropy,.context_pointer=&collector};
}
static cp_v3_scope_t scope(void) {
    return (cp_v3_scope_t){.node_id="test-node",.boot_id="test-boot",.placement_id="test-place",
        .policy_id="test-policy",.policy_sha256="test-hash",.dataset="research",.assignment_generation=42};
}
static cp_v3_control_t *control(void) {
    static cp_v3_control_t c;
    memset(&c,0,sizeof c);
    c.state=CP_V3_CONTROL_APPLIED;c.small_statistics=true;c.apply_result=CP_V3_APPLY_OK;
    c.acknowledged_at_utc_ms=90000;c.applied_at_utc_ms=90000;c.contact_seq=1;c.span_seq=1;
    c.lease_server_utc_ms=99000;c.deadline_mono_ms=200000;c.deadline_utc_ms=300000;c.last_applied_generation=42;
    c.policy=(cp_v3_trial_policy_t){.scope=scope(),.statistics=true,.collection_enabled=true,
        .stats_max_addresses=512,.window_ms=60000,.bin_ms=5000,.scan_interval_units=160,.scan_window_units=80};
    return &c;
}
static cp_v3_time_t now(void) { return (cp_v3_time_t){.mono_ms=1000,.utc_ms=100000,.uncertainty_ms=100,.clock_epoch=1}; }
static void prepared(te_v3_shared_capture_t *b,cp_v3_capture_config_t c) {
    memset(b,0,sizeof *b);assert(te_v3_shared_capture_prepare(b,&c)==ESP_OK);
}
static void preparation(void) {
    te_v3_shared_capture_t b={0};cp_v3_capture_config_t c=config();unsigned before=prepares;
    c.raw=forbidden_raw;assert(te_v3_shared_capture_prepare(&b,&c)==ESP_ERR_INVALID_ARG);
    c=config();c.min_psram_free=0;assert(te_v3_shared_capture_prepare(&b,&c)==ESP_ERR_INVALID_ARG);
    c=config();c.context.config_generation=0;assert(te_v3_shared_capture_prepare(&b,&c)==ESP_ERR_INVALID_ARG);
    assert(prepares==before && !b.attempted);
    c=config();assert(te_v3_shared_capture_prepare(&b,&c)==ESP_OK);
    assert(!b.active && !seen_config.raw && seen_config.context.config_generation==42);
    assert(seen_config.context_pointer==c.context_pointer && seen_config.clock==clock_map && seen_config.entropy==entropy);
    assert(seen_config.min_psram_free==1000000 && seen_config.min_internal_largest==16000);
    assert(te_v3_shared_capture_prepare(&b,&c)==ESP_ERR_INVALID_ARG && prepares==before+1);
    b=(te_v3_shared_capture_t){0};prepare_error=ESP_FAIL;
    assert(te_v3_shared_capture_prepare(&b,&c)==ESP_FAIL && b.attempted && b.faulted && !b.prepared);
    prepare_error=ESP_OK;assert(te_v3_shared_capture_prepare(&b,&c)==ESP_ERR_INVALID_ARG);
}
static void authorization(void) {
    te_v3_shared_capture_t b;prepared(&b,config());cp_v3_control_t *c=control();unsigned before=starts;
    assert(te_v3_shared_capture_start(&b,c,now(),7,false)==ESP_ERR_INVALID_STATE);
    c->contact_seq=0;assert(te_v3_shared_capture_start(&b,c,now(),7,true)==ESP_ERR_INVALID_STATE);c->contact_seq=1;
    c->applied_at_utc_ms=0;assert(te_v3_shared_capture_start(&b,c,now(),7,true)==ESP_ERR_INVALID_STATE);c->applied_at_utc_ms=90000;
    c->apply_result=CP_V3_APPLY_INTERNAL_ERROR;assert(te_v3_shared_capture_start(&b,c,now(),7,true)==ESP_ERR_INVALID_STATE);c->apply_result=CP_V3_APPLY_OK;
    c->state=CP_V3_CONTROL_ACK_PENDING;assert(te_v3_shared_capture_start(&b,c,now(),7,true)==ESP_ERR_INVALID_STATE);c->state=CP_V3_CONTROL_APPLIED;
    allowed=false;assert(te_v3_shared_capture_start(&b,c,now(),7,true)==ESP_ERR_INVALID_STATE);allowed=true;
    c->deadline_mono_ms=61000;assert(te_v3_shared_capture_start(&b,c,now(),7,true)==ESP_ERR_INVALID_STATE);
    c->deadline_mono_ms=UINT64_MAX/1000+1;assert(te_v3_shared_capture_start(&b,c,now(),7,true)==ESP_ERR_INVALID_STATE);
    c->deadline_mono_ms=200000;c->deadline_utc_ms=160100;assert(te_v3_shared_capture_start(&b,c,now(),7,true)==ESP_ERR_INVALID_STATE);
    c->deadline_utc_ms=300000;c->policy.stats_max_addresses=256;assert(te_v3_shared_capture_start(&b,c,now(),7,true)==ESP_ERR_INVALID_STATE);
    c->policy.stats_max_addresses=512;c->policy.local_raw.enabled=true;assert(te_v3_shared_capture_start(&b,c,now(),7,true)==ESP_ERR_INVALID_STATE);
    c->policy.local_raw.enabled=false;c->policy.scope.assignment_generation=43;c->last_applied_generation=43;
    assert(te_v3_shared_capture_start(&b,c,now(),7,true)==ESP_ERR_INVALID_STATE);
    assert(b.config.context.config_generation==42 && seen_config.context.config_generation==42);
    c->policy.scope.assignment_generation=42;c->last_applied_generation=42;
    c->policy.local_raw.enabled=false;cp_v3_time_t invalid=now();invalid.utc_ms=UINT64_MAX;
    assert(te_v3_shared_capture_start(&b,c,invalid,7,true)==ESP_ERR_INVALID_STATE);
    assert(starts==before);
    assert(te_v3_shared_capture_start(&b,c,now(),7,true)==ESP_OK && b.active && starts==before+1);
    assert(seen_deadline==200000 && !memcmp(&seen_scope,&c->policy.scope,sizeof seen_scope));
    c->deadline_mono_ms+=10000;c->deadline_utc_ms+=10000;
    assert(te_v3_shared_capture_maintain(&b,c,now(),true)==ESP_OK && extensions==1 && b.deadline_mono_ms==210000);
    unsigned pause_before=pauses;
    assert(te_v3_shared_capture_maintain(&b,c,now(),false)==ESP_ERR_INVALID_STATE && !b.active && pauses==pause_before+1);
    assert(seen_reason==CP_V3_TEMPORAL_SCAN_GAP);
    assert(te_v3_shared_capture_maintain(&b,c,now(),true)==ESP_ERR_INVALID_STATE && !b.active);
    assert(te_v3_shared_capture_start(&b,c,now(),7,true)==ESP_OK);
    c->policy.scope.placement_id[0]='X';
    assert(te_v3_shared_capture_maintain(&b,c,now(),true)==ESP_ERR_INVALID_STATE && !b.active);
    assert(seen_reason==CP_V3_TEMPORAL_LEASE_EXPIRED);
    unsigned starts_before=starts;
    assert(te_v3_shared_capture_start(&b,c,now(),7,true)==ESP_ERR_INVALID_STATE && starts==starts_before);
    assert(!strcmp(b.scope.placement_id,"test-place") && b.config.context.placement_generation==13);
    c=control();assert(te_v3_shared_capture_start(&b,c,now(),7,true)==ESP_OK);
    c->policy.scope.assignment_generation=43;c->last_applied_generation=43;
    assert(te_v3_shared_capture_maintain(&b,c,now(),true)==ESP_ERR_INVALID_STATE && !b.active);
    assert(b.config.context.config_generation==42 && b.scope.assignment_generation==42);
    assert(te_v3_shared_capture_start(&b,c,now(),7,true)==ESP_ERR_INVALID_STATE);
    c=control();assert(te_v3_shared_capture_start(&b,c,now(),7,true)==ESP_OK);
    allowed=false;assert(te_v3_shared_capture_maintain(&b,c,now(),true)==ESP_ERR_INVALID_STATE && !b.active);allowed=true;
    assert(te_v3_shared_capture_start(&b,c,now(),7,true)==ESP_OK);
    c->span_seq++;assert(te_v3_shared_capture_maintain(&b,c,now(),true)==ESP_ERR_INVALID_STATE && !b.active);
    c=control();assert(te_v3_shared_capture_start(&b,c,now(),7,true)==ESP_OK);
    c->policy.scan_window_units++;assert(te_v3_shared_capture_maintain(&b,c,now(),true)==ESP_ERR_INVALID_STATE && !b.active);
    c=control();assert(te_v3_shared_capture_start(&b,c,now(),7,true)==ESP_OK);
    c->deadline_mono_ms--;assert(te_v3_shared_capture_maintain(&b,c,now(),true)==ESP_ERR_INVALID_STATE && !b.active);
    c=control();assert(te_v3_shared_capture_start(&b,c,now(),7,true)==ESP_OK);
    cp_v3_time_t near=now();near.mono_ms=c->deadline_mono_ms-1;near.utc_ms=c->deadline_utc_ms-near.uncertainty_ms-1;
    assert(te_v3_shared_capture_maintain(&b,c,near,true)==ESP_OK && b.active);
    near.mono_ms++;assert(te_v3_shared_capture_maintain(&b,c,near,true)==ESP_ERR_INVALID_STATE && !b.active);
    c=control();start_error=ESP_FAIL;pause_before=pauses;
    assert(te_v3_shared_capture_start(&b,c,now(),7,true)==ESP_FAIL && b.faulted && pauses==pause_before+1);
    start_error=ESP_OK;assert(te_v3_shared_capture_start(&b,c,now(),7,true)==ESP_ERR_INVALID_STATE);
}
static void temporal_and_handoff(void) {
    cp_v3_capture_config_t cfg=config();cfg.temporal_enabled=true;cfg.report_events=true;
    cfg.temporal=cp_v3_temporal_default_config();te_v3_shared_capture_t b;prepared(&b,cfg);
    cp_v3_control_t *c=control();c->policy.candidate_events=true;
    c->policy.temporal=(cp_v3_control_temporal_t){.rolling=true,.slice_ms=cfg.temporal.slice_ms,
        .history_ms=cfg.temporal.history_ms,.gap_ms=cfg.temporal.gap_ms,.max_event_ms=cfg.temporal.max_event_ms,
        .max_tracks=cfg.temporal.max_tracks,.max_open_events=cfg.temporal.max_open_events,.report_mode=CP_V3_TEMPORAL_REPORT_TERMINAL};
    assert(te_v3_shared_capture_start(&b,c,now(),7,true)==ESP_OK);
    c->policy.temporal.history_ms-=cfg.temporal.slice_ms;
    assert(te_v3_shared_capture_maintain(&b,c,now(),true)==ESP_ERR_INVALID_STATE && !b.active);
    source_window=(cp_v3_capture_window_t){.scope=scope(),.window_seq=7};
    source_event=(cp_v3_capture_event_t){.scope=scope(),.slice_ms=2000,.report_allowed=true,
        .event={.event_id={9},.event_seq=12,.revision=1,.context={11,42,13}}};
    cp_v3_capture_window_t w,again;assert(te_v3_shared_capture_window(&b,&w));
    source_window.statistics.worker_reports=99;
    assert(te_v3_shared_capture_window(&b,&again) && window_peeks==1 && !memcmp(&w,&again,sizeof w));
    assert(!te_v3_shared_capture_window_release(&b,&source_window) && !window_releases);
    again=w;again.scope.placement_id[0]='X';assert(!te_v3_shared_capture_window_release(&b,&again));
    release_ok=false;assert(!te_v3_shared_capture_window_release(&b,&w) && b.window_held);
    release_ok=true;assert(te_v3_shared_capture_window_release(&b,&w) && !b.window_held);
    assert(!te_v3_shared_capture_window_release(&b,&w));
    cp_v3_capture_event_t e,e2;assert(te_v3_shared_capture_event(&b,&e));
    source_event.event.context.config_generation++;
    assert(te_v3_shared_capture_event(&b,&e2) && event_peeks==1 && !memcmp(&e,&e2,sizeof e));
    assert(!te_v3_shared_capture_event_release(&b,&source_event) && !event_releases);
    e2=e;e2.event.event_seq++;assert(!te_v3_shared_capture_event_release(&b,&e2));
    e2=e;e2.scope.policy_sha256[0]='X';assert(!te_v3_shared_capture_event_release(&b,&e2));
    release_ok=false;assert(!te_v3_shared_capture_event_release(&b,&e) && b.event_held);
    release_ok=true;assert(te_v3_shared_capture_event_release(&b,&e) && !b.event_held);
    assert(!te_v3_shared_capture_event_release(&b,&e));
}
int main(void) {
    preparation();authorization();temporal_and_handoff();assert(permissions>0);
    puts("board shared capture bridge tests passed (mock collector/control; no hardware acceptance)");
}
