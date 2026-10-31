#include "internal.h"
#include <stdio.h>
#include <string.h>

typedef cp_v3_control_workspace_t W;
static int f(W *w,int at,const char *k){return v3_field(w,at,k);}
static bool eq(W *w,int at,const char *k,const char *v){return v3_equal(w,f(w,at,k),v);}
static bool yes(W *w,int at,const char *k){return v3_is(w,f(w,at,k),V3_TRUE);}
static bool no(W *w,int at,const char *k){return v3_is(w,f(w,at,k),V3_FALSE);}
static bool u(W *w,int at,const char *k,uint64_t lo,uint64_t hi,uint64_t *out){return v3_uint(w,f(w,at,k),lo,hi,out);}
static bool n(W *w,int at,const char *k,uint64_t lo,uint64_t hi,uint32_t *out){uint64_t v;if(!u(w,at,k,lo,hi,&v))return false;*out=(uint32_t)v;return true;}
static bool shortn(W *w,int at,const char *k,uint64_t lo,uint64_t hi,uint16_t *out){uint64_t v;if(!u(w,at,k,lo,hi,&v))return false;*out=(uint16_t)v;return true;}
static bool s(W *w,int at,const char *k,char *out,size_t cap){return v3_string(w,f(w,at,k),out,cap);}
static bool date(W *w,int at,const char *k,uint64_t *out){char v[25];return s(w,at,k,v,sizeof v)&&v3_date(v,out);}
static bool id(W *w,int at,const char *k,char out[65]){return s(w,at,k,out,65)&&v3_id(out);}
static uint64_t min(uint64_t a,uint64_t b){return a<b?a:b;}
static bool valid_now(cp_v3_time_t t){return t.clock_epoch&&t.mono_ms<=V3_SAFE&&t.utc_ms>=t.uncertainty_ms&&t.utc_ms<=UINT64_C(8640000000000000)&&t.uncertainty_ms<=5000;}
static bool current(cp_v3_control_t *c,cp_v3_time_t t){if(!valid_now(t)||t.clock_epoch!=c->clock_epoch||t.mono_ms<c->last_mono_ms||t.utc_ms-t.uncertainty_ms<c->trusted_utc_lower_ms)return false;c->last_mono_ms=t.mono_ms;c->trusted_utc_lower_ms=t.utc_ms-t.uncertainty_ms;return true;}
static bool absent_or_null(W *w,int at,const char *k){int a=f(w,at,k);return a<0||v3_is(w,a,V3_NULL);}
static unsigned slice_bit(uint64_t n){return n==1000?1:n==2000?2:n==5000?4:0;}
static unsigned mode_bit(W *w,int at){return v3_equal(w,at,"off")?1:v3_equal(w,at,"terminal_only")?2:v3_equal(w,at,"revisions")?4:0;}
static bool streams(W *w,int at,bool *events){
    if(v3_array_exact(w,at,"window_statistics node_status")){*events=false;return true;}
    if(v3_array_exact(w,at,"window_statistics node_status candidate_events")){*events=true;return true;}return false;
}
bool v3_small_caps(cp_v3_control_t *c){
    W *w=c->workspace;char text[65];uint64_t ignored;
    if(!v3_fields_optional(w,0,"schema capability_id node_id boot_id producer_version policy_schemas issued_at expires_at scanner summary statistics local_raw uplink queue resources","features temporal")||
        !eq(w,0,"schema","device-capabilities/1")||!id(w,0,"capability_id",text)||!eq(w,0,"node_id",c->node_id)||!eq(w,0,"boot_id",c->boot_id)||
        !eq(w,0,"producer_version",CP_V3_SMALL_PRODUCER)||!v3_array_exact(w,f(w,0,"policy_schemas"),"device-config/3")||
        !date(w,0,"issued_at",&c->capability_issued_utc_ms)||!date(w,0,"expires_at",&c->capability_expires_utc_ms)||
        c->capability_issued_utc_ms>=c->capability_expires_utc_ms||!absent_or_null(w,0,"features"))return false;
    int a=f(w,0,"scanner"),b;
    if(!v3_fields(w,a,"modes phys duplicate_filter min_interval_units max_interval_units")||!v3_array_exact(w,f(w,a,"modes"),"passive")||
        !v3_array_exact(w,f(w,a,"phys"),"1m")||!n(w,a,"min_interval_units",4,16384,&c->capability_interval_min)||
        !n(w,a,"max_interval_units",c->capability_interval_min,16384,&c->capability_interval_max))return false;
    b=f(w,a,"duplicate_filter");if(!v3_is(w,b,V3_ARRAY))return false;b=w->tokens[b].first;
    if(b==V3_NONE||!v3_is(w,b,V3_FALSE)||w->tokens[b].next!=V3_NONE)return false;
    a=f(w,0,"summary");if(!v3_fields(w,a,"max_addresses max_bins max_window_ms")||!n(w,a,"max_addresses",1,512,&c->capability_addresses)||
        !n(w,a,"max_bins",1,12,&c->capability_bins)||!n(w,a,"max_window_ms",30000,60000,&c->capability_window_ms))return false;
    a=f(w,0,"statistics");if(!v3_fields(w,a,"schemas extractor_versions ruleset_versions")||!v3_array_exact(w,f(w,a,"schemas"),"window-statistics/1")||
        !v3_array_exact(w,f(w,a,"extractor_versions"),"cp-v3-stats/1")||!v3_array_exact(w,f(w,a,"ruleset_versions"),"unclassified-v1"))return false;
    if(!absent_or_null(w,0,"temporal")){
        a=f(w,0,"temporal");cp_v3_control_temporal_t *t=&c->temporal_cap;
        if(!v3_fields(w,a,"slice_ms max_history_ms max_tracks max_open_events max_event_ms event_schemas report_modes")||
            !n(w,a,"max_history_ms",1000,600000,&t->history_ms)||!shortn(w,a,"max_tracks",1,512,&t->max_tracks)||
            !shortn(w,a,"max_open_events",1,t->max_tracks,&t->max_open_events)||!n(w,a,"max_event_ms",1000,86400000,&t->max_event_ms))return false;
        b=f(w,a,"slice_ms");if(!v3_is(w,b,V3_ARRAY))return false;
        for(uint16_t i=w->tokens[b].first;i!=V3_NONE;i=w->tokens[i].next){uint64_t value;unsigned bit;
            if(!v3_uint(w,i,1000,5000,&value)||!(bit=slice_bit(value))||(c->capability_slices&bit))return false;
            c->capability_slices|=(uint8_t)bit;}
        b=f(w,a,"report_modes");if(!v3_is(w,b,V3_ARRAY))return false;
        for(uint16_t i=w->tokens[b].first;i!=V3_NONE;i=w->tokens[i].next){unsigned bit=mode_bit(w,i);if(!bit||(c->capability_report_modes&bit))return false;c->capability_report_modes|=(uint8_t)bit;}
        if(!c->capability_slices||!c->capability_report_modes||!v3_array_exact(w,f(w,a,"event_schemas"),"candidate-event/1"))return false;
        c->capability_temporal=true;
    }
    a=f(w,0,"local_raw");if(!v3_is(w,a,V3_NULL)){
        if(!v3_fields(w,a,"formats max_segment_bytes min_sync_interval_ms")||!v3_array_exact(w,f(w,a,"formats"),"cpraw/1")||
            !u(w,a,"max_segment_bytes",1,V3_BYTES_MAX,&c->capability_raw_segment_bytes)||!n(w,a,"min_sync_interval_ms",100,60000,&c->capability_raw_sync_ms))return false;
        c->capability_local_raw=true;}
    a=f(w,0,"uplink");c->capability_mqtt_tls=v3_array_exact(w,f(w,a,"transports"),"mqtt_tls");
    if(!v3_fields(w,a,"transports streams max_batch_items max_body_bytes max_sample_reports_per_window cpraw_archive")||
        (!c->capability_mqtt_tls&&!v3_array_exact(w,f(w,a,"transports"),"https"))||!streams(w,f(w,a,"streams"),&c->capability_events)||!u(w,a,"max_batch_items",1,1,&ignored)||
        !n(w,a,"max_body_bytes",512,4096,&c->capability_body_bytes)||!u(w,a,"max_sample_reports_per_window",0,0,&ignored)||!no(w,a,"cpraw_archive"))return false;
    a=f(w,0,"queue");if(!v3_fields(w,a,"media")||!v3_is(w,f(w,a,"media"),V3_ARRAY))return false;a=w->tokens[f(w,a,"media")].first;
    if(a==V3_NONE||w->tokens[a].next!=V3_NONE||!v3_fields(w,a,"medium usable_bytes max_items power_loss_recovery"))return false;
    c->capability_tf_queue=eq(w,a,"medium","tf_journal");if(!c->capability_tf_queue&&!eq(w,a,"medium","flash_journal"))return false;
    if(!u(w,a,"usable_bytes",1,V3_BYTES_MAX,&c->capability_queue_bytes)||!n(w,a,"max_items",1,1000000,&c->capability_queue_items)||!yes(w,a,"power_loss_recovery"))return false;
    a=f(w,0,"resources");if(!v3_fields(w,a,"max_working_bytes max_storage_write_bytes_per_day tf_usable_bytes")||
        !u(w,a,"max_working_bytes",1,V3_BYTES_MAX,&c->capability_working_bytes)||!u(w,a,"max_storage_write_bytes_per_day",0,V3_BYTES_MAX,&c->capability_write_bytes))return false;
    if(v3_is(w,f(w,a,"tf_usable_bytes"),V3_NULL)){if(c->capability_tf_queue||c->capability_local_raw)return false;}
    else if(!u(w,a,"tf_usable_bytes",0,V3_BYTES_MAX,&c->capability_tf_bytes)||(c->capability_tf_queue&&c->capability_queue_bytes>c->capability_tf_bytes))return false;
    c->small_statistics=true;return true;
}

bool v3_small_policy(cp_v3_control_t *c,int root,cp_v3_trial_policy_t *p){
    W *w=c->workspace;uint64_t ignored;memset(p,0,sizeof *p);p->statistics=true;
    if(!v3_fields(w,root,"schema protocol policy_id node_id revision assignment_generation collection local_raw evidence temporal uplink local_queue resources custody control")||
        !eq(w,root,"schema","device-config/3")||!eq(w,root,"protocol","campuspulse/3")||!id(w,root,"policy_id",p->scope.policy_id)||!eq(w,root,"node_id",c->node_id)||
        !u(w,root,"revision",1,V3_SAFE,&ignored)||!u(w,root,"assignment_generation",1,V3_SAFE,&p->scope.assignment_generation))return false;
    strcpy(p->scope.node_id,c->node_id);strcpy(p->scope.boot_id,c->boot_id);
    int a=f(w,root,"collection"),b;if(!v3_fields(w,a,"enabled mode scan summary")||!yes(w,a,"enabled"))return false;
    p->collection_enabled=true;p->mobile_research=eq(w,a,"mode","mobile_research");if(!p->mobile_research&&!eq(w,a,"mode","fixed_point"))return false;
    b=f(w,a,"scan");if(!v3_fields(w,b,"mode interval_units window_units duplicate_filter phys")||!eq(w,b,"mode","passive")||!no(w,b,"duplicate_filter")||
        !v3_array_exact(w,f(w,b,"phys"),"1m")||!n(w,b,"interval_units",c->capability_interval_min,c->capability_interval_max,&p->scan_interval_units)||
        !n(w,b,"window_units",4,p->scan_interval_units,&p->scan_window_units))return false;
    b=f(w,a,"summary");if(!v3_fields(w,b,"enabled window_ms bin_ms max_addresses")||!yes(w,b,"enabled")||
        !n(w,b,"window_ms",30000,c->capability_window_ms,&p->window_ms)||(p->window_ms!=30000&&p->window_ms!=60000)||
        !n(w,b,"bin_ms",5000,5000,&p->bin_ms)||p->window_ms/p->bin_ms>c->capability_bins||
        !shortn(w,b,"max_addresses",1,c->capability_addresses,&p->stats_max_addresses))return false;
    a=f(w,root,"evidence");if(!v3_fields(w,a,"mode schema extractor_version ruleset_version")||!eq(w,a,"mode","statistics")||
        !eq(w,a,"schema","window-statistics/1")||!eq(w,a,"extractor_version","cp-v3-stats/1")||!eq(w,a,"ruleset_version","unclassified-v1"))return false;
    a=f(w,root,"local_raw");if(eq(w,a,"mode","off")){if(!v3_fields(w,a,"mode"))return false;}
    else {cp_v3_control_raw_t *r=&p->local_raw;
        if(!c->capability_local_raw||!eq(w,a,"mode","tf_cpraw")||!v3_fields(w,a,"mode format max_segment_bytes max_total_bytes min_free_bytes sync_interval_ms full_behavior")||
            !eq(w,a,"format","cpraw/1")||!eq(w,a,"full_behavior","stop_recording")||!u(w,a,"max_total_bytes",1,c->capability_tf_bytes,&r->max_total_bytes)||
            !u(w,a,"max_segment_bytes",1,min(r->max_total_bytes,c->capability_raw_segment_bytes),&r->max_segment_bytes)||
            !u(w,a,"min_free_bytes",0,c->capability_tf_bytes,&r->min_free_bytes)||!n(w,a,"sync_interval_ms",c->capability_raw_sync_ms,60000,&r->sync_interval_ms)||
            r->max_total_bytes+r->min_free_bytes>c->capability_tf_bytes)return false;
        r->enabled=true;}
    a=f(w,root,"temporal");cp_v3_control_temporal_t *t=&p->temporal;
    if(eq(w,a,"mode","off")){if(!v3_fields(w,a,"mode"))return false;}
    else {
        if(!c->capability_temporal||!eq(w,a,"mode","rolling")||!v3_fields(w,a,"mode slice_ms history_ms max_tracks max_open_events max_event_ms gap_ms report_mode min_update_ms")||
            !n(w,a,"slice_ms",1000,5000,&t->slice_ms)||!(slice_bit(t->slice_ms)&c->capability_slices)||
            !n(w,a,"history_ms",t->slice_ms,c->temporal_cap.history_ms,&t->history_ms)||t->history_ms%t->slice_ms||
            !shortn(w,a,"max_tracks",1,c->temporal_cap.max_tracks,&t->max_tracks)||!shortn(w,a,"max_open_events",1,min(t->max_tracks,c->temporal_cap.max_open_events),&t->max_open_events)||
            !n(w,a,"max_event_ms",t->slice_ms,c->temporal_cap.max_event_ms,&t->max_event_ms)||!n(w,a,"gap_ms",t->slice_ms,t->max_event_ms,&t->gap_ms)||
            !n(w,a,"min_update_ms",t->slice_ms,86400000,&t->min_update_ms))return false;
        unsigned mode=mode_bit(w,f(w,a,"report_mode"));if(!(mode&c->capability_report_modes))return false;
        t->report_mode=mode==1?CP_V3_TEMPORAL_REPORT_OFF:mode==2?CP_V3_TEMPORAL_REPORT_TERMINAL:CP_V3_TEMPORAL_REPORT_REVISIONS;t->rolling=true;
    }
    a=f(w,root,"uplink");p->mqtt_tls=eq(w,a,"transport","mqtt_tls");
    if(!v3_fields(w,a,"enabled transport streams max_batch_items max_body_bytes retry raw_sample archive")||!yes(w,a,"enabled")||
        (!p->mqtt_tls&&!eq(w,a,"transport","https"))||p->mqtt_tls!=c->capability_mqtt_tls||!streams(w,f(w,a,"streams"),&p->candidate_events)||(p->candidate_events&&!c->capability_events)||
        !u(w,a,"max_batch_items",1,1,&ignored)||!n(w,a,"max_body_bytes",512,c->capability_body_bytes,&p->max_body_bytes))return false;
    if(p->candidate_events!= (t->rolling&&t->report_mode!=CP_V3_TEMPORAL_REPORT_OFF))return false;
    b=f(w,a,"raw_sample");if(!v3_fields(w,b,"mode")||!eq(w,b,"mode","off"))return false;
    b=f(w,a,"archive");if(!v3_fields(w,b,"mode")||!eq(w,b,"mode","off"))return false;
    b=f(w,a,"retry");if(!v3_fields(w,b,"min_delay_ms max_delay_ms max_attempts")||!n(w,b,"min_delay_ms",1000,3600000,&p->retry_min_ms)||
        !n(w,b,"max_delay_ms",p->retry_min_ms,86400000,&p->retry_max_ms)||!n(w,b,"max_attempts",1,100,&p->retry_max_attempts))return false;
    a=f(w,root,"local_queue");if(!v3_fields(w,a,"mode medium max_bytes max_items control_reserve_bytes control_reserve_items stream_reserves high_water_percent full_behavior recovery")||
        !eq(w,a,"mode","durable")||!eq(w,a,"medium",c->capability_tf_queue?"tf_journal":"flash_journal")||!eq(w,a,"full_behavior","pause_collection")||
        !eq(w,a,"recovery","exact_frozen_batches")||!u(w,a,"max_bytes",1,c->capability_queue_bytes,&p->queue_max_bytes)||
        !n(w,a,"max_items",1,c->capability_queue_items,&p->queue_max_items)||!u(w,a,"control_reserve_bytes",512,V3_BYTES_MAX,&p->control_reserve_bytes)||
        !n(w,a,"control_reserve_items",1,1000000,&p->control_reserve_items)||!n(w,a,"high_water_percent",1,99,&p->high_water_percent))return false;
    p->tf_queue=c->capability_tf_queue;b=f(w,a,"stream_reserves");if(!v3_is(w,b,V3_ARRAY))return false;unsigned found=0;
    for(uint16_t i=w->tokens[b].first;i!=V3_NONE;i=w->tokens[i].next){unsigned bit;uint64_t *bytes;uint32_t *items;
        if(!v3_fields(w,i,"stream bytes items"))return false;
        if(eq(w,i,"stream","window_statistics")){bit=1;bytes=&p->window_reserve_bytes;items=&p->window_reserve_items;}
        else if(eq(w,i,"stream","node_status")){bit=2;bytes=&p->status_reserve_bytes;items=&p->status_reserve_items;}
        else if(eq(w,i,"stream","candidate_events")){bit=4;bytes=&p->event_reserve_bytes;items=&p->event_reserve_items;}else return false;
        if((found&bit)||!u(w,i,"bytes",p->max_body_bytes,V3_BYTES_MAX,bytes)||!n(w,i,"items",1,1000000,items))return false;
        found|=bit;}
    if(found!=(p->candidate_events?7u:3u)||p->control_reserve_bytes+p->window_reserve_bytes+p->event_reserve_bytes+p->status_reserve_bytes>p->queue_max_bytes||
        (uint64_t)p->control_reserve_items+p->window_reserve_items+p->event_reserve_items+p->status_reserve_items>p->queue_max_items)return false;
    if(p->tf_queue&&p->local_raw.enabled&&p->queue_max_bytes+p->local_raw.max_total_bytes+p->local_raw.min_free_bytes>c->capability_tf_bytes)return false;
    a=f(w,root,"resources");if(!v3_fields(w,a,"working_bytes storage_write_bytes_per_day")||!u(w,a,"working_bytes",1,c->capability_working_bytes,&p->working_bytes)||
        !u(w,a,"storage_write_bytes_per_day",1,c->capability_write_bytes,&p->storage_write_bytes_per_day))return false;
    if(t->rolling&&((uint64_t)t->max_tracks*((uint64_t)(t->history_ms/t->slice_ms)*24+64)+(uint64_t)t->max_open_events*128)>p->working_bytes)return false;
    a=f(w,root,"custody");if(!v3_fields(w,a,"dataset purpose placement_id association_scope source_retention_hours derived_retention_hours accept_until max_upload_bytes_per_day")||
        !s(w,a,"dataset",p->scope.dataset,sizeof p->scope.dataset)||
        !((eq(w,a,"dataset","controlled_test")&&eq(w,a,"purpose","controlled_test"))||(eq(w,a,"dataset","field")&&eq(w,a,"purpose","site_observation"))||(eq(w,a,"dataset","demo")&&eq(w,a,"purpose","demonstration")))||
        !id(w,a,"placement_id",p->scope.placement_id)||!eq(w,a,"association_scope","window")||!n(w,a,"source_retention_hours",1,168,&p->source_retention_hours)||
        !n(w,a,"derived_retention_hours",1,p->source_retention_hours,&p->derived_retention_hours)||!date(w,a,"accept_until",&p->accept_until_utc_ms)||
        !u(w,a,"max_upload_bytes_per_day",p->max_body_bytes,V3_BYTES_MAX,&p->max_upload_bytes_per_day))return false;
    a=f(w,root,"control");if(!v3_fields(w,a,"capability_sha256 activation lease")||!eq(w,a,"capability_sha256",c->capability_sha256))return false;
    b=f(w,a,"activation");if(!v3_fields(w,b,"boot_id boundary after_window_seq after_segment_seq not_before expires_at")||!eq(w,b,"boot_id",c->boot_id)||
        !eq(w,b,"boundary","closed_window_and_segment")||!n(w,b,"after_window_seq",0,UINT32_MAX-1,&p->after_window_seq)||
        !n(w,b,"after_segment_seq",0,UINT32_MAX,&p->after_segment_seq)||!date(w,b,"not_before",&p->not_before_utc_ms)||!date(w,b,"expires_at",&p->expires_utc_ms)||
        p->not_before_utc_ms>=p->expires_utc_ms||p->expires_utc_ms>p->accept_until_utc_ms)return false;
    b=f(w,a,"lease");if(!v3_fields(w,b,"duration_ms on_collection_expiry on_raw_expiry on_uplink_expiry")||!n(w,b,"duration_ms",30000,86400000,&p->lease_ms)||
        p->lease_ms<=p->window_ms||!eq(w,b,"on_collection_expiry","pause")||!eq(w,b,"on_raw_expiry","stop_recording")||!eq(w,b,"on_uplink_expiry","drain_frozen_until_accept_until"))return false;
    p->drain_frozen=true;p->scope.window_seq=p->after_window_seq+1;return true;
}

typedef struct {
    bool lease,applied,window_open,segment_open;
    uint32_t seq,window,segment;
    uint64_t uptime;
    char error[32];
} request_t;
static bool identity(W *w,const cp_v3_scope_t *p){return eq(w,0,"protocol","campuspulse/3")&&eq(w,0,"boot_id",p->boot_id)&&
    eq(w,0,"policy_id",p->policy_id)&&eq(w,0,"policy_sha256",p->policy_sha256)&&u(w,0,"assignment_generation",p->assignment_generation,p->assignment_generation,NULL);}
static bool error_valid(const char *s){return !strcmp(s,"unsupported_config")||!strcmp(s,"boundary_failed")||!strcmp(s,"resource_exhausted")||!strcmp(s,"storage_failed")||!strcmp(s,"internal_error");}
static bool request(W *w,const cp_v3_scope_t *scope,const void *json,size_t length,request_t *r){
    memset(r,0,sizeof *r);if(!v3_parse(w,json,length)||!identity(w,scope))return false;
    r->lease=f(w,0,"contact_seq")>=0;
    if(r->lease)return v3_fields(w,0,"protocol boot_id policy_id policy_sha256 assignment_generation contact_seq uptime_ms")&&
        n(w,0,"contact_seq",1,UINT32_MAX,&r->seq)&&u(w,0,"uptime_ms",0,V3_SAFE,&r->uptime);
    r->applied=eq(w,0,"state","applied");
    if(!v3_fields(w,0,r->applied?"protocol boot_id policy_id policy_sha256 assignment_generation apply_seq state closed_window_seq closed_segment_seq window_open segment_open":
        "protocol boot_id policy_id policy_sha256 assignment_generation apply_seq state closed_window_seq closed_segment_seq window_open segment_open error_code")||
        (!r->applied&&(!eq(w,0,"state","failed")||!s(w,0,"error_code",r->error,sizeof r->error)||!error_valid(r->error)))||
        !n(w,0,"apply_seq",1,UINT32_MAX,&r->seq)||!n(w,0,"closed_window_seq",0,UINT32_MAX,&r->window)||!n(w,0,"closed_segment_seq",0,UINT32_MAX,&r->segment)||
        (!yes(w,0,"window_open")&&!no(w,0,"window_open"))||(!yes(w,0,"segment_open")&&!no(w,0,"segment_open")))return false;
    r->window_open=yes(w,0,"window_open");r->segment_open=yes(w,0,"segment_open");return !r->applied||(!r->window_open&&!r->segment_open);
}
cp_v3_control_result_t cp_v3_control_match_frozen_receipt(W *w,const cp_v3_scope_t *scope,const void *body,size_t body_length,
    const void *json,size_t length,cp_v3_sha256_fn sha,void *context){
    request_t r;char digest[65];uint64_t at,server,deadline;
    if(!w||!scope||!v3_id(scope->node_id)||!v3_uuid(scope->boot_id)||!v3_id(scope->policy_id)||!v3_hash_string(scope->policy_sha256)||
        !scope->assignment_generation||scope->assignment_generation>V3_SAFE||!request(w,scope,body,body_length,&r)||
        !v3_body_hash(sha,context,body,body_length,digest))return CP_V3_CONTROL_INVALID;
    if(!v3_parse(w,json,length)||!identity(w,scope)||!eq(w,0,"node_id",scope->node_id)||!eq(w,0,"body_sha256",digest)||!eq(w,0,"durability","committed"))return CP_V3_CONTROL_BINDING_MISMATCH;
    if(r.lease){
        if(!v3_fields(w,0,"protocol schema node_id boot_id policy_id policy_sha256 assignment_generation contact_seq uptime_ms body_sha256 durability server_time lease_until_ms span_seq contiguous")||
            !eq(w,0,"schema","device-lease/3")||!u(w,0,"contact_seq",r.seq,r.seq,NULL)||!u(w,0,"uptime_ms",r.uptime,r.uptime,NULL)||
            !date(w,0,"server_time",&server)||!u(w,0,"lease_until_ms",server+1,V3_SAFE,&deadline)||!u(w,0,"span_seq",1,UINT32_MAX,NULL)||
            (!yes(w,0,"contiguous")&&!no(w,0,"contiguous")))return CP_V3_CONTROL_BINDING_MISMATCH;
    }else {
        const char *names=r.applied?
            "protocol boot_id policy_id policy_sha256 assignment_generation apply_seq state closed_window_seq closed_segment_seq window_open segment_open node_id received_at durability evidence body_sha256 server_time lease_until_ms contact_seq":
            "protocol boot_id policy_id policy_sha256 assignment_generation apply_seq state closed_window_seq closed_segment_seq window_open segment_open error_code node_id received_at durability evidence body_sha256";
        if(!v3_fields(w,0,names)||!u(w,0,"apply_seq",r.seq,r.seq,NULL)||!eq(w,0,"state",r.applied?"applied":"failed")||
            (!r.applied&&!eq(w,0,"error_code",r.error))||!u(w,0,"closed_window_seq",r.window,r.window,NULL)||!u(w,0,"closed_segment_seq",r.segment,r.segment,NULL)||
            !v3_is(w,f(w,0,"window_open"),r.window_open?V3_TRUE:V3_FALSE)||!v3_is(w,f(w,0,"segment_open"),r.segment_open?V3_TRUE:V3_FALSE)||
            !eq(w,0,"evidence","device_ack")||!date(w,0,"received_at",&at))return CP_V3_CONTROL_BINDING_MISMATCH;
        if(r.applied&&(!date(w,0,"server_time",&server)||!u(w,0,"lease_until_ms",server+1,V3_SAFE,&deadline)||!u(w,0,"contact_seq",0,0,NULL)))return CP_V3_CONTROL_BINDING_MISMATCH;
    }
    return CP_V3_CONTROL_OK;
}
static bool deadline_valid(cp_v3_control_t *c,uint64_t server,uint64_t deadline,cp_v3_time_t now){
    return server>=c->policy.not_before_utc_ms&&server>=c->capability_issued_utc_ms&&server<=now.utc_ms+now.uncertainty_ms&&
        deadline>server&&deadline<=server+c->policy.lease_ms&&deadline<=c->policy.expires_utc_ms&&
        deadline<=c->capability_expires_utc_ms&&deadline<=c->policy.accept_until_utc_ms;
}
static void set_deadline(cp_v3_control_t *c,uint64_t server,uint64_t deadline,cp_v3_time_t now){
    c->lease_server_utc_ms=server;c->deadline_utc_ms=deadline;uint64_t upper=now.utc_ms+now.uncertainty_ms;
    c->deadline_mono_ms=v3_deadline_mono(now,deadline);
    c->trusted_utc_lower_ms=now.utc_ms-now.uncertainty_ms;
    c->state=deadline>upper?CP_V3_CONTROL_APPLIED:CP_V3_CONTROL_PAUSED;
}
cp_v3_control_result_t v3_small_ack_receipt(cp_v3_control_t *c,const void *json,size_t length,cp_v3_time_t now){
    cp_v3_control_result_t result=cp_v3_control_match_frozen_receipt(c->workspace,&c->policy.scope,c->acknowledgement_json,c->acknowledgement_length,json,length,c->sha256,c->hash_context);
    if(result!=CP_V3_CONTROL_OK)return result;
    W *w=c->workspace;uint64_t at;date(w,0,"received_at",&at);
    if(at<c->capability_issued_utc_ms||at>now.utc_ms+now.uncertainty_ms||(c->acknowledged_at_utc_ms&&c->acknowledged_at_utc_ms!=at))return CP_V3_CONTROL_BINDING_MISMATCH;
    if(c->apply_result!=CP_V3_APPLY_OK){c->acknowledged_at_utc_ms=at;c->state=CP_V3_CONTROL_FAILED;return CP_V3_CONTROL_OK;}
    uint64_t server,deadline;date(w,0,"server_time",&server);u(w,0,"lease_until_ms",0,V3_SAFE,&deadline);
    if(server<at||!deadline_valid(c,server,deadline,now)||deadline-server<=c->policy.window_ms)return CP_V3_CONTROL_NOT_CURRENT;
    if(c->applied_at_utc_ms)return c->applied_at_utc_ms==server?CP_V3_CONTROL_OK:CP_V3_CONTROL_BINDING_MISMATCH;
    c->acknowledged_at_utc_ms=at;c->applied_at_utc_ms=server;c->capture_span_start_utc_ms=server;c->span_seq=1;c->lease_contiguous=false;c->last_applied_generation=c->policy.scope.assignment_generation;
    set_deadline(c,server,deadline,now);return CP_V3_CONTROL_OK;
}
cp_v3_control_result_t cp_v3_control_lease_request(cp_v3_control_t *c,uint32_t seq,uint64_t uptime,const char **bytes,size_t *length){
    if(bytes)*bytes=NULL;
    if(length)*length=0;
    if(!c||!bytes||!length||!c->small_statistics||!c->applied_at_utc_ms||!seq||uptime>V3_SAFE||
        (c->state!=CP_V3_CONTROL_APPLIED&&c->state!=CP_V3_CONTROL_PAUSED))return CP_V3_CONTROL_STATE;
    if(c->lease_pending||seq==c->contact_seq){if(seq!=c->pending_contact_seq||uptime!=c->pending_uptime_ms||!c->lease_length)return CP_V3_CONTROL_STATE;}
    else {
        if(seq<=c->contact_seq||uptime<c->contact_uptime_ms||uptime<c->last_mono_ms)return CP_V3_CONTROL_STATE;
        int n=snprintf(c->lease_json,sizeof c->lease_json,"{\"protocol\":\"campuspulse/3\",\"boot_id\":\"%s\",\"policy_id\":\"%s\",\"policy_sha256\":\"%s\",\"assignment_generation\":%llu,\"contact_seq\":%u,\"uptime_ms\":%llu}",
            c->boot_id,c->policy.scope.policy_id,c->policy.scope.policy_sha256,(unsigned long long)c->policy.scope.assignment_generation,(unsigned)seq,(unsigned long long)uptime);
        if(n<0||(size_t)n>=sizeof c->lease_json)return CP_V3_CONTROL_RESOURCE;
        c->lease_length=(size_t)n;c->pending_contact_seq=seq;c->pending_uptime_ms=uptime;c->lease_pending=true;
    }
    *bytes=c->lease_json;*length=c->lease_length;return CP_V3_CONTROL_OK;
}
cp_v3_control_result_t cp_v3_control_lease_receipt(cp_v3_control_t *c,const void *json,size_t length,cp_v3_time_t now){
    if(!c||!c->small_statistics||!c->applied_at_utc_ms||!c->lease_length||!current(c,now)||now.mono_ms<c->pending_uptime_ms)return CP_V3_CONTROL_STATE;
    cp_v3_control_result_t result=cp_v3_control_match_frozen_receipt(c->workspace,&c->policy.scope,c->lease_json,c->lease_length,json,length,c->sha256,c->hash_context);
    if(result!=CP_V3_CONTROL_OK)return result;
    W *w=c->workspace;uint64_t server,deadline;uint32_t span;date(w,0,"server_time",&server);u(w,0,"lease_until_ms",0,V3_SAFE,&deadline);n(w,0,"span_seq",1,UINT32_MAX,&span);bool contiguous=yes(w,0,"contiguous");
    if(!deadline_valid(c,server,deadline,now))return CP_V3_CONTROL_NOT_CURRENT;
    if(c->pending_contact_seq==c->contact_seq)return server==c->lease_server_utc_ms&&deadline==c->deadline_utc_ms&&span==c->span_seq&&contiguous==c->lease_contiguous?CP_V3_CONTROL_OK:CP_V3_CONTROL_BINDING_MISMATCH;
    if(!c->lease_pending||server<c->lease_server_utc_ms||deadline<c->deadline_utc_ms||
        (contiguous?(span!=c->span_seq||server>c->deadline_utc_ms):(c->span_seq==UINT32_MAX||span!=c->span_seq+1||server<=c->deadline_utc_ms)))return CP_V3_CONTROL_BINDING_MISMATCH;
    if(!contiguous)c->capture_span_start_utc_ms=server;
    c->span_seq=span;c->lease_contiguous=contiguous;c->contact_seq=c->pending_contact_seq;c->contact_uptime_ms=c->pending_uptime_ms;c->lease_pending=false;
    set_deadline(c,server,deadline,now);return CP_V3_CONTROL_OK;
}
cp_v3_control_result_t cp_v3_control_stage(cp_v3_control_t *c,cp_v3_control_t *candidate,const void *json,size_t length,cp_v3_time_t now){
    if(!c||!candidate||c==candidate||!c->small_statistics||!c->policy_length||c->state==CP_V3_CONTROL_ACK_PENDING||!current(c,now))return CP_V3_CONTROL_STATE;
    *candidate=*c;candidate->policy_length=0;candidate->state=CP_V3_CONTROL_REGISTERED;candidate->staged_from_generation=c->policy.scope.assignment_generation;
    candidate->acknowledgement_length=0;candidate->acknowledged_at_utc_ms=0;candidate->applied_at_utc_ms=0;candidate->deadline_utc_ms=0;candidate->deadline_mono_ms=0;
    candidate->lease_length=0;candidate->lease_pending=false;candidate->contact_seq=0;candidate->pending_contact_seq=0;candidate->span_seq=0;
    /* Config GET includes previous applied_generation; offer requires a locally
     * held old policy for that check. Validate its presence against c separately. */
    W *w=c->workspace;uint64_t generation;
    if(!v3_parse(w,json,length))return CP_V3_CONTROL_INVALID;
    if(!v3_is(w,f(w,0,"applied_generation"),V3_NULL)&&(!c->last_applied_generation||!u(w,0,"applied_generation",c->last_applied_generation,c->last_applied_generation,&generation)))return CP_V3_CONTROL_STATE;
    /* offer's generation guard recognizes staged candidates by retained apply_seq. */
    cp_v3_control_result_t result=cp_v3_control_offer(candidate,json,length,now);
    if(result!=CP_V3_CONTROL_OK&&result!=CP_V3_CONTROL_WAIT)return result;
    if(candidate->policy.scope.assignment_generation<=c->policy.scope.assignment_generation){candidate->state=CP_V3_CONTROL_EMPTY;return CP_V3_CONTROL_STATE;}
    return result;
}
cp_v3_control_result_t cp_v3_control_activate_staged(cp_v3_control_t *c,cp_v3_control_t *candidate,cp_v3_time_t now,cp_v3_boundary_t boundary,uint32_t seq,cp_v3_actual_apply_fn apply,void *ctx){
    if(!c||!candidate||c==candidate||!c->small_statistics||!candidate->small_statistics||strcmp(c->node_id,candidate->node_id)||strcmp(c->boot_id,candidate->boot_id)||
        strcmp(c->capability_sha256,candidate->capability_sha256)||candidate->policy.scope.assignment_generation<=c->policy.scope.assignment_generation||seq<=c->apply_seq||
        boundary.window_open||boundary.segment_open||boundary.closed_window_seq<c->acknowledgement_boundary.closed_window_seq||boundary.closed_segment_seq<c->acknowledgement_boundary.closed_segment_seq||!current(c,now))return CP_V3_CONTROL_BOUNDARY;
    cp_v3_control_result_t result=cp_v3_control_apply(candidate,now,boundary,seq,apply,ctx);
    if(result==CP_V3_CONTROL_OK){*c=*candidate;candidate->state=CP_V3_CONTROL_EMPTY;}
    return result;
}
cp_v3_control_result_t cp_v3_control_clock_boundary(cp_v3_control_t *c,cp_v3_time_t now,cp_v3_boundary_t boundary){
    if(!c||!c->small_statistics)return CP_V3_CONTROL_UNSUPPORTED;
    if(!valid_now(now)||now.clock_epoch<=c->clock_epoch||now.mono_ms<c->last_mono_ms||now.utc_ms-now.uncertainty_ms<c->trusted_utc_lower_ms||
        boundary.window_open||boundary.segment_open||boundary.closed_window_seq<c->acknowledgement_boundary.closed_window_seq||boundary.closed_segment_seq<c->acknowledgement_boundary.closed_segment_seq){c->state=CP_V3_CONTROL_PAUSED;return CP_V3_CONTROL_BOUNDARY;}
    c->clock_epoch=now.clock_epoch;c->last_mono_ms=now.mono_ms;c->trusted_utc_lower_ms=now.utc_ms-now.uncertainty_ms;
    if(c->applied_at_utc_ms){bool paused=c->state!=CP_V3_CONTROL_APPLIED;set_deadline(c,c->lease_server_utc_ms,c->deadline_utc_ms,now);if(paused)c->state=CP_V3_CONTROL_PAUSED;}
    return CP_V3_CONTROL_OK;
}
