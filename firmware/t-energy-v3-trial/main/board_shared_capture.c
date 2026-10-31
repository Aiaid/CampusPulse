#include "board_shared_capture.h"
#include <limits.h>
#include <string.h>

static bool text(const char *p,size_t n) { return p && p[0] && memchr(p,0,n); }
static bool scope_valid(const cp_v3_scope_t *s) {
    return s && text(s->node_id,sizeof s->node_id) && text(s->boot_id,sizeof s->boot_id) &&
        text(s->placement_id,sizeof s->placement_id) && text(s->policy_id,sizeof s->policy_id) &&
        text(s->policy_sha256,sizeof s->policy_sha256) && text(s->dataset,sizeof s->dataset) &&
        s->assignment_generation;
}
static bool scope_equal(const cp_v3_scope_t *a,const cp_v3_scope_t *b) {
    return scope_valid(a) && scope_valid(b) && a->assignment_generation==b->assignment_generation &&
        a->window_seq==b->window_seq &&
        !strcmp(a->node_id,b->node_id) && !strcmp(a->boot_id,b->boot_id) &&
        !strcmp(a->placement_id,b->placement_id) && !strcmp(a->policy_id,b->policy_id) &&
        !strcmp(a->policy_sha256,b->policy_sha256) && !strcmp(a->dataset,b->dataset);
}
static bool config_valid(const cp_v3_capture_config_t *c) {
    if(!c || c->raw || !c->clock || !c->entropy || !c->min_internal_free ||
        !c->min_internal_largest || !c->min_psram_free || !c->min_psram_largest ||
        !c->context.boot_generation || !c->context.config_generation || !c->context.placement_generation ||
        !c->statistics.capacity || c->statistics.capacity>CP_V3_STATS_MAX_CAPACITY ||
        !c->statistics.window_ms || !c->statistics.bin_ms ||
        c->statistics.window_ms%c->statistics.bin_ms ||
        c->statistics.window_ms/c->statistics.bin_ms>CP_V3_STATS_MAX_BINS ||
        c->statistics.rules_verified || c->statistics.classify || !c->statistics.rules_version ||
        strcmp(c->statistics.rules_version,CP_V3_STATS_RULESET) ||
        (c->report_events && !c->temporal_enabled)) return false;
    return !c->temporal_enabled || cp_v3_temporal_memory_bytes(&c->temporal)>0;
}
static bool policy_matches(const te_v3_shared_capture_t *b,const cp_v3_trial_policy_t *p) {
    const cp_v3_capture_config_t *c=&b->config;
    if(c->context.config_generation!=p->scope.assignment_generation ||
        !p->statistics || !p->collection_enabled || p->local_raw.enabled ||
        p->stats_max_addresses!=c->statistics.capacity || p->window_ms!=c->statistics.window_ms ||
        p->bin_ms!=c->statistics.bin_ms || p->temporal.rolling!=c->temporal_enabled ||
        p->candidate_events!=c->report_events ||
        (c->report_events && p->temporal.report_mode!=CP_V3_TEMPORAL_REPORT_TERMINAL) ||
        (!c->report_events && p->temporal.report_mode!=CP_V3_TEMPORAL_REPORT_OFF)) return false;
    if(c->temporal_enabled && (p->temporal.slice_ms!=c->temporal.slice_ms ||
        p->temporal.history_ms!=c->temporal.history_ms || p->temporal.gap_ms!=c->temporal.gap_ms ||
        p->temporal.max_event_ms!=c->temporal.max_event_ms ||
        p->temporal.max_tracks!=c->temporal.max_tracks ||
        p->temporal.max_open_events!=c->temporal.max_open_events)) return false;
    return p->scan_interval_units && p->scan_interval_units<=UINT16_MAX &&
        p->scan_window_units && p->scan_window_units<=p->scan_interval_units;
}
static bool authority(te_v3_shared_capture_t *b,cp_v3_control_t *c,cp_v3_time_t now,bool starting,
    cp_v3_control_permissions_t *out) {
    if(!c || !c->small_statistics || c->state!=CP_V3_CONTROL_APPLIED ||
        c->apply_result!=CP_V3_APPLY_OK || !c->acknowledged_at_utc_ms || !c->applied_at_utc_ms ||
        !c->contact_seq || !c->span_seq || !c->lease_server_utc_ms ||
        c->last_applied_generation!=c->policy.scope.assignment_generation ||
        !scope_valid(&c->policy.scope) || !policy_matches(b,&c->policy) ||
        now.utc_ms<now.uncertainty_ms || now.utc_ms>UINT64_MAX-now.uncertainty_ms ||
        now.mono_ms>UINT64_MAX/1000) return false;
    *out=cp_v3_control_permissions(c,now);
    uint64_t upper=now.utc_ms+now.uncertainty_ms,window=starting?b->config.statistics.window_ms:0;
    return out->collection && !out->frozen_only && !out->local_raw && out->reason==CP_V3_CONTROL_OK &&
        out->deadline_mono_ms==c->deadline_mono_ms && out->deadline_utc_ms==c->deadline_utc_ms &&
        out->deadline_mono_ms<=UINT64_MAX/1000 && out->deadline_mono_ms>now.mono_ms &&
        out->deadline_mono_ms-now.mono_ms>window && out->deadline_utc_ms>upper &&
        out->deadline_utc_ms-upper>window;
}
esp_err_t te_v3_shared_capture_prepare(te_v3_shared_capture_t *b,const cp_v3_capture_config_t *c) {
    if(!b || b->attempted || !config_valid(c)) return ESP_ERR_INVALID_ARG;
    b->attempted=true;b->config=*c;
    /* Freeze the accepted rules string instead of retaining mutable caller RAM. */
    b->config.statistics.rules_version=CP_V3_STATS_RULESET;
    b->last_error=cp_v3_capture_prepare(&b->config,&b->collector);
    b->prepared=b->last_error==ESP_OK && b->collector;
    b->faulted=!b->prepared;
    if(!b->prepared && b->last_error==ESP_OK)b->last_error=ESP_ERR_INVALID_STATE;
    return b->last_error;
}
esp_err_t te_v3_shared_capture_pause(te_v3_shared_capture_t *b,cp_v3_temporal_reason_t why,uint32_t timeout) {
    if(!b || !b->prepared)return ESP_ERR_INVALID_STATE;
    b->active=false;
    b->last_error=cp_v3_capture_pause(b->collector,why,timeout);
    if(b->last_error!=ESP_OK)b->faulted=true;
    return b->last_error;
}
static esp_err_t denied(te_v3_shared_capture_t *b,cp_v3_temporal_reason_t why) {
    if(b && b->active)(void)te_v3_shared_capture_pause(b,why,0);
    return ESP_ERR_INVALID_STATE;
}
esp_err_t te_v3_shared_capture_start(te_v3_shared_capture_t *b,cp_v3_control_t *c,
    cp_v3_time_t now,uint32_t next,bool queue_ready) {
    cp_v3_control_permissions_t p={0};
    if(!b || !b->prepared || b->faulted || b->active || b->window_held || b->event_held ||
        !next || !queue_ready || !authority(b,c,now,true,&p)) return ESP_ERR_INVALID_STATE;
    /* Shared start can synthesize context changes from a new scope. This
     * adapter has no explicit context-update operation, so forbid that path. */
    if(b->started && (!scope_equal(&b->scope,&c->policy.scope) ||
        b->scan_interval_units!=c->policy.scan_interval_units ||
        b->scan_window_units!=c->policy.scan_window_units))return ESP_ERR_INVALID_STATE;
    b->last_error=cp_v3_capture_start(b->collector,&c->policy.scope,next,
        c->policy.scan_interval_units,c->policy.scan_window_units,p.deadline_mono_ms);
    if(b->last_error!=ESP_OK) {
        /* A timeout can mean a command already took effect. Fence it before
         * allowing the caller to continue; never retry an ambiguous start. */
        esp_err_t error=b->last_error;
        (void)te_v3_shared_capture_pause(b,CP_V3_TEMPORAL_SCAN_GAP,0);
        b->faulted=true;b->last_error=error;return error;
    }
    b->scope=c->policy.scope;b->deadline_mono_ms=p.deadline_mono_ms;b->span_seq=c->span_seq;
    b->scan_interval_units=c->policy.scan_interval_units;b->scan_window_units=c->policy.scan_window_units;
    b->started=true;b->active=true;
    return ESP_OK;
}
esp_err_t te_v3_shared_capture_maintain(te_v3_shared_capture_t *b,cp_v3_control_t *c,
    cp_v3_time_t now,bool queue_ready) {
    if(!b || !b->prepared || !b->active || b->faulted)return ESP_ERR_INVALID_STATE;
    if(!queue_ready)return denied(b,CP_V3_TEMPORAL_SCAN_GAP);
    cp_v3_control_permissions_t p={0};
    if(!authority(b,c,now,false,&p) || !scope_equal(&b->scope,&c->policy.scope) || c->span_seq!=b->span_seq ||
        c->policy.scan_interval_units!=b->scan_interval_units || c->policy.scan_window_units!=b->scan_window_units ||
        p.deadline_mono_ms<b->deadline_mono_ms)return denied(b,CP_V3_TEMPORAL_LEASE_EXPIRED);
    if(p.deadline_mono_ms==b->deadline_mono_ms)return ESP_OK;
    b->last_error=cp_v3_capture_deadline(b->collector,p.deadline_mono_ms);
    if(b->last_error!=ESP_OK)return denied(b,CP_V3_TEMPORAL_LEASE_EXPIRED);
    b->deadline_mono_ms=p.deadline_mono_ms;return ESP_OK;
}
bool te_v3_shared_capture_window(te_v3_shared_capture_t *b,cp_v3_capture_window_t *out) {
    if(!b || !b->prepared || !out)return false;
    if(!b->window_held) {
        if(!cp_v3_capture_window(b->collector,&b->held_window,0))return false;
        b->window_held=true;
    }
    memcpy(out,&b->held_window,sizeof *out);return true;
}
bool te_v3_shared_capture_window_release(te_v3_shared_capture_t *b,const cp_v3_capture_window_t *w) {
    if(!b || !b->window_held || !w || memcmp(w,&b->held_window,sizeof *w))return false;
    if(!cp_v3_capture_window_release(b->collector,w->window_seq,w->scope.assignment_generation))return false;
    b->window_held=false;memset(&b->held_window,0,sizeof b->held_window);return true;
}
bool te_v3_shared_capture_event(te_v3_shared_capture_t *b,cp_v3_capture_event_t *out) {
    if(!b || !b->prepared || !out)return false;
    if(!b->event_held) {
        if(!cp_v3_capture_event(b->collector,&b->held_event,0))return false;
        b->event_held=true;
    }
    memcpy(out,&b->held_event,sizeof *out);return true;
}
bool te_v3_shared_capture_event_release(te_v3_shared_capture_t *b,const cp_v3_capture_event_t *e) {
    if(!b || !b->event_held || !e || memcmp(e,&b->held_event,sizeof *e))return false;
    if(!cp_v3_capture_event_release(b->collector,e->event.event_id,e->event.revision))return false;
    b->event_held=false;memset(&b->held_event,0,sizeof b->held_event);return true;
}
