#include "cp_v3_small_results.h"
#include <stdarg.h>
#include <stdio.h>
#include <string.h>

#define SAFE UINT64_C(9007199254740991)
#define UTC_MAX UINT64_C(8640000000000000)
typedef struct { char *out; size_t cap,used; bool ok; } writer_t;
static void emit(writer_t *w,const char *format,...) {
    if(!w->ok) return;
    va_list args; va_start(args,format); int n=vsnprintf(w->out+w->used,w->cap-w->used,format,args); va_end(args);
    if(n<0||(size_t)n>=w->cap-w->used) w->ok=false; else w->used+=(size_t)n;
}
static size_t length(const char *s,size_t cap) { size_t n=0; if(!s) return cap; while(n<cap&&s[n]) n++; return n; }
static bool hex(const char *s,size_t n) {
    if(length(s,n+1)!=n) return false;
    for(size_t i=0;i<n;i++) if(!((s[i]>='0'&&s[i]<='9')||(s[i]>='a'&&s[i]<='f'))) return false;
    return true;
}
static bool uuid(const char *s) {
    if(length(s,37)!=36||s[14]!='4'||!strchr("89ab",s[19])) return false;
    for(unsigned i=0;i<36;i++) {
        if(i==8||i==13||i==18||i==23) { if(s[i]!='-') return false; }
        else if(!((s[i]>='0'&&s[i]<='9')||(s[i]>='a'&&s[i]<='f'))) return false;
    } return true;
}
static bool id(const char *s) {
    size_t n=length(s,65); if(!n||n>64) return false;
    for(size_t i=0;i<n;i++) if(!((s[i]>='a'&&s[i]<='z')||(s[i]>='0'&&s[i]<='9')||(i&&(s[i]=='_'||s[i]=='-')))) return false;
    return true;
}
static bool scope_valid(const cp_v3_scope_t *s) {
    return s&&id(s->node_id)&&uuid(s->boot_id)&&id(s->policy_id)&&id(s->placement_id)&&hex(s->policy_sha256,64)&&
        s->assignment_generation&&s->assignment_generation<=SAFE&&length(s->dataset,sizeof s->dataset)<sizeof s->dataset&&
        (!strcmp(s->dataset,"field")||!strcmp(s->dataset,"demo")||!strcmp(s->dataset,"controlled_test"));
}
static bool time_valid(cp_v3_small_time_t t) {
    return t.mono_ms<=SAFE&&t.clock_epoch&&(!t.utc_known||(t.utc_ms<=UTC_MAX&&t.uncertainty_ms<=5000));
}
static void time_json(writer_t *w,cp_v3_small_time_t t) {
    if(t.utc_known) emit(w,"[%llu,%llu,%u,%u]",(unsigned long long)t.mono_ms,(unsigned long long)t.utc_ms,t.clock_epoch,t.uncertainty_ms);
    else emit(w,"[%llu,null,%u,null]",(unsigned long long)t.mono_ms,t.clock_epoch);
}
static bool ordered(cp_v3_small_time_t a,cp_v3_small_time_t b) {
    if(!time_valid(a)||!time_valid(b)||a.clock_epoch!=b.clock_epoch||a.mono_ms>b.mono_ms||a.utc_known!=b.utc_known) return false;
    if(a.utc_known) {
        int64_t delta=(int64_t)b.utc_ms-(int64_t)a.utc_ms-(int64_t)(b.mono_ms-a.mono_ms);
        int64_t error=(int64_t)a.uncertainty_ms+b.uncertainty_ms;
        if(delta < -error||delta>error) return false;
    } return true;
}
static bool rssi_valid(uint64_t n,int64_t sum,int16_t min,int16_t max,uint64_t reports) {
    if(n>reports||n>SAFE||sum<-(int64_t)SAFE||sum>(int64_t)SAFE) return false;
    if(!n) return sum==0;
    if(min< -127||max>20||max<min||sum<(int64_t)n*min||sum>(int64_t)n*max) return false;
    return sum>=(int64_t)max+(int64_t)(n-1)*min&&sum<=(int64_t)min+(int64_t)(n-1)*max;
}
static void rssi_json(writer_t *w,uint64_t n,int64_t sum,int16_t min,int16_t max) {
    if(n) emit(w,"%llu,%lld,%d,%d",(unsigned long long)n,(long long)sum,min,max);
    else emit(w,"0,0,null,null");
}
static bool prepare(const cp_v3_scope_t *s,const char *batch,uint32_t seq,cp_v3_sha256_fn hash,
    char *out,size_t cap,size_t *used,cp_v3_expected_t *expected) {
    if(used) *used=0;
    if(expected) memset(expected,0,sizeof *expected);
    if(out&&cap) out[0]=0;
    return scope_valid(s)&&uuid(batch)&&seq&&hash&&out&&cap&&cap<=CP_V3_BODY_MAX&&used&&expected;
}
static void envelope(writer_t *w,const cp_v3_scope_t *s,const char *batch,const char *stream) {
    emit(w,"{\"p\":3,\"z\":\"statistics/1\",\"b\":\"%s\",\"n\":\"%s\",\"o\":\"%s\",\"c\":\"%s\",\"h\":\"%s\",\"g\":%llu,\"d\":\"%s\",\"k\":\"%s\",\"x\":[",
        batch,s->node_id,s->boot_id,s->policy_id,s->policy_sha256,(unsigned long long)s->assignment_generation,s->dataset,stream);
}
static cp_v3_result_t finish(writer_t *w,const cp_v3_scope_t *s,const char *batch,const char *stream,uint32_t seq,
    cp_v3_sha256_fn hash,void *context,size_t *used,cp_v3_expected_t *expected) {
    emit(w,"]}");
    if(!w->ok) { w->out[0]=0; return CP_V3_OUTPUT_FULL; }
    uint8_t digest[32]; if(!hash(context,w->out,w->used,digest)) { w->out[0]=0; return CP_V3_INVALID; }
    expected->scope=*s; strcpy(expected->batch_id,batch); strcpy(expected->stream,stream);
    for(unsigned i=0;i<32;i++) snprintf(expected->body_sha256+i*2,3,"%02x",digest[i]);
    expected->seq_first=expected->seq_last=seq; expected->accepted_count=1; expected->body_bytes=w->used;
    *used=w->used; return CP_V3_OK;
}
cp_v3_result_t cp_v3_small_window_body(const cp_v3_scope_t *scope,const cp_v3_stats_snapshot_t *s,cp_v3_small_time_t end,
    const char *batch,uint32_t seq,cp_v3_sha256_fn hash,void *context,char *out,size_t cap,size_t *used,cp_v3_expected_t *expected) {
    if(!prepare(scope,batch,seq,hash,out,cap,used,expected)||!s||!scope->window_seq||!time_valid(end)||
       !s->duration_ms||s->window_ms<1000||s->window_ms>300000||s->duration_ms>s->window_ms||s->duration_ms>end.mono_ms||!s->bin_ms||s->bin_ms>s->window_ms||
       !s->bin_count||s->bin_count>CP_V3_STATS_MAX_BINS||s->bin_count!=(s->duration_ms+s->bin_ms-1)/s->bin_ms||
       s->snapshot_mono_us/1000!=end.mono_ms||s->unique_keys>s->capacity||s->capacity>512||s->estimated_total_available||
       s->counters_saturated||!s->received_reports_known||!s->callback_drops_known||!s->aggregation_drops_known||
       s->received_reports>SAFE||s->worker_reports>SAFE||s->adv_reports>SAFE||s->scan_response_reports>SAFE||
       s->received_reports<s->worker_reports||s->adv_reports+s->scan_response_reports!=s->worker_reports||s->unique_keys>s->worker_reports||
       s->callback_drops>SAFE||s->aggregation_drops>SAFE||s->address_overflow_reports>SAFE||s->scan_coverage_ms>s->duration_ms||
       s->quality_mask>63||length(s->rules_version,sizeof s->rules_version)>=sizeof s->rules_version||
       strcmp(s->rules_version,CP_V3_SMALL_RULESET)||length(s->extractor_version,sizeof s->extractor_version)>=sizeof s->extractor_version||
       strcmp(s->extractor_version,CP_V3_STATS_VERSION)||!rssi_valid(s->rssi_samples,s->rssi_sum,s->rssi_min,s->rssi_max,s->worker_reports)) return CP_V3_INVALID;
    uint64_t categories=0,reports=0,rssi_n=0; int64_t rssi_sum=0;
    for(unsigned i=0;i<CP_V3_STATS_CLASS_COUNT;i++) {
        categories+=s->counts[i]; if(i!=CP_V3_STATS_UNKNOWN&&s->counts[i]) return CP_V3_UNSUPPORTED;
    }
    if(categories!=s->unique_keys) return CP_V3_INVALID;
    for(unsigned i=0;i<s->bin_count;i++) {
        const cp_v3_stats_bin_t *b=&s->bins[i];
        if(b->reports>SAFE||b->rssi_samples>b->reports||b->unique_keys>s->unique_keys||b->unique_keys>b->reports||
           b->rssi_sum<-(int64_t)SAFE||b->rssi_sum>(int64_t)SAFE||
           b->rssi_sum<(int64_t)b->rssi_samples*(s->rssi_samples?s->rssi_min:-127)||
           b->rssi_sum>(int64_t)b->rssi_samples*(s->rssi_samples?s->rssi_max:20)||
           reports>SAFE-b->reports||rssi_n>SAFE-b->rssi_samples) return CP_V3_INVALID;
        reports+=b->reports; rssi_n+=b->rssi_samples; rssi_sum+=b->rssi_sum;
    }
    if(reports!=s->worker_reports||rssi_n!=s->rssi_samples||rssi_sum!=s->rssi_sum) return CP_V3_INVALID;
    unsigned flags=s->quality_mask;
    if(s->duration_ms!=s->window_ms||!s->window_closed) flags|=1;
    if(!end.utc_known||end.uncertainty_ms) flags|=2;
    if(s->scan_coverage_ms<s->duration_ms) flags|=4;
    if(s->address_overflow_reports) flags|=8;
    if(s->callback_drops) flags|=16;
    if(s->aggregation_drops) flags|=32;
    writer_t w={out,cap,0,true}; envelope(&w,scope,batch,"window_statistics");
    emit(&w,"{\"q\":%u,\"w\":%u,\"t\":",seq,scope->window_seq); time_json(&w,end);
    emit(&w,",\"d\":%u,\"b\":%u,\"c\":[",s->duration_ms,s->bin_ms);
    for(unsigned i=0;i<CP_V3_STATS_CLASS_COUNT;i++) emit(&w,"%s%u",i?",":"",s->counts[i]);
    emit(&w,"],\"r\":[%llu,%llu,%llu,%llu],\"x\":[",(unsigned long long)s->received_reports,(unsigned long long)s->worker_reports,
        (unsigned long long)s->adv_reports,(unsigned long long)s->scan_response_reports);
    for(unsigned i=0;i<s->bin_count;i++) { const cp_v3_stats_bin_t *b=&s->bins[i];
        emit(&w,"%s[%llu,%u,%llu,%lld]",i?",":"",(unsigned long long)b->reports,b->unique_keys,(unsigned long long)b->rssi_samples,(long long)b->rssi_sum); }
    emit(&w,"],\"s\":["); rssi_json(&w,s->rssi_samples,s->rssi_sum,s->rssi_min,s->rssi_max);
    emit(&w,"],\"l\":[%llu,%llu,%llu,%llu],\"f\":%u,\"v\":[\"%s\",\"%s\"]}",
        (unsigned long long)s->scan_coverage_ms,(unsigned long long)s->callback_drops,(unsigned long long)s->aggregation_drops,
        (unsigned long long)s->address_overflow_reports,flags,CP_V3_STATS_VERSION,CP_V3_SMALL_RULESET);
    return finish(&w,scope,batch,"window_statistics",seq,hash,context,used,expected);
}
cp_v3_result_t cp_v3_small_event_body(const cp_v3_scope_t *scope,const cp_v3_temporal_event_t *e,uint32_t slice_ms,
    const char *batch,uint32_t seq,cp_v3_sha256_fn hash,void *context,char *out,size_t cap,size_t *used,cp_v3_expected_t *expected) {
    if(!prepare(scope,batch,seq,hash,out,cap,used,expected)||!e||!e->revision||!slice_ms||e->quality_mask>31||
       (unsigned)e->state>CP_V3_TEMPORAL_CENSORED||(unsigned)e->reason>CP_V3_TEMPORAL_LATE_REPORT||
       !ordered(e->start,e->last_seen)||!ordered(e->last_seen,e->observed_until)||
       (e->state!=CP_V3_TEMPORAL_OPEN&&!ordered(e->observed_until,e->end))||
       (e->state==CP_V3_TEMPORAL_CLOSED&&e->end.mono_ms!=e->observed_until.mono_ms)||
       (e->event_id[6]>>4)!=4||(e->event_id[8]&0xc0)!=0x80||
       (e->state==CP_V3_TEMPORAL_OPEN&&e->reason!=CP_V3_TEMPORAL_SNAPSHOT)||
       (e->state==CP_V3_TEMPORAL_CLOSED&&e->reason!=CP_V3_TEMPORAL_OBSERVED_GAP)||
       (e->state==CP_V3_TEMPORAL_CENSORED&&(e->reason==CP_V3_TEMPORAL_SNAPSHOT||e->reason==CP_V3_TEMPORAL_OBSERVED_GAP))||
       (e->state!=CP_V3_TEMPORAL_CENSORED&&(e->quality_mask&14))||
       e->reports>SAFE||e->present_slices>SAFE||e->absent_slices>SAFE||e->coverage_ms>SAFE||
       e->present_slices>e->reports||(e->reports&&!e->present_slices)||
       !rssi_valid(e->rssi_n,e->rssi_sum,e->rssi_min,e->rssi_max,e->reports)) return CP_V3_INVALID;
    uint64_t elapsed=(e->state==CP_V3_TEMPORAL_OPEN?e->observed_until.mono_ms:e->end.mono_ms)-e->start.mono_ms;
    /* Episode lifetime is independent from the rolling-history horizon.
     * The caller/server still enforce the negotiated smaller policy bound. */
    uint64_t observed=e->observed_until.mono_ms-e->start.mono_ms;
    if(elapsed>86400000||e->coverage_ms>observed||e->present_slices+e->absent_slices>observed/slice_ms+1) return CP_V3_INVALID;
    const char *states[]={"open","closed","censored"};
    const char *reasons[]={"snapshot","observed_gap","timeout","capacity","clock_change","config_change","placement_change","reboot","lease_expired","scan_gap","late_report"};
    char event_id[37]; unsigned at=0;
    for(unsigned i=0;i<16;i++) { if(i==4||i==6||i==8||i==10) event_id[at++]='-'; snprintf(event_id+at,3,"%02x",e->event_id[i]); at+=2; }
    writer_t w={out,cap,0,true}; envelope(&w,scope,batch,"candidate_events");
    emit(&w,"{\"q\":%u,\"i\":\"%s\",\"v\":%u,\"k\":\"visibility_segment\",\"s\":\"%s\",\"a\":",seq,event_id,e->revision,states[e->state]);
    time_json(&w,e->start); emit(&w,",\"l\":"); time_json(&w,e->last_seen);
    emit(&w,",\"u\":");time_json(&w,e->observed_until);emit(&w,",\"e\":");
    if(e->state==CP_V3_TEMPORAL_OPEN) emit(&w,"null"); else time_json(&w,e->end);
    emit(&w,",\"r\":[%llu,%llu,%llu,%llu,",(unsigned long long)e->reports,(unsigned long long)e->present_slices,
        (unsigned long long)e->absent_slices,(unsigned long long)e->coverage_ms); rssi_json(&w,e->rssi_n,e->rssi_sum,e->rssi_min,e->rssi_max);
    emit(&w,"],\"c\":\"%s\",\"f\":%u,\"x\":[\"%s\",\"%s\"]}",reasons[e->reason],
        e->quality_mask|(e->state==CP_V3_TEMPORAL_CENSORED?8u:0u),CP_V3_STATS_VERSION,CP_V3_SMALL_RULESET);
    return finish(&w,scope,batch,"candidate_events",seq,hash,context,used,expected);
}
cp_v3_result_t cp_v3_small_status_body(const cp_v3_scope_t *scope,const cp_v3_small_status_t *s,const char *batch,uint32_t seq,
    cp_v3_sha256_fn hash,void *context,char *out,size_t cap,size_t *used,cp_v3_expected_t *expected) {
    if(!prepare(scope,batch,seq,hash,out,cap,used,expected)||!s||!time_valid(s->time)||
       (unsigned)s->state>CP_V3_SMALL_FAILED||s->resource_known_mask>31) return CP_V3_INVALID;
    for(unsigned i=0;i<5;i++) if((s->resource_known_mask&(1u<<i))&&s->resources[i]>SAFE) return CP_V3_INVALID;
    if((s->resource_known_mask&3)==3&&s->resources[1]>s->resources[0]) return CP_V3_INVALID;
    if((s->resource_known_mask&5)==5&&s->resources[2]>s->resources[0]) return CP_V3_INVALID;
    for(unsigned i=0;i<6;i++) if(s->queue[i]>SAFE||s->losses[i]>SAFE||(s->local_raw_counters_known&&s->local_raw[i]>SAFE)) return CP_V3_INVALID;
    for(unsigned i=0;i<3;i++) if((s->queue[i*2]==0)!=(s->queue[i*2+1]==0)) return CP_V3_INVALID;
    if(s->local_raw_counters_known&&(s->local_raw[2]>s->local_raw[1]||s->local_raw[1]>s->local_raw[0])) return CP_V3_INVALID;
    const char *states[]={"running","paused","failed"}; writer_t w={out,cap,0,true}; envelope(&w,scope,batch,"node_status");
    emit(&w,"{\"q\":%u,\"t\":",seq); time_json(&w,s->time);
    emit(&w,",\"u\":%llu,\"s\":\"%s\",\"r\":[",(unsigned long long)s->time.mono_ms,states[s->state]);
    for(unsigned i=0;i<5;i++) { if(i) emit(&w,","); if(s->resource_known_mask&(1u<<i)) emit(&w,"%llu",(unsigned long long)s->resources[i]); else emit(&w,"null"); }
    emit(&w,"],\"j\":["); for(unsigned i=0;i<6;i++) emit(&w,"%s%llu",i?",":"",(unsigned long long)s->queue[i]);
    emit(&w,"],\"l\":["); for(unsigned i=0;i<6;i++) emit(&w,"%s%llu",i?",":"",(unsigned long long)s->losses[i]); emit(&w,"]");
    if(s->local_raw_counters_known) { emit(&w,",\"a\":["); for(unsigned i=0;i<6;i++) emit(&w,"%s%llu",i?",":"",(unsigned long long)s->local_raw[i]); emit(&w,"]"); }
    emit(&w,"}"); return finish(&w,scope,batch,"node_status",seq,hash,context,used,expected);
}
