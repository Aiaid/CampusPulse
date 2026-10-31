#include "internal.h"
#include <stdio.h>
#include <string.h>

typedef cp_v3_control_workspace_t W;
static int f(W *w,int at,const char *key){return v3_field(w,at,key);}
static bool eq(W *w,int at,const char *key,const char *value){return v3_equal(w,f(w,at,key),value);}
static bool yes(W *w,int at,const char *key){return v3_is(w,f(w,at,key),V3_TRUE);}
static bool no(W *w,int at,const char *key){return v3_is(w,f(w,at,key),V3_FALSE);}
static bool u(W *w,int at,const char *key,uint64_t min,uint64_t max,uint64_t *out){return v3_uint(w,f(w,at,key),min,max,out);}
static bool small(W *w,int at,const char *key,uint64_t min,uint64_t max,uint32_t *out){uint64_t n;if(!u(w,at,key,min,max,&n))return false;*out=(uint32_t)n;return true;}
static bool s(W *w,int at,const char *key,char *out,size_t cap){return v3_string(w,f(w,at,key),out,cap);}
static bool date(W *w,int at,const char *key,uint64_t *out){char text[25];return s(w,at,key,text,sizeof text)&&v3_date(text,out);}
static bool ident(W *w,int at,const char *key,char out[65]){return s(w,at,key,out,65)&&v3_id(out);}
static uint64_t minimum(uint64_t a,uint64_t b){return a<b?a:b;}
static bool now_valid(cp_v3_time_t now){return now.mono_ms<=V3_SAFE&&now.utc_ms>=now.uncertainty_ms&&now.utc_ms<=UINT64_C(8640000000000000)&&now.uncertainty_ms<=5000;}
uint64_t v3_deadline_mono(cp_v3_time_t now,uint64_t deadline) {
    if(!now_valid(now))return now.mono_ms;
    uint64_t upper=now.utc_ms+now.uncertainty_ms;
    if(deadline<=upper||deadline-upper<=1)return now.mono_ms;
    /* For R=deadline-upper, d=floor((R-1)*2000/2001) guarantees
     * d+ceil(d/2000)<R. Decompose multiplication to avoid uint64 overflow. */
    uint64_t remaining=deadline-upper-1;
    uint64_t delta=(remaining/2001)*2000+(remaining%2001)*2000/2001;
    if(delta>V3_SAFE-now.mono_ms)delta=V3_SAFE-now.mono_ms;
    return now.mono_ms+delta;
}
static bool current(cp_v3_control_t *c,cp_v3_time_t now){
    if(!now_valid(now)||now.mono_ms<c->last_mono_ms||now.clock_epoch!=c->clock_epoch)return false;
    if(c->small_statistics&&now.utc_ms-now.uncertainty_ms<c->trusted_utc_lower_ms)return false;
    if(c->small_statistics)c->trusted_utc_lower_ms=now.utc_ms-now.uncertainty_ms;
    c->last_mono_ms=now.mono_ms;return true;
}
static bool capability_current(cp_v3_control_t *c,cp_v3_time_t now){
    return now.utc_ms-now.uncertainty_ms>=c->capability_issued_utc_ms&&now.utc_ms+now.uncertainty_ms<c->capability_expires_utc_ms;
}
static bool singleton_false(W *w,int at){return v3_is(w,at,V3_ARRAY)&&w->tokens[at].first!=V3_NONE&&v3_is(w,w->tokens[at].first,V3_FALSE)&&w->tokens[w->tokens[at].first].next==V3_NONE;}
static bool fields_set(W *w,int at,uint8_t *flags){
    if(!v3_is(w,at,V3_ARRAY))return false;
    *flags=0;
    for(uint16_t i=w->tokens[at].first;i!=V3_NONE;i=w->tokens[i].next){uint8_t bit=v3_equal(w,i,"company_ids")?CP_V3_COMPANY:v3_equal(w,i,"appearance")?CP_V3_APPEARANCE:0;
        if(!bit||(*flags&bit))return false;
        *flags|=bit;}
    return *flags!=0;
}
static bool caps(cp_v3_control_t *c){
    W *w=c->workspace;char text[65],boot[37];
    if(eq(w,0,"producer_version",CP_V3_SMALL_PRODUCER))return v3_small_caps(c);
    if(!v3_fields(w,0,"schema capability_id node_id boot_id producer_version policy_schemas issued_at expires_at scanner summary features local_raw uplink queue resources")||
        !eq(w,0,"schema","device-capabilities/1")||!ident(w,0,"capability_id",text)||!eq(w,0,"node_id",c->node_id)||
        !s(w,0,"boot_id",boot,sizeof boot)||strcmp(boot,c->boot_id)||!eq(w,0,"producer_version",CP_V3_PRODUCER)||
        !v3_array_exact(w,f(w,0,"policy_schemas"),"device-config/3")||!date(w,0,"issued_at",&c->capability_issued_utc_ms)||
        !date(w,0,"expires_at",&c->capability_expires_utc_ms)||c->capability_issued_utc_ms>=c->capability_expires_utc_ms)return false;
    int a=f(w,0,"scanner");
    if(!v3_fields(w,a,"modes phys duplicate_filter min_interval_units max_interval_units")||!v3_array_exact(w,f(w,a,"modes"),"passive")||
        !v3_array_exact(w,f(w,a,"phys"),"1m")||!singleton_false(w,f(w,a,"duplicate_filter"))||
        !small(w,a,"min_interval_units",4,16384,&c->capability_interval_min)||
        !small(w,a,"max_interval_units",c->capability_interval_min,16384,&c->capability_interval_max))return false;
    a=f(w,0,"summary");
    if(!v3_fields(w,a,"max_addresses max_bins max_window_ms")||!small(w,a,"max_addresses",1,16,&c->capability_addresses)||
        !small(w,a,"max_bins",1,60,&c->capability_bins)||!small(w,a,"max_window_ms",1000,300000,&c->capability_window_ms))return false;
    a=f(w,0,"features");
    if(!v3_fields(w,a,"schemas extractor_versions fields populations max_reports_per_window max_bytes_per_window")||
        !v3_array_exact(w,f(w,a,"schemas"),"ble-feature-evidence/1")||!v3_array_exact(w,f(w,a,"extractor_versions"),CP_V3_EXTRACTOR)||
        !fields_set(w,f(w,a,"fields"),&c->capability_fields)||!v3_array_exact(w,f(w,a,"populations"),"all_worker_reports")||
        !small(w,a,"max_reports_per_window",1,CP_V3_REPORT_LIMIT,&c->capability_reports)||
        !small(w,a,"max_bytes_per_window",1,65536,&c->capability_evidence_bytes))return false;
    a=f(w,0,"local_raw");uint64_t ignored;
    if(!v3_is(w,a,V3_NULL)&&(!v3_fields(w,a,"formats max_segment_bytes min_sync_interval_ms")||
        !v3_array_exact(w,f(w,a,"formats"),"cpraw/1")||!u(w,a,"max_segment_bytes",1,V3_BYTES_MAX,&ignored)||
        !u(w,a,"min_sync_interval_ms",100,60000,&ignored)))return false;
    a=f(w,0,"uplink");
    if(!v3_fields(w,a,"transports streams max_batch_items max_body_bytes max_sample_reports_per_window cpraw_archive")||
        !v3_array_exact(w,f(w,a,"transports"),"https")||!v3_array_exact(w,f(w,a,"streams"),"feature_summaries node_status")||
        !u(w,a,"max_batch_items",1,1,&ignored)||!u(w,a,"max_body_bytes",CP_V3_BODY_MAX,CP_V3_BODY_MAX,&ignored)||
        !u(w,a,"max_sample_reports_per_window",0,0,&ignored)||!no(w,a,"cpraw_archive"))return false;
    a=f(w,0,"queue");if(!v3_fields(w,a,"media"))return false;
    int array=f(w,a,"media");if(!v3_is(w,array,V3_ARRAY))return false;
    a=w->tokens[array].first;if(a==V3_NONE||w->tokens[a].next!=V3_NONE||!v3_fields(w,a,"medium usable_bytes max_items power_loss_recovery"))return false;
    if(eq(w,a,"medium","tf_journal"))c->capability_tf_queue=true;
    else if(!eq(w,a,"medium","flash_journal"))return false;
    if(!u(w,a,"usable_bytes",1,V3_BYTES_MAX,&c->capability_queue_bytes)||!small(w,a,"max_items",1,1000000,&c->capability_queue_items)||!yes(w,a,"power_loss_recovery"))return false;
    a=f(w,0,"resources");
    if(!v3_fields(w,a,"max_working_bytes max_storage_write_bytes_per_day tf_usable_bytes")||
        !u(w,a,"max_working_bytes",1,V3_BYTES_MAX,&c->capability_working_bytes)||
        !u(w,a,"max_storage_write_bytes_per_day",0,V3_BYTES_MAX,&c->capability_write_bytes))return false;
    if(v3_is(w,f(w,a,"tf_usable_bytes"),V3_NULL)){c->capability_tf_bytes=0;if(c->capability_tf_queue)return false;}
    else if(!u(w,a,"tf_usable_bytes",0,V3_BYTES_MAX,&c->capability_tf_bytes)||
        (c->capability_tf_queue&&c->capability_queue_bytes>c->capability_tf_bytes))return false;
    return true;
}
static bool policy(cp_v3_control_t *c,int root,cp_v3_trial_policy_t *p){
    if(c->small_statistics)return v3_small_policy(c,root,p);
    W *w=c->workspace;memset(p,0,sizeof *p);char text[65],boot[37];uint64_t number;
    if(!v3_fields(w,root,"schema protocol policy_id node_id revision assignment_generation collection local_raw evidence uplink local_queue resources custody control")||
        !eq(w,root,"schema","device-config/3")||!eq(w,root,"protocol","campuspulse/3")||
        !ident(w,root,"policy_id",p->scope.policy_id)||!eq(w,root,"node_id",c->node_id)||
        !u(w,root,"revision",1,V3_SAFE,&number)||!u(w,root,"assignment_generation",1,V3_SAFE,&p->scope.assignment_generation))return false;
    strcpy(p->scope.node_id,c->node_id);strcpy(p->scope.boot_id,c->boot_id);strcpy(p->scope.dataset,"controlled_test");
    int a=f(w,root,"collection"),b;
    if(!v3_fields(w,a,"enabled mode scan summary")||!yes(w,a,"enabled")||!eq(w,a,"mode","fixed_point"))return false;
    b=f(w,a,"scan");
    if(!v3_fields(w,b,"mode interval_units window_units duplicate_filter phys")||!eq(w,b,"mode","passive")||!no(w,b,"duplicate_filter")||
        !v3_array_exact(w,f(w,b,"phys"),"1m")||!small(w,b,"interval_units",c->capability_interval_min,c->capability_interval_max,&p->scan_interval_units)||
        !small(w,b,"window_units",4,p->scan_interval_units,&p->scan_window_units))return false;
    b=f(w,a,"summary");uint32_t addresses;
    if(!v3_fields(w,b,"enabled window_ms bin_ms max_addresses")||!yes(w,b,"enabled")||
        !small(w,b,"window_ms",1000,c->capability_window_ms,&p->evidence.window_ms)||
        !small(w,b,"bin_ms",1000,p->evidence.window_ms,&p->bin_ms)||p->evidence.window_ms%p->bin_ms||
        p->evidence.window_ms/p->bin_ms>c->capability_bins||!small(w,b,"max_addresses",1,c->capability_addresses,&addresses))return false;
    p->evidence.max_identifiers=(uint8_t)addresses;p->window_ms=p->evidence.window_ms;p->collection_enabled=true;p->max_body_bytes=4096;
    a=f(w,root,"local_raw");if(!v3_fields(w,a,"mode")||!eq(w,a,"mode","off"))return false;
    a=f(w,root,"evidence");
    if(!v3_fields(w,a,"mode schema extractor_version population sample_every_n fields max_reports_per_window max_bytes_per_window overflow")||
        !eq(w,a,"mode","features")||!eq(w,a,"schema","ble-feature-evidence/1")||!eq(w,a,"extractor_version",CP_V3_EXTRACTOR)||
        !eq(w,a,"population","all_worker_reports")||!v3_is(w,f(w,a,"sample_every_n"),V3_NULL)||
        !eq(w,a,"overflow","count_and_mark_partial")||!small(w,a,"max_reports_per_window",1,c->capability_reports,&p->evidence.max_reports)||
        !small(w,a,"max_bytes_per_window",1,c->capability_evidence_bytes,&p->evidence.max_evidence_bytes))return false;
    b=f(w,a,"fields");if(!v3_is(w,b,V3_ARRAY))return false;
    for(uint16_t i=w->tokens[b].first;i!=V3_NONE;i=w->tokens[i].next){uint8_t bit;
        if(!v3_fields(w,i,"kind max_values_per_identifier"))return false;
        if(eq(w,i,"kind","company_ids")){bit=CP_V3_COMPANY;if(!u(w,i,"max_values_per_identifier",1,4,&number))return false;p->evidence.company_limit=(uint8_t)number;}
        else if(eq(w,i,"kind","appearance")){bit=CP_V3_APPEARANCE;if(!u(w,i,"max_values_per_identifier",1,2,&number))return false;p->evidence.appearance_limit=(uint8_t)number;}
        else return false;
        if((p->evidence.fields&bit)||!(c->capability_fields&bit))return false;
        p->evidence.fields|=bit;
    }
    if(!p->evidence.fields)return false;
    a=f(w,root,"uplink");
    if(!v3_fields(w,a,"enabled transport streams max_batch_items max_body_bytes retry raw_sample archive")||!yes(w,a,"enabled")||
        !eq(w,a,"transport","https")||!v3_array_exact(w,f(w,a,"streams"),"feature_summaries node_status")||
        !u(w,a,"max_batch_items",1,1,&number)||!u(w,a,"max_body_bytes",4096,4096,&number))return false;
    b=f(w,a,"raw_sample");if(!v3_fields(w,b,"mode")||!eq(w,b,"mode","off"))return false;
    b=f(w,a,"archive");if(!v3_fields(w,b,"mode")||!eq(w,b,"mode","off"))return false;
    b=f(w,a,"retry");if(!v3_fields(w,b,"min_delay_ms max_delay_ms max_attempts")||!small(w,b,"min_delay_ms",1000,3600000,&p->retry_min_ms)||
        !small(w,b,"max_delay_ms",p->retry_min_ms,86400000,&p->retry_max_ms)||!small(w,b,"max_attempts",1,100,&p->retry_max_attempts))return false;
    a=f(w,root,"local_queue");
    if(!v3_fields(w,a,"mode medium max_bytes max_items control_reserve_bytes control_reserve_items stream_reserves high_water_percent full_behavior recovery")||
        !eq(w,a,"mode","durable")||!eq(w,a,"medium",c->capability_tf_queue?"tf_journal":"flash_journal")||
        !eq(w,a,"full_behavior","pause_collection")||!eq(w,a,"recovery","exact_frozen_batches")||
        !u(w,a,"max_bytes",1,c->capability_queue_bytes,&p->queue_max_bytes)||!small(w,a,"max_items",1,c->capability_queue_items,&p->queue_max_items)||
        !u(w,a,"control_reserve_bytes",512,V3_BYTES_MAX,&p->control_reserve_bytes)||!small(w,a,"control_reserve_items",1,1000000,&p->control_reserve_items)||
        !small(w,a,"high_water_percent",1,99,&p->high_water_percent))return false;
    p->tf_queue=c->capability_tf_queue;b=f(w,a,"stream_reserves");if(!v3_is(w,b,V3_ARRAY))return false;unsigned streams=0;
    for(uint16_t i=w->tokens[b].first;i!=V3_NONE;i=w->tokens[i].next){unsigned bit;uint64_t *bytes;uint32_t *items;
        if(!v3_fields(w,i,"stream bytes items"))return false;
        if(eq(w,i,"stream","feature_summaries")){bit=1;bytes=&p->feature_reserve_bytes;items=&p->feature_reserve_items;}
        else if(eq(w,i,"stream","node_status")){bit=2;bytes=&p->status_reserve_bytes;items=&p->status_reserve_items;}else return false;
        if((streams&bit)||!u(w,i,"bytes",4096,V3_BYTES_MAX,bytes)||!small(w,i,"items",1,1000000,items))return false;
        streams|=bit;
    }
    if(streams!=3||p->control_reserve_bytes+p->feature_reserve_bytes+p->status_reserve_bytes>p->queue_max_bytes||
        (uint64_t)p->control_reserve_items+p->feature_reserve_items+p->status_reserve_items>p->queue_max_items)return false;
    a=f(w,root,"resources");
    if(!v3_fields(w,a,"working_bytes storage_write_bytes_per_day")||!u(w,a,"working_bytes",1,c->capability_working_bytes,&p->working_bytes)||
        !u(w,a,"storage_write_bytes_per_day",1,c->capability_write_bytes,&p->storage_write_bytes_per_day))return false;
    a=f(w,root,"custody");
    if(!v3_fields(w,a,"dataset purpose placement_id association_scope source_retention_hours derived_retention_hours accept_until max_upload_bytes_per_day")||
        !eq(w,a,"dataset","controlled_test")||!eq(w,a,"purpose","controlled_test")||!ident(w,a,"placement_id",p->scope.placement_id)||
        !eq(w,a,"association_scope","window")||!small(w,a,"source_retention_hours",1,168,&p->source_retention_hours)||
        !small(w,a,"derived_retention_hours",1,p->source_retention_hours,&p->derived_retention_hours)||
        !date(w,a,"accept_until",&p->accept_until_utc_ms)||!u(w,a,"max_upload_bytes_per_day",4096,V3_BYTES_MAX,&p->max_upload_bytes_per_day))return false;
    a=f(w,root,"control");
    if(!v3_fields(w,a,"capability_sha256 activation lease")||!s(w,a,"capability_sha256",text,sizeof text)||strcmp(text,c->capability_sha256))return false;
    b=f(w,a,"activation");
    if(!v3_fields(w,b,"boot_id boundary after_window_seq after_segment_seq not_before expires_at")||
        !s(w,b,"boot_id",boot,sizeof boot)||strcmp(boot,c->boot_id)||!eq(w,b,"boundary","closed_window_and_segment")||
        !small(w,b,"after_window_seq",0,UINT32_MAX-1,&p->after_window_seq)||!small(w,b,"after_segment_seq",0,UINT32_MAX,&p->after_segment_seq)||
        !date(w,b,"not_before",&p->not_before_utc_ms)||!date(w,b,"expires_at",&p->expires_utc_ms)||
        p->not_before_utc_ms>=p->expires_utc_ms||p->expires_utc_ms>p->accept_until_utc_ms)return false;
    p->scope.window_seq=p->after_window_seq+1;b=f(w,a,"lease");
    return v3_fields(w,b,"duration_ms on_collection_expiry on_raw_expiry on_uplink_expiry")&&
        small(w,b,"duration_ms",30000,86400000,&p->lease_ms)&&p->lease_ms>p->evidence.window_ms&&
        eq(w,b,"on_collection_expiry","pause")&&eq(w,b,"on_raw_expiry","stop_recording")&&eq(w,b,"on_uplink_expiry","pause");
}

void cp_v3_control_clear(cp_v3_control_t *c){if(c){volatile uint8_t *p=(volatile uint8_t *)c;for(size_t i=0;i<sizeof *c;++i)p[i]=0;}}
cp_v3_control_result_t cp_v3_control_init(cp_v3_control_t *c,W *w,const char *node,const char *boot,const void *json,size_t length,
    cp_v3_time_t now,cp_v3_sha256_fn sha256,void *context){
    if(!c)return CP_V3_CONTROL_INVALID;
    cp_v3_control_clear(c);
    if(!w||!node||!boot||!v3_id(node)||!v3_uuid(boot)||!sha256||!now_valid(now)||length>=CP_V3_CONTROL_CAP_MAX)return CP_V3_CONTROL_INVALID;
    c->workspace=w;c->sha256=sha256;c->hash_context=context;strcpy(c->node_id,node);strcpy(c->boot_id,boot);
    if(!v3_parse(w,json,length)||!caps(c))return CP_V3_CONTROL_UNSUPPORTED;
    if(c->small_statistics&&!now.clock_epoch)return CP_V3_CONTROL_INVALID;
    if(!capability_current(c,now))return CP_V3_CONTROL_NOT_CURRENT;
    if(!v3_digest(c,0,c->capability_sha256)||!v3_canonical(w,0,c->capability_json,sizeof c->capability_json,&c->capability_length))return CP_V3_CONTROL_HASH_MISMATCH;
    c->last_mono_ms=now.mono_ms;c->clock_epoch=now.clock_epoch;c->state=CP_V3_CONTROL_INITIALIZED;return CP_V3_CONTROL_OK;
}
cp_v3_control_result_t cp_v3_control_registration(cp_v3_control_t *c,uint32_t seq,uint64_t uptime,const char **bytes,size_t *length){
    if(bytes)*bytes=NULL;
    if(length)*length=0;
    if(!c||!bytes||!length||!seq||uptime>V3_SAFE)return CP_V3_CONTROL_INVALID;
    if(c->state==CP_V3_CONTROL_REGISTERING){if(c->registration_seq!=seq||c->registered_uptime_ms!=uptime)return CP_V3_CONTROL_STATE;}
    else {
        if(c->state!=CP_V3_CONTROL_INITIALIZED)return CP_V3_CONTROL_STATE;
        int n=snprintf(c->registration_json,sizeof c->registration_json,"{\"protocol\":\"campuspulse/3\",\"registration_seq\":%u,\"uptime_ms\":%llu,\"capabilities\":%s}",(unsigned)seq,(unsigned long long)uptime,c->capability_json);
        if(n<0||(size_t)n>=sizeof c->registration_json)return CP_V3_CONTROL_RESOURCE;
        c->registration_length=(size_t)n;c->registration_seq=seq;c->registered_uptime_ms=uptime;c->state=CP_V3_CONTROL_REGISTERING;
    }
    *bytes=c->registration_json;*length=c->registration_length;return CP_V3_CONTROL_OK;
}
cp_v3_control_result_t cp_v3_control_registration_receipt(cp_v3_control_t *c,const void *json,size_t length,cp_v3_time_t now){
    if(!c||(c->state!=CP_V3_CONTROL_REGISTERING&&c->state!=CP_V3_CONTROL_REGISTERED)||!current(c,now))return CP_V3_CONTROL_STATE;
    W *w=c->workspace;uint64_t at;
    if(!v3_parse(w,json,length)||!v3_fields(w,0,"protocol node_id boot_id registration_seq capability_sha256 registered_at applied capability_evidence")||
        !eq(w,0,"protocol","campuspulse/3")||!eq(w,0,"node_id",c->node_id)||!eq(w,0,"boot_id",c->boot_id)||
        !u(w,0,"registration_seq",c->registration_seq,c->registration_seq,NULL)||!eq(w,0,"capability_sha256",c->capability_sha256)||
        !no(w,0,"applied")||!eq(w,0,"capability_evidence","device_claim")||!date(w,0,"registered_at",&at)||
        at<c->capability_issued_utc_ms||at>now.utc_ms+now.uncertainty_ms)return CP_V3_CONTROL_BINDING_MISMATCH;
    if(c->registered_at_utc_ms&&c->registered_at_utc_ms!=at)return CP_V3_CONTROL_BINDING_MISMATCH;
    c->registered_at_utc_ms=at;
    c->state=CP_V3_CONTROL_REGISTERED;return CP_V3_CONTROL_OK;
}
cp_v3_control_result_t cp_v3_control_offer(cp_v3_control_t *c,const void *json,size_t length,cp_v3_time_t now){
    if(!c||c->state<CP_V3_CONTROL_REGISTERED||!current(c,now))return CP_V3_CONTROL_STATE;
    W *w=c->workspace;uint64_t server_time;char text[65];
    if(!v3_parse(w,json,length)||!v3_fields(w,0,"protocol server_time data_ingestion_available requires_device_ack config reason applied_generation activation_not_before")||
        !eq(w,0,"protocol","campuspulse/3")||!yes(w,0,"data_ingestion_available")||!yes(w,0,"requires_device_ack")||
        !date(w,0,"server_time",&server_time)||server_time>now.utc_ms+now.uncertainty_ms||
        (!v3_is(w,f(w,0,"applied_generation"),V3_NULL)&&!u(w,0,"applied_generation",1,V3_SAFE,NULL)))return CP_V3_CONTROL_INVALID;
    int envelope=f(w,0,"config");
    if(v3_is(w,envelope,V3_NULL))return v3_string(w,f(w,0,"reason"),text,sizeof text)&&v3_is(w,f(w,0,"activation_not_before"),V3_NULL)?CP_V3_CONTROL_WAIT:CP_V3_CONTROL_INVALID;
    if(!v3_is(w,f(w,0,"reason"),V3_NULL)||!v3_fields(w,envelope,"schema policy policy_sha256")||!eq(w,envelope,"schema","device-config-envelope/3"))return CP_V3_CONTROL_INVALID;
    int object=f(w,envelope,"policy");cp_v3_trial_policy_t next;char digest[65],claimed[65];uint64_t not_before;
    if(!policy(c,object,&next))return CP_V3_CONTROL_UNSUPPORTED;
    uint64_t applied_generation=0;
    if(!v3_is(w,f(w,0,"applied_generation"),V3_NULL)){
        if(!u(w,0,"applied_generation",1,V3_SAFE,&applied_generation)||applied_generation>next.scope.assignment_generation||
            (!c->policy_length&&(!c->staged_from_generation||applied_generation!=c->last_applied_generation)))
            return CP_V3_CONTROL_STATE;
    }
    if(!s(w,envelope,"policy_sha256",claimed,sizeof claimed)||!v3_hash_string(claimed)||!v3_digest(c,object,digest)||strcmp(claimed,digest))return CP_V3_CONTROL_HASH_MISMATCH;
    if(!date(w,0,"activation_not_before",&not_before)||not_before!=next.not_before_utc_ms)return CP_V3_CONTROL_BINDING_MISMATCH;
    if(!capability_current(c,now)||now.utc_ms+now.uncertainty_ms>=minimum(next.expires_utc_ms,c->capability_expires_utc_ms)||
        next.not_before_utc_ms>=c->capability_expires_utc_ms)return CP_V3_CONTROL_NOT_CURRENT;
    if(c->policy_length){
        if(strcmp(c->policy.scope.policy_sha256,digest)||c->policy.scope.assignment_generation!=next.scope.assignment_generation)return CP_V3_CONTROL_STATE;
        return now.utc_ms-now.uncertainty_ms<next.not_before_utc_ms?CP_V3_CONTROL_WAIT:CP_V3_CONTROL_OK;
    }
    strcpy(next.scope.policy_sha256,digest);
    if(!v3_canonical(w,object,c->policy_json,sizeof c->policy_json,&c->policy_length))return CP_V3_CONTROL_RESOURCE;
    c->policy=next;c->state=CP_V3_CONTROL_OFFERED;
    return now.utc_ms-now.uncertainty_ms<next.not_before_utc_ms?CP_V3_CONTROL_WAIT:CP_V3_CONTROL_OK;
}
static const char *error_name(cp_v3_apply_result_t result){
    switch(result){case CP_V3_APPLY_UNSUPPORTED:return "unsupported_config";case CP_V3_APPLY_BOUNDARY_FAILED:return "boundary_failed";
    case CP_V3_APPLY_RESOURCE_EXHAUSTED:return "resource_exhausted";case CP_V3_APPLY_STORAGE_FAILED:return "storage_failed";default:return "internal_error";}
}
cp_v3_control_result_t cp_v3_control_apply(cp_v3_control_t *c,cp_v3_time_t now,cp_v3_boundary_t boundary,uint32_t apply_seq,cp_v3_actual_apply_fn apply,void *ctx){
    if(!c||c->state!=CP_V3_CONTROL_OFFERED||!apply||!apply_seq||!current(c,now))return CP_V3_CONTROL_STATE;
    cp_v3_trial_policy_t *p=&c->policy;uint64_t lower=now.utc_ms-now.uncertainty_ms,upper=now.utc_ms+now.uncertainty_ms;
    if(lower<p->not_before_utc_ms)return CP_V3_CONTROL_WAIT;
    if(!capability_current(c,now)||upper>=minimum(p->expires_utc_ms,minimum(p->accept_until_utc_ms,c->capability_expires_utc_ms)))return CP_V3_CONTROL_EXPIRED;
    if(minimum(p->expires_utc_ms,c->capability_expires_utc_ms)-upper<=p->window_ms)return CP_V3_CONTROL_NOT_CURRENT;
    if(boundary.window_open||boundary.segment_open||boundary.closed_window_seq<p->after_window_seq||boundary.closed_segment_seq<p->after_segment_seq||boundary.closed_window_seq==UINT32_MAX)return CP_V3_CONTROL_BOUNDARY;
    cp_v3_boundary_t before=boundary;
    cp_v3_apply_result_t result=apply(ctx,p,&boundary);
    if(result>CP_V3_APPLY_INTERNAL_ERROR)result=CP_V3_APPLY_INTERNAL_ERROR;
    if(result==CP_V3_APPLY_OK&&(boundary.window_open||boundary.segment_open||boundary.closed_window_seq<p->after_window_seq||
        boundary.closed_segment_seq<p->after_segment_seq||boundary.closed_window_seq<before.closed_window_seq||
        boundary.closed_segment_seq<before.closed_segment_seq||boundary.closed_window_seq==UINT32_MAX))result=CP_V3_APPLY_BOUNDARY_FAILED;
    char error[80]="";if(result!=CP_V3_APPLY_OK)snprintf(error,sizeof error,",\"error_code\":\"%s\"",error_name(result));
    int n=snprintf(c->acknowledgement_json,sizeof c->acknowledgement_json,
        "{\"protocol\":\"campuspulse/3\",\"boot_id\":\"%s\",\"policy_id\":\"%s\",\"policy_sha256\":\"%s\",\"assignment_generation\":%llu,"
        "\"apply_seq\":%u,\"state\":\"%s\",\"closed_window_seq\":%u,\"closed_segment_seq\":%u,\"window_open\":%s,\"segment_open\":%s%s}",
        c->boot_id,p->scope.policy_id,p->scope.policy_sha256,(unsigned long long)p->scope.assignment_generation,(unsigned)apply_seq,result==CP_V3_APPLY_OK?"applied":"failed",
        (unsigned)boundary.closed_window_seq,(unsigned)boundary.closed_segment_seq,boundary.window_open?"true":"false",boundary.segment_open?"true":"false",error);
    if(n<0||(size_t)n>=sizeof c->acknowledgement_json)return CP_V3_CONTROL_RESOURCE;
    c->apply_seq=apply_seq;c->apply_result=result;c->acknowledgement_boundary=boundary;c->acknowledgement_length=(size_t)n;
    p->scope.window_seq=boundary.closed_window_seq==UINT32_MAX?UINT32_MAX:boundary.closed_window_seq+1;c->state=CP_V3_CONTROL_ACK_PENDING;return CP_V3_CONTROL_OK;
}
const char *cp_v3_control_ack_bytes(const cp_v3_control_t *c,size_t *length){if(length)*length=c?c->acknowledgement_length:0;return c&&c->acknowledgement_length?c->acknowledgement_json:NULL;}
cp_v3_control_result_t cp_v3_control_ack_receipt(cp_v3_control_t *c,const void *json,size_t length,cp_v3_time_t now){
    if(!c||!c->acknowledgement_length||!current(c,now))return CP_V3_CONTROL_STATE;
    if(c->small_statistics)return v3_small_ack_receipt(c,json,length,now);
    W *w=c->workspace;bool applied=c->apply_result==CP_V3_APPLY_OK;cp_v3_trial_policy_t *p=&c->policy;uint64_t at;
    const char *names=applied?"protocol boot_id policy_id policy_sha256 assignment_generation apply_seq state closed_window_seq closed_segment_seq window_open segment_open node_id received_at durability evidence":
        "protocol boot_id policy_id policy_sha256 assignment_generation apply_seq state closed_window_seq closed_segment_seq window_open segment_open error_code node_id received_at durability evidence";
    if(!v3_parse(w,json,length)||!v3_fields(w,0,names)||!eq(w,0,"protocol","campuspulse/3")||!eq(w,0,"boot_id",c->boot_id)||
        !eq(w,0,"node_id",c->node_id)||!eq(w,0,"policy_id",p->scope.policy_id)||!eq(w,0,"policy_sha256",p->scope.policy_sha256)||
        !u(w,0,"assignment_generation",p->scope.assignment_generation,p->scope.assignment_generation,NULL)||!u(w,0,"apply_seq",c->apply_seq,c->apply_seq,NULL)||
        !eq(w,0,"state",applied?"applied":"failed")||(!applied&&!eq(w,0,"error_code",error_name(c->apply_result)))||
        !u(w,0,"closed_window_seq",c->acknowledgement_boundary.closed_window_seq,c->acknowledgement_boundary.closed_window_seq,NULL)||
        !u(w,0,"closed_segment_seq",c->acknowledgement_boundary.closed_segment_seq,c->acknowledgement_boundary.closed_segment_seq,NULL)||
        !v3_is(w,f(w,0,"window_open"),c->acknowledgement_boundary.window_open?V3_TRUE:V3_FALSE)||
        !v3_is(w,f(w,0,"segment_open"),c->acknowledgement_boundary.segment_open?V3_TRUE:V3_FALSE)||
        !eq(w,0,"durability","committed")||!eq(w,0,"evidence","device_ack")||!date(w,0,"received_at",&at)||at>now.utc_ms+now.uncertainty_ms)return CP_V3_CONTROL_BINDING_MISMATCH;
    if(at<c->capability_issued_utc_ms||(c->acknowledged_at_utc_ms&&c->acknowledged_at_utc_ms!=at))return CP_V3_CONTROL_BINDING_MISMATCH;
    if(!applied){c->acknowledged_at_utc_ms=at;c->state=CP_V3_CONTROL_FAILED;return CP_V3_CONTROL_OK;}
    uint64_t deadline=minimum(p->expires_utc_ms,minimum(p->accept_until_utc_ms,minimum(c->capability_expires_utc_ms,at+p->lease_ms)));
    if(at<p->not_before_utc_ms||at<c->capability_issued_utc_ms||deadline<=at||deadline-at<=p->evidence.window_ms)return CP_V3_CONTROL_NOT_CURRENT;
    if(c->applied_at_utc_ms)return c->applied_at_utc_ms==at?CP_V3_CONTROL_OK:CP_V3_CONTROL_BINDING_MISMATCH;
    c->acknowledged_at_utc_ms=at;c->applied_at_utc_ms=at;c->deadline_utc_ms=deadline;
    uint64_t upper=now.utc_ms+now.uncertainty_ms;
    c->deadline_mono_ms=v3_deadline_mono(now,deadline);
    c->state=deadline>upper?CP_V3_CONTROL_APPLIED:CP_V3_CONTROL_PAUSED;return CP_V3_CONTROL_OK;
}
cp_v3_control_permissions_t cp_v3_control_permissions(cp_v3_control_t *c,cp_v3_time_t now){
    cp_v3_control_permissions_t r={.preserve_unacknowledged=true,.reason=CP_V3_CONTROL_STATE};
    if(!c)return r;
    r.deadline_utc_ms=c->deadline_utc_ms;r.deadline_mono_ms=c->deadline_mono_ms;
    if(c->small_statistics&&c->applied_at_utc_ms&&c->policy.drain_frozen&&
        now_valid(now)&&now.clock_epoch==c->clock_epoch&&now.mono_ms>=c->last_mono_ms&&
        now.utc_ms-now.uncertainty_ms>=c->trusted_utc_lower_ms&&
        now.utc_ms+now.uncertainty_ms<c->policy.accept_until_utc_ms){r.uplink=true;r.frozen_only=true;}
    if(c->state!=CP_V3_CONTROL_APPLIED)return r;
    if(!current(c,now)){c->state=CP_V3_CONTROL_PAUSED;r.reason=CP_V3_CONTROL_NOT_CURRENT;return r;}
    if(now.utc_ms+now.uncertainty_ms>=c->deadline_utc_ms||now.mono_ms>=c->deadline_mono_ms){c->state=CP_V3_CONTROL_PAUSED;r.reason=CP_V3_CONTROL_EXPIRED;return r;}
    uint64_t lower=now.utc_ms-now.uncertainty_ms;
    uint64_t start=c->applied_at_utc_ms;
    if(c->small_statistics){
        if(c->capture_span_start_utc_ms>start)start=c->capture_span_start_utc_ms;
        /* Small windows encode only end time/error. Ingest derives the whole
         * interval as end.utc-end.error-duration, so admission must include
         * the next window's 500ppm error growth plus one millisecond for the
         * collector's integral boundary. Contiguous renewals keep their span;
         * a new post-gap span must satisfy this same guard again. */
        uint64_t guard=((uint64_t)c->policy.window_ms+1999)/2000+1;
        if(lower<start||lower-start<guard){r.reason=CP_V3_CONTROL_WAIT;return r;}
    }else if(lower<start){r.reason=CP_V3_CONTROL_WAIT;return r;}
    r.collection=r.uplink=true;r.local_raw=c->policy.local_raw.enabled;r.frozen_only=false;r.reason=CP_V3_CONTROL_OK;return r;
}
