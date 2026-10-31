/* Synthetic host failure tests only. Link real coordinator, runtime, bootstrap
 * (mbedTLS), capabilities, shared-capture and stats/temporal implementations.
 * Hardware/transport seams below NEVER grant runtime success. An unexpected
 * phase, SHA, network start, queue mutation or apply callback aborts the test.
 * Synthetic evidence proves that caller success flags cannot clear blockers;
 * it is explicitly not board admission or device acceptance. */
#include "board_coordinator.h"
#include "board_report.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static te_v3_coordinator_t coordinator;
static te_runtime_window_adapter_t adapter;
static te_v3_shared_capture_t capture;
static te_v3_window_freeze_t freezer;
static cp_v3_control_t control;
static cp_v3_control_workspace_t workspace;
static te_v3_small_queue_t queue;
static cp_v3_budget_t budget;
static te_v3_capability_evidence_t evidence;
static te_v3_capability_request_t capability;
static cp_v3_capture_config_t capture_config;
static te_v3_coordinator_limits_t limits={20,120000,100,3};
static bool gate, paused=true, reenter;
static esp_err_t pause_result=ESP_OK,stop_result=ESP_OK;
static unsigned pauses,cancels,stops,phase_calls,prepare_calls;
static unsigned char collector_token;
static const uint64_t issued=UINT64_C(1793318400000);
static const char node[]="test-coord",boot[]="11111111-1111-4111-8111-111111111111";
static char json[TRIAL_BOOTSTRAP_LINE_MAX+1],pem[TRIAL_BOOTSTRAP_CA_MAX+1];

bool te_v3_runtime_ready(void) { return gate; }
te_runtime_result_t te_runtime_window_perform(void *p,te_runtime_phase_t phase) {
    (void)p;(void)phase; ++phase_calls; assert(!"blocked coordinator invoked a runtime phase"); return TE_RT_FAIL;
}
bool te_runtime_window_pause(void *p) { (void)p; assert(!"unexpected runtime-owned pause"); return false; }
bool cp_v3_transport_sha256(void *p,const void *b,size_t n,uint8_t d[32]) {
    (void)p;(void)b;(void)n;(void)d; assert(!"blocked coordinator hashed an identity"); return false;
}
void cp_v3_transport_cancel(void) { ++cancels; assert(pauses || !capture.prepared); }
esp_err_t cp_v3_transport_stop(void) { ++stops; assert(cancels==stops); return stop_result; }
esp_err_t cp_v3_capture_prepare(const cp_v3_capture_config_t *c,cp_v3_capture_t **out) {
    (void)c;(void)out; ++prepare_calls; assert(!"blocked coordinator prepared hardware"); return ESP_FAIL;
}
esp_err_t cp_v3_capture_pause(cp_v3_capture_t *c,cp_v3_temporal_reason_t reason,uint32_t timeout) {
    assert(c==(cp_v3_capture_t *)&collector_token && reason==CP_V3_TEMPORAL_SCAN_GAP && timeout==limits.pause_timeout_ms);
    ++pauses;
    if(reenter)assert(te_v3_coordinator_stop(&coordinator)==TE_COORD_INVALID);
    return pause_result;
}
void cp_v3_capture_status(cp_v3_capture_t *c,cp_v3_capture_status_t *s) {
    assert(c==(cp_v3_capture_t *)&collector_token); memset(s,0,sizeof *s); s->paused=paused;s->running=!paused;
}
cp_v3_control_permissions_t cp_v3_control_permissions(cp_v3_control_t *c,cp_v3_time_t t) {
    (void)c;(void)t; assert(!"blocked coordinator requested authority"); return (cp_v3_control_permissions_t){0};
}
esp_err_t cp_v3_capture_start(cp_v3_capture_t *c,const cp_v3_scope_t *s,uint32_t n,uint32_t i,uint32_t w,uint64_t d) {
    (void)c;(void)s;(void)n;(void)i;(void)w;(void)d; assert(!"unexpected capture start"); return ESP_FAIL;
}
esp_err_t cp_v3_capture_deadline(cp_v3_capture_t *c,uint64_t d) {(void)c;(void)d;assert(!"unexpected deadline");return ESP_FAIL;}
bool cp_v3_capture_window(cp_v3_capture_t *c,cp_v3_capture_window_t *w,uint32_t t) {(void)c;(void)w;(void)t;assert(!"unexpected peek");return false;}
bool cp_v3_capture_window_release(cp_v3_capture_t *c,uint32_t w,uint64_t g) {(void)c;(void)w;(void)g;assert(!"unexpected release");return false;}
bool cp_v3_capture_event(cp_v3_capture_t *c,cp_v3_capture_event_t *e,uint32_t t) {(void)c;(void)e;(void)t;assert(!"unexpected event");return false;}
bool cp_v3_capture_event_release(cp_v3_capture_t *c,const uint8_t id[16],uint32_t r) {(void)c;(void)id;(void)r;assert(!"unexpected event release");return false;}
static bool external(const void *p,void *ctx) {(void)ctx;return p==evidence.pools.reports || p==evidence.pools.stats;}
static bool forbidden(void *p) {(void)p;assert(!"unimplemented provider called");return false;}
static void forbidden_unlock(void *p) {(void)p;assert(!"unimplemented provider called");}
static bool now(void *p,cp_v3_time_t *t) {(void)t;return forbidden(p);}
static bool entropy(void *p,uint8_t out[16]) {(void)out;return forbidden(p);}
static bool clock_sample(void *p,uint64_t mono,cp_v3_temporal_time_t *t) {(void)mono;(void)t;return forbidden(p);}
static bool identity(void *p,const char *n,const char *b,const char *id,uint32_t seq) {(void)n;(void)b;(void)id;(void)seq;return forbidden(p);}
static bool aged(void *p,const void *b,size_t n,const cp_v3_expected_t *e,cp_v3_time_t t) {(void)b;(void)n;(void)e;(void)t;return forbidden(p);}
static bool history(void *p,cp_v3_queue_kind_t k,const void *b,size_t n,const cp_v3_expected_t *e,cp_v3_time_t t) {(void)k;return aged(p,b,n,e,t);}
static bool post(void *p,const void *b,size_t n,const cp_v3_expected_t *e,void *r,size_t cap,size_t *rn) {(void)b;(void)n;(void)e;(void)r;(void)cap;(void)rn;return forbidden(p);}
static cp_v3_apply_result_t apply(void *p,const cp_v3_trial_policy_t *policy,cp_v3_boundary_t *b) {(void)policy;(void)b;(void)forbidden(p);return CP_V3_APPLY_STORAGE_FAILED;}
static cp_v3_budget_load_t load(void *p,void *b,size_t cap,size_t *n) {(void)b;(void)cap;(void)n;(void)forbidden(p);return CP_V3_BUDGET_LOAD_IO;}
static bool store(void *p,const void *b,size_t n) {(void)b;(void)n;return forbidden(p);}

static void make_json(bool ca) {
    int written=snprintf(json,sizeof json,"{\"node_id\":\"%s\",\"boot_id\":\"%s\",\"origin\":\"https://synthetic.invalid\",\"uplink_transport\":\"https\","
        "\"device_token\":\"synthetic-secret\",\"ssid\":\"synthetic-wifi\",\"password\":\"synthetic-password\","
        "\"utc_ms\":%llu,\"uncertainty_ms\":10,\"max_windows\":2,\"security\":\"personal\",\"anchor_mono_ms\":60000",
        node,boot,(unsigned long long)(issued+60000));
    assert(written>0);size_t n=(size_t)written;
    if(ca) {
        const char prefix[]=",\"server_ca_pem\":\"";memcpy(json+n,prefix,sizeof prefix-1);n+=sizeof prefix-1;
        for(size_t i=0;pem[i];i++) {
            assert(n+3<sizeof json);
            if(pem[i]=='\n'){json[n++]='\\';json[n++]='n';}
            else if(pem[i]=='\r'){json[n++]='\\';json[n++]='r';}
            else json[n++]=pem[i];
        }
        json[n++]='"';
    }
    json[n++]='}';json[n]=0;
}
static void setup(void) {
    memset(&coordinator,0,sizeof coordinator);memset(&adapter,0,sizeof adapter);
    memset(&capture,0,sizeof capture);memset(&control,0,sizeof control);
    memset(&queue,0,sizeof queue);memset(&freezer,0,sizeof freezer);
    budget=(cp_v3_budget_t){.opened=true,.configured=true,.limit_bytes=1048576,
        .store={.load=load,.store=store,.logical_write_bytes=CP_V3_BUDGET_RECORD_BYTES}};
    queue.opened=true;queue.config.write_budget=&budget;
    adapter=(te_runtime_window_adapter_t){.queue=&queue,.capture=&capture,.control=&control,
        .freeze=&freezer,.workspace=&workspace,.capability=&capability,.uplink_budget=&budget,
        .budget_lock=forbidden,.budget_unlock=forbidden_unlock,.now=now,.queue_ready=forbidden,
        .entropy=entropy,.reserve_identity=identity,.post_statistics=post,.actual_apply=apply,
        .backlog_audit_empty=forbidden,.historical_aged=aged,.historical_authorized=history,
        .registration_seq=1,.apply_seq=1,.lease_contact_seq=1,.next_window_seq=1};
    gate=false;paused=true;pause_result=stop_result=ESP_OK;reenter=false;
    pauses=cancels=stops=phase_calls=prepare_calls=0;
    make_json(false);
}
static bool init(void) {return te_v3_coordinator_init(&coordinator,&adapter,&capture_config,&limits,json,node,boot,60000);}
static bool cleared(const void *p,size_t n) {const unsigned char *b=p;for(size_t i=0;i<n;i++)if(b[i])return false;return true;}
static void simulate_owned_attempt(void) {
    /* Test-only model of an interrupted future owner; no API can reach this
     * state in this release. Never construct such collector/control on device. */
    coordinator.capture_attempted=coordinator.transport_attempted=true;
    capture.attempted=capture.prepared=capture.active=true;
    capture.collector=(cp_v3_capture_t *)&collector_token;
    capture.window_held=capture.event_held=true;
    memset(&capture.held_window,0x56,sizeof capture.held_window);
    adapter.stored=adapter.ack_stored=true;adapter.handoff.state=TE_HANDOFF_FROZEN;
    adapter.control_length=3;memcpy(adapter.control_body,"old",3);
}
int main(int argc,char **argv) {
    assert(argc==2);FILE *f=fopen(argv[1],"rb");assert(f);
    size_t pn=fread(pem,1,sizeof pem-1,f);assert(pn>0 && !ferror(f) && feof(f));fclose(f);pem[pn]=0;
    evidence=(te_v3_capability_evidence_t){.measured_at_utc_ms=issued,.valid_until_utc_ms=issued+3600000,
        .external=external,.arenas_initialized_verified=true,.report_slots=16,
        .psram_free_bytes=4194304,.psram_headroom_bytes=524288,.internal_free_bytes=262144,.internal_headroom_bytes=131072,
        .storage_write_budget_bytes_per_day=1048576,.cpu_profile_verified=true,.scanner_profile_verified=true,
        .measured_cpu_us_per_window=100000,.cpu_budget_us_per_window=1000000,.queue_recovery_verified=true,
        .queue_power_loss_verified=true,.queue_budget_is_not_physical_reservation=true,.free_queue_slots=3,
        .queue_body_budget_bytes=3072,.queue_item_budget=3,.available_nvs_entries=332,.working_budget_bytes=1048576};
    evidence.allocated.reports=evidence.report_slots*sizeof(te_v3_report_t);
    evidence.allocated.stats=cp_v3_stats_memory_bytes(8);
    evidence.pools.reports=calloc(1,evidence.allocated.reports);evidence.pools.stats=malloc(evidence.allocated.stats);
    assert(evidence.pools.reports && evidence.pools.stats);
    capture_config=(cp_v3_capture_config_t){.statistics={.capacity=8,.window_ms=30000,.bin_ms=5000,.rules_version=CP_V3_STATS_RULESET},
        .clock=clock_sample,.entropy=entropy,.min_internal_free=65536,.min_internal_largest=32768,
        .min_psram_free=524288,.min_psram_largest=262144,.context={1,1,1},.report_slots=16,.window_slots=1};
    assert(cp_v3_stats_init(evidence.pools.stats,evidence.allocated.stats,&capture_config.statistics));
    capability=(te_v3_capability_request_t){.capability_id="synthetic-coord",.issued_at_utc_ms=issued,
        .expires_at_utc_ms=issued+3600000,.max_addresses=8,.max_bins=6,.max_window_ms=30000,
        .min_scan_interval_units=4,.max_scan_interval_units=16384,.evidence=&evidence};
    strcpy(capability.node_id,node);strcpy(capability.boot_id,boot);

    setup();assert(init());assert(adapter.transport_config==&coordinator.transport && !coordinator.transport.server_ca_pem);
    assert(te_v3_coordinator_step(&coordinator,60000)==TE_COORD_DENIED);
    te_v3_coordinator_status_t status;
    assert(te_v3_coordinator_status(&coordinator,&status));
    assert((status.blockers&TE_COORD_RELEASE_BLOCKERS)==TE_COORD_RELEASE_BLOCKERS);
    assert(status.blockers&TE_COORD_RUNTIME_GATE);assert(status.capability_result==TE_V3_CAPABILITIES_OK);
    assert(!status.secrets_retained && cleared(&coordinator.bootstrap,sizeof coordinator.bootstrap));
    assert(!phase_calls && !prepare_calls && !pauses && !stops && !cancels);
    assert(te_v3_coordinator_step(&coordinator,60001)==TE_COORD_DENIED && !init());

    setup();gate=true;make_json(true);assert(init());
    assert(coordinator.transport.server_ca_pem==coordinator.bootstrap.server_ca_pem);
    assert(!strcmp(coordinator.transport.server_ca_pem,pem));memset(json,0,sizeof json);
    assert(te_v3_coordinator_step(&coordinator,60000)==TE_COORD_DENIED);
    assert(!(coordinator.status.blockers&TE_COORD_RUNTIME_GATE));
    assert((coordinator.status.blockers&TE_COORD_RELEASE_BLOCKERS)==TE_COORD_RELEASE_BLOCKERS && !phase_calls);

    setup();budget.latched=true;assert(init());assert(te_v3_coordinator_step(&coordinator,59999)==TE_COORD_DENIED);
    assert(coordinator.status.blockers&TE_COORD_BAD_BUDGET);assert(coordinator.status.blockers&TE_COORD_CLOCK_FAULT);
    setup();assert(init());coordinator.status.steps=limits.max_steps;
    assert(te_v3_coordinator_step(&coordinator,60000+limits.max_elapsed_ms)==TE_COORD_DENIED);
    assert(coordinator.status.blockers&TE_COORD_STEP_LIMIT);assert(coordinator.status.blockers&TE_COORD_TIME_LIMIT);
    setup();evidence.queue_power_loss_verified=false;assert(init());assert(te_v3_coordinator_step(&coordinator,60000)==TE_COORD_DENIED);
    assert(coordinator.status.blockers&TE_COORD_UNPROVEN_CAPABILITY);evidence.queue_power_loss_verified=true;
    setup();json[0]='!';assert(!init());assert(!coordinator.status.secrets_retained && !phase_calls);
    setup();capture.prepared=true;assert(!init() && !phase_calls && !pauses);

    setup();assert(init());simulate_owned_attempt();reenter=true;
    assert(te_v3_coordinator_stop(&coordinator)==TE_COORD_DONE);
    assert(pauses==1 && cancels==1 && stops==1 && !coordinator.status.secrets_retained);
    assert(coordinator.status.window_retained && coordinator.status.event_retained && coordinator.status.durable_record_retained);
    assert(adapter.handoff.state==TE_HANDOFF_FROZEN && !memcmp(adapter.control_body,"old",3));
    assert(((unsigned char *)&capture.held_window)[0]==0x56 && capture.window_held && capture.event_held);
    assert(te_v3_coordinator_stop(&coordinator)==TE_COORD_DONE && pauses==1 && stops==1);

    setup();make_json(true);assert(init());simulate_owned_attempt();stop_result=ESP_FAIL;
    assert(te_v3_coordinator_stop(&coordinator)==TE_COORD_ERROR);
    assert(coordinator.status.secrets_retained && !strcmp(coordinator.transport.server_ca_pem,pem));
    stop_result=ESP_OK;assert(te_v3_coordinator_stop(&coordinator)==TE_COORD_DONE);
    assert(!coordinator.status.secrets_retained && stops==2);
    assert(te_v3_coordinator_step(&coordinator,60001)==TE_COORD_ERROR);

    setup();assert(init());simulate_owned_attempt();paused=false;
    for(unsigned i=0;i<limits.cleanup_attempts;i++)assert(te_v3_coordinator_stop(&coordinator)==TE_COORD_ERROR);
    unsigned attempts=pauses;assert(te_v3_coordinator_stop(&coordinator)==TE_COORD_ERROR && pauses==attempts);
    assert(!coordinator.status.capture_paused && coordinator.status.transport_stopped && stops==1);
    setup();assert(init());simulate_owned_attempt();pause_result=ESP_FAIL;
    assert(te_v3_coordinator_stop(&coordinator)==TE_COORD_ERROR && !coordinator.status.capture_paused);

    setup();assert(init());capability.node_id[0]='z';evidence.cpu_profile_verified=false;
    assert(!strcmp(adapter.capability->node_id,node) && adapter.capability->evidence->cpu_profile_verified);
    assert(te_v3_coordinator_step(&coordinator,60000)==TE_COORD_DENIED);
    strcpy(capability.node_id,node);evidence.cpu_profile_verified=true;

    free(evidence.pools.reports);free(evidence.pools.stats);
    puts("coordinator fail-closed/configuration/cleanup host tests passed; no runtime admission");
    return 0;
}
