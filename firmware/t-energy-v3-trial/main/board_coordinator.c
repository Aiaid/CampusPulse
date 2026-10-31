#include "board_coordinator.h"
#include <string.h>

static bool terminated(const char *s,size_t n) { return s && memchr(s,0,n); }
static bool limits_valid(const te_v3_coordinator_limits_t *l) {
    return l && l->max_steps && l->max_steps<=TE_COORD_MAX_STEPS &&
        l->max_elapsed_ms && l->max_elapsed_ms<=TE_COORD_MAX_ELAPSED_MS &&
        l->pause_timeout_ms && l->pause_timeout_ms<=TE_COORD_MAX_PAUSE_MS &&
        l->cleanup_attempts && l->cleanup_attempts<=TE_COORD_MAX_CLEANUP_ATTEMPTS;
}
static bool fresh(const te_runtime_window_adapter_t *a) {
    return a && a->queue && a->capture && a->control && a->freeze &&
        a->workspace && a->capability && !a->transport_started && !a->registered &&
        a->control->state==CP_V3_CONTROL_EMPTY && !a->control->node_id[0] &&
        !a->control->boot_id[0] && !a->control_length &&
        !a->capture->attempted && !a->capture->prepared && !a->capture->collector &&
        !a->ack_frozen && !a->ack_stored && !a->ack_committed && !a->lease_committed &&
        !a->identity_active && !a->identity_fault && !a->window_id_count &&
        !a->stored && !a->released && !a->sent && a->handoff.state==TE_HANDOFF_EMPTY;
}
static bool budget_valid(const cp_v3_budget_t *b) {
    return b && b->opened && b->configured && !b->latched && b->limit_bytes &&
        b->store.load && b->store.store && b->store.logical_write_bytes>=CP_V3_BUDGET_RECORD_BYTES;
}
static void retained(te_v3_coordinator_t *c) {
    te_runtime_window_adapter_t *a=c->adapter;
    c->status.window_retained=a && a->capture && a->capture->window_held;
    c->status.event_retained=a && a->capture && a->capture->event_held;
    c->status.durable_record_retained=a && ((a->stored&&!a->sent) ||
        (a->ack_stored&&!a->ack_committed) ||
        (a->control_length && !a->lease_committed && a->ack_committed));
    if(a && a->handoff.state!=TE_HANDOFF_EMPTY && !a->released)
        c->status.window_retained=true;
}
static uint32_t blockers(te_v3_coordinator_t *c) {
    /* A structurally valid callback table is not an implementation or proof.
     * History still lacks durable artifacts/body-time/original-budget binding;
     * ACK/lease UUIDs also lack durable reservations. Resource arenas claimed
     * by capabilities are not yet proven to be the actual collector's arenas.
     * Receipt-only recovery still needs end-to-end board integration evidence;
     * the window peek cannot distinguish an empty queue from a collector fault.
     * Durable per-node write/uplink ledger providers are also not bound here.
     * No code path may clear these requirements through input flags. */
    uint32_t b=TE_COORD_RELEASE_BLOCKERS;
    te_runtime_window_adapter_t *a=c->adapter;
    if(!te_v3_runtime_ready())b|=TE_COORD_RUNTIME_GATE;
    if(!a || !a->queue || !a->queue->opened || !a->capture || !a->control ||
       !a->workspace || !a->freeze || !a->capability || !a->budget_lock ||
       !a->budget_unlock || !a->now || !a->entropy || !a->reserve_identity ||
       !a->queue_ready || !a->post_statistics || !a->actual_apply ||
       !a->backlog_audit_empty || !a->historical_aged || !a->historical_authorized ||
       !a->registration_seq || !a->apply_seq || !a->lease_contact_seq ||
       !a->next_window_seq || c->capture_config.raw || !c->capture_config.clock ||
       !c->capture_config.entropy || c->capture_config.report_events)
        b|=TE_COORD_BAD_BINDING;
    if(!a || !budget_valid(a->uplink_budget) || !a->queue ||
       !budget_valid(a->queue->config.write_budget))b|=TE_COORD_BAD_BUDGET;
    cp_v3_time_t t=c->bootstrap.clock_seed;
    c->status.capability_result=TE_V3_CAPABILITIES_INVALID;
    size_t n=0;
    if(a && a->capability && t.utc_ms>=t.uncertainty_ms && t.utc_ms<=UINT64_MAX-t.uncertainty_ms)
        c->status.capability_result=te_v3_capabilities_build(a->capability,
            t.utc_ms-t.uncertainty_ms,t.utc_ms+t.uncertainty_ms,
            a->capability_json,sizeof a->capability_json,&n);
    if(c->status.capability_result!=TE_V3_CAPABILITIES_OK)b|=TE_COORD_UNPROVEN_CAPABILITY;
    return b;
}
bool te_v3_coordinator_init(te_v3_coordinator_t *c,te_runtime_window_adapter_t *a,
    const cp_v3_capture_config_t *capture,const te_v3_coordinator_limits_t *limits,
    const char *json,const char *node,const char *boot,uint64_t mono) {
    if(!c || c->initialized || c->busy || !limits_valid(limits))return false;
    c->initialized=true; c->status.blockers=TE_COORD_RELEASE_BLOCKERS;
    c->status.state=TE_COORD_FAILED; c->status.phase=TE_RT_CONNECT;
    c->limits=*limits; c->started_mono_ms=c->last_mono_ms=mono;
    if(!fresh(a) || !capture || !node || !boot ||
       !terminated(a->capability->node_id,sizeof a->capability->node_id) ||
       !terminated(a->capability->boot_id,sizeof a->capability->boot_id) ||
       strcmp(node,a->capability->node_id) || strcmp(boot,a->capability->boot_id)) {
        c->status.blockers|=TE_COORD_BAD_BINDING; return false;
    }
    if(!trial_bootstrap_parse(json,node,boot,mono,&c->bootstrap)) {
        c->status.blockers|=TE_COORD_BAD_BOOTSTRAP; return false;
    }
    c->adapter=a; c->capture_config=*capture;
    c->capability=*a->capability;
    if(a->capability->evidence) {
        c->capability_evidence=*a->capability->evidence;
        c->capability.evidence=&c->capability_evidence;
    }
    if(a->capability->temporal) {
        c->capability_temporal=*a->capability->temporal;
        c->capability.temporal=&c->capability_temporal;
    }
    a->capability=&c->capability;
    c->capture_config.stop_after_windows=c->bootstrap.max_windows;
    c->transport=(cp_v3_transport_config_t){
        .origin=c->bootstrap.origin,
        .server_ca_pem=c->bootstrap.server_ca_pem[0]?c->bootstrap.server_ca_pem:NULL,
        .clock_seed=c->bootstrap.clock_seed,.wifi_timeout_ms=10000,
        .request_timeout_ms=5000,.server_clock_error_ms=1000
    };
    a->settings=&c->bootstrap.settings; a->transport_config=&c->transport;
    /* The freezer must use the same real SHA-256 as transport/control. */
    a->freeze->sha256=cp_v3_transport_sha256; a->freeze->sha_context=NULL;
    c->status.state=TE_COORD_CONFIGURED; c->status.secrets_retained=true;
    return true;
}

static te_v3_coordinator_result_t cleanup(te_v3_coordinator_t *c) {
    te_runtime_window_adapter_t *a=c->adapter;
    if(c->status.cleanup_attempts>=c->limits.cleanup_attempts)return TE_COORD_ERROR;
    ++c->status.cleanup_attempts;
    bool capture_maybe_started=a && a->capture &&
        (c->capture_attempted || a->capture->attempted || a->capture->prepared || a->capture->active);
    c->status.capture_paused=!capture_maybe_started;
    if(capture_maybe_started) {
        c->status.capture_error=te_v3_shared_capture_pause(a->capture,
            CP_V3_TEMPORAL_SCAN_GAP,c->limits.pause_timeout_ms);
        if(a->capture->collector) {
            cp_v3_capture_status_t s={0}; cp_v3_capture_status(a->capture->collector,&s);
            c->status.capture_paused=c->status.capture_error==ESP_OK && s.paused && !s.running;
        }
    }
    bool transport_maybe_started=c->transport_attempted || (a && a->transport_started);
    c->status.transport_stopped=!transport_maybe_started;
    if(transport_maybe_started) {
        cp_v3_transport_cancel();
        c->status.transport_error=cp_v3_transport_stop();
        c->status.transport_stopped=c->status.transport_error==ESP_OK;
        if(c->status.transport_stopped) { c->transport_attempted=false; if(a)a->transport_started=false; }
    }
    if(c->status.transport_stopped) {
        trial_bootstrap_clear(&c->bootstrap);
        memset(&c->transport,0,sizeof c->transport);
        c->status.secrets_retained=false;
    }
    c->runtime.active=false; c->runtime.phase=TE_RT_HALTED;
    c->status.phase=TE_RT_HALTED;
    retained(c);
    if(!c->status.capture_paused || !c->status.transport_stopped) {
        c->status.state=TE_COORD_FAILED; return TE_COORD_ERROR;
    }
    return TE_COORD_DONE;
}
te_v3_coordinator_result_t te_v3_coordinator_stop(te_v3_coordinator_t *c) {
    if(!c || !c->initialized || c->busy)return TE_COORD_INVALID;
    if(c->status.capture_paused && c->status.transport_stopped && !c->status.secrets_retained)
        return TE_COORD_DONE;
    c->busy=true;
    te_v3_coordinator_result_t r=cleanup(c);
    if(r==TE_COORD_DONE && c->status.state!=TE_COORD_BLOCKED && c->status.state!=TE_COORD_FAILED)
        c->status.state=TE_COORD_STOPPED;
    c->busy=false; return r;
}
te_v3_coordinator_result_t te_v3_coordinator_step(te_v3_coordinator_t *c,uint64_t mono) {
    if(!c || !c->initialized || c->busy)return TE_COORD_INVALID;
    if(c->status.state==TE_COORD_BLOCKED)return TE_COORD_DENIED;
    if(c->status.state==TE_COORD_STOPPED)return TE_COORD_DONE;
    if(c->status.state==TE_COORD_FAILED)return TE_COORD_ERROR;
    if(c->status.state!=TE_COORD_CONFIGURED && c->status.state!=TE_COORD_RUNNING)return TE_COORD_INVALID;
    c->busy=true;
    if(mono<c->last_mono_ms || mono<c->started_mono_ms)c->status.blockers|=TE_COORD_CLOCK_FAULT;
    else if(mono-c->started_mono_ms>=c->limits.max_elapsed_ms)c->status.blockers|=TE_COORD_TIME_LIMIT;
    c->last_mono_ms=mono;
    if(c->status.steps>=c->limits.max_steps)c->status.blockers|=TE_COORD_STEP_LIMIT;
    c->status.blockers|=blockers(c);
    if(c->status.blockers) {
        c->status.state=TE_COORD_BLOCKED;
        te_v3_coordinator_result_t r=cleanup(c);
        c->busy=false; return r==TE_COORD_DONE?TE_COORD_DENIED:TE_COORD_ERROR;
    }
    /* Deliberately unreachable in this release. Keep the eventual integration
     * concrete: prepare the shared collector and invoke the real adapter, never
     * a caller-supplied phase evaluator. Do not remove blockers to demo this. */
    if(!c->capture_attempted) {
        c->capture_attempted=true;
        c->status.capture_error=te_v3_shared_capture_prepare(c->adapter->capture,&c->capture_config);
        if(c->status.capture_error!=ESP_OK) {
            c->status.state=TE_COORD_FAILED; (void)cleanup(c); c->busy=false; return TE_COORD_ERROR;
        }
    }
    te_runtime_phase_t phase=c->runtime.phase;
    if(phase==TE_RT_CONNECT)c->transport_attempted=true;
    te_runtime_ops_t ops={te_runtime_window_perform,te_runtime_window_pause,c->adapter};
    te_runtime_step_result_t r=te_runtime_step(&c->runtime,&ops);
    ++c->status.steps; c->status.phase=c->runtime.phase;
    c->status.failed_phase=c->runtime.failed_phase;
    if(r==TE_RT_STOPPED || r==TE_RT_INVALID) {
        c->status.state=TE_COORD_FAILED; (void)cleanup(c); c->busy=false; return TE_COORD_ERROR;
    }
    c->status.state=TE_COORD_RUNNING;
    if(phase==TE_RT_SEND && r==TE_RT_PROGRESS)++c->status.acknowledged_windows;
    if(c->status.acknowledged_windows>=c->bootstrap.max_windows) {
        te_v3_coordinator_result_t done=cleanup(c);
        if(done==TE_COORD_DONE)c->status.state=TE_COORD_STOPPED;
        c->busy=false; return done;
    }
    retained(c); c->busy=false;
    return r==TE_RT_IDLE?TE_COORD_IDLE:TE_COORD_PROGRESS;
}
bool te_v3_coordinator_status(const te_v3_coordinator_t *c,te_v3_coordinator_status_t *out) {
    if(!c || !out || !c->initialized || c->busy)return false;
    *out=c->status; return true;
}
