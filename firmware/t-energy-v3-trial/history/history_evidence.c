#include "history_evidence.h"
/* Deliberate audit-only dependency: public match_frozen_receipt returns no
 * typed receipt facts. Do not duplicate or loosen its strict JSON parser. */
#include "internal.h"
#include <string.h>

#define UTC_MIN UINT64_C(1704067200000)
#define UTC_MAX UINT64_C(7258118400000)
#define DAY_MS UINT64_C(86400000)
typedef cp_v3_control_workspace_t W;
static int field(W *w, const char *key) { return v3_field(w,0,key); }
static bool number(W *w,const char *key,uint64_t min,uint64_t max,uint64_t *out) {
    return v3_uint(w,field(w,key),min,max,out);
}
static bool date(W *w,const char *key,uint64_t *out) {
    char text[25];return v3_string(w,field(w,key),text,sizeof text)&&v3_date(text,out);
}
static bool text_ok(const char *s,size_t n) { return memchr(s,0,n)!=NULL; }
static bool scope_valid(const cp_v3_scope_t *s) {
    return text_ok(s->node_id,sizeof s->node_id)&&v3_id(s->node_id)&&
        text_ok(s->boot_id,sizeof s->boot_id)&&v3_uuid(s->boot_id)&&
        text_ok(s->placement_id,sizeof s->placement_id)&&v3_id(s->placement_id)&&
        text_ok(s->policy_id,sizeof s->policy_id)&&v3_id(s->policy_id)&&
        text_ok(s->policy_sha256,sizeof s->policy_sha256)&&v3_hash_string(s->policy_sha256)&&
        text_ok(s->dataset,sizeof s->dataset)&&s->assignment_generation&&s->assignment_generation<=V3_SAFE;
}
static bool same_scope(const cp_v3_scope_t *a,const cp_v3_scope_t *b) {
    return !strcmp(a->node_id,b->node_id)&&!strcmp(a->boot_id,b->boot_id)&&
        !strcmp(a->placement_id,b->placement_id)&&!strcmp(a->policy_id,b->policy_id)&&
        !strcmp(a->policy_sha256,b->policy_sha256)&&!strcmp(a->dataset,b->dataset)&&
        a->assignment_generation==b->assignment_generation;
}
static bool bounds(cp_v3_time_t t,uint64_t *lo,uint64_t *hi) {
    if(!t.clock_epoch||t.mono_ms>V3_SAFE||t.uncertainty_ms>5000||
       t.utc_ms<UTC_MIN+t.uncertainty_ms||t.utc_ms>=UTC_MAX-t.uncertainty_ms)return false;
    *lo=t.utc_ms-t.uncertainty_ms;*hi=t.utc_ms+t.uncertainty_ms;return true;
}
static bool load(const te_history_source_t *s,te_history_artifact_t kind,unsigned index,
        void *out,size_t cap,size_t *length,te_history_report_t *r) {
    *length=0;te_history_load_t result=s->load(s->context,kind,index,out,cap,length);
    if(result==TE_HISTORY_ABSENT){r->blockers|=TE_HISTORY_MISSING_ARTIFACT;return false;}
    if(result!=TE_HISTORY_PRESENT||!*length||*length>cap){r->blockers|=TE_HISTORY_STORAGE_FAILURE;return false;}
    return true;
}
static bool pair(te_history_workspace_t *w,const te_history_source_t *source,
        te_history_artifact_t kind,unsigned index,te_history_report_t *r) {
    size_t n,rn;
    if(!load(source,kind,index,w->request,sizeof w->request,&n,r)||
       !load(source,(te_history_artifact_t)(kind+1),index,w->receipt,sizeof w->receipt,&rn,r))return false;
    r->control_result=cp_v3_control_match_frozen_receipt(&w->parser,&w->control.policy.scope,
        w->request,n,w->receipt,rn,w->control.sha256,w->control.hash_context);
    return r->control_result==CP_V3_CONTROL_OK;
}
static bool deadline(const cp_v3_control_t *c,uint64_t server,uint64_t until) {
    return server>=c->capability_issued_utc_ms&&server>=c->policy.not_before_utc_ms&&
        until>server&&until-server<=c->policy.lease_ms&&until<=c->capability_expires_utc_ms&&
        until<=c->policy.expires_utc_ms&&until<=c->policy.accept_until_utc_ms;
}
void te_history_inspect(te_history_workspace_t *w,const te_history_source_t *source,
        const te_history_query_t *q,cp_v3_sha256_fn sha,void *hash_context,te_history_report_t *r) {
    if(!r)return;
    memset(r,0,sizeof *r);r->blockers=TE_HISTORY_RELEASE_BLOCKERS;r->control_result=CP_V3_CONTROL_INVALID;
    if(!w||!source||!source->load||!q||!sha||!scope_valid(&q->original_scope)||
       q->lease_count>TE_HISTORY_MAX_LEASES||!q->frozen_body_bytes){r->blockers|=TE_HISTORY_BAD_INPUT;return;}
    uint64_t start_lo,start_hi,end_lo,end_hi,now_lo,now_hi;
    if(!bounds(q->observation_start,&start_lo,&start_hi)||!bounds(q->observation_end,&end_lo,&end_hi)||
       !bounds(q->upload_now,&now_lo,&now_hi)||q->observation_start.clock_epoch!=q->observation_end.clock_epoch||
       q->observation_start.mono_ms>q->observation_end.mono_ms||start_lo>end_lo||start_hi>end_hi||end_hi>now_lo){
        r->blockers|=TE_HISTORY_UNKNOWN_TIME;return;
    }
    if(now_lo/DAY_MS!=now_hi/DAY_MS){r->blockers|=TE_HISTORY_UPLOAD_DAY_AMBIGUOUS;return;}
    r->upload_utc_day=(uint32_t)(now_lo/DAY_MS);
    cp_v3_control_t *c=&w->control;W *p=&w->parser;cp_v3_control_clear(c);
    c->workspace=p;c->sha256=sha;c->hash_context=hash_context;
    strcpy(c->node_id,q->original_scope.node_id);strcpy(c->boot_id,q->original_scope.boot_id);
    size_t n;
    if(!load(source,TE_HISTORY_CAPABILITIES,0,w->document,CP_V3_CONTROL_CAP_MAX-1,&n,r))return;
    if(!v3_parse(p,w->document,n)||!v3_small_caps(c)||!v3_digest(c,0,c->capability_sha256)){
        r->blockers|=TE_HISTORY_BAD_CAPABILITY;return;
    }
    if(!load(source,TE_HISTORY_POLICY_ENVELOPE,0,w->document,sizeof w->document,&n,r))return;
    char claimed[65],digest[65];
    if(!v3_parse(p,w->document,n)||!v3_fields(p,0,"schema policy policy_sha256")||
       !v3_equal(p,field(p,"schema"),"device-config-envelope/3")||
       !v3_small_policy(c,field(p,"policy"),&c->policy)||
       !v3_string(p,field(p,"policy_sha256"),claimed,sizeof claimed)||!v3_hash_string(claimed)||
       !v3_digest(c,field(p,"policy"),digest)||strcmp(claimed,digest)){
        r->blockers|=TE_HISTORY_BAD_POLICY;return;
    }
    strcpy(c->policy.scope.policy_sha256,digest);
    if(!same_scope(&q->original_scope,&c->policy.scope)){r->blockers|=TE_HISTORY_SCOPE_MISMATCH;return;}
    r->original_scope=c->policy.scope;r->original_accept_until_ms=c->policy.accept_until_utc_ms;
    r->original_daily_upload_limit=c->policy.max_upload_bytes_per_day;
    if(q->frozen_body_bytes>c->policy.max_body_bytes||q->frozen_body_bytes>c->policy.max_upload_bytes_per_day){
        r->blockers|=TE_HISTORY_BODY_LIMIT;return;
    }
    if(now_hi>=c->policy.accept_until_utc_ms||
       now_hi-end_lo>=(uint64_t)c->policy.source_retention_hours*3600000){r->blockers|=TE_HISTORY_EXPIRED;return;}
    if(!pair(w,source,TE_HISTORY_APPLIED_REQUEST,0,r)){r->blockers|=TE_HISTORY_BAD_APPLIED_RECEIPT;return;}
    uint64_t received,server,until,window,segment;
    if(!v3_equal(p,field(p,"state"),"applied")||!date(p,"received_at",&received)||
       !date(p,"server_time",&server)||!number(p,"lease_until_ms",1,V3_SAFE,&until)||
       !number(p,"closed_window_seq",c->policy.after_window_seq,UINT32_MAX,&window)||
       !number(p,"closed_segment_seq",c->policy.after_segment_seq,UINT32_MAX,&segment)||
       received<c->capability_issued_utc_ms||received>server||!deadline(c,server,until)||until-server<=c->policy.window_ms){
        r->blockers|=TE_HISTORY_BAD_APPLIED_RECEIPT;return;
    }
    r->spans[0]=(te_history_span_t){server,until,1};r->span_count=1;
    uint64_t last_contact=0,last_uptime=0,last_server=server;
    for(unsigned i=0;i<q->lease_count;++i){
        if(!pair(w,source,TE_HISTORY_LEASE_REQUEST,i,r)){r->blockers|=TE_HISTORY_BAD_LEASE_CHAIN;return;}
        uint64_t contact,uptime,span;
        te_history_span_t *previous=&r->spans[r->span_count-1];
        bool contiguous=v3_is(p,field(p,"contiguous"),V3_TRUE);
        if(!date(p,"server_time",&server)||!number(p,"lease_until_ms",1,V3_SAFE,&until)||
           !number(p,"contact_seq",1,UINT32_MAX,&contact)||!number(p,"uptime_ms",0,V3_SAFE,&uptime)||
           !number(p,"span_seq",1,UINT32_MAX,&span)||contact<=last_contact||uptime<last_uptime||
           server<last_server||until<previous->end_utc_ms||!deadline(c,server,until)||
           (contiguous?(span!=previous->sequence||server>previous->end_utc_ms):
               (previous->sequence==UINT32_MAX||span!=previous->sequence+1||server<=previous->end_utc_ms))){
            r->blockers|=TE_HISTORY_BAD_LEASE_CHAIN;return;
        }
        if(contiguous)previous->end_utc_ms=until;
        else r->spans[r->span_count++]=(te_history_span_t){server,until,(uint32_t)span};
        last_contact=contact;last_uptime=uptime;last_server=server;
    }
    if(last_server>now_lo){r->blockers|=TE_HISTORY_UNKNOWN_TIME;return;}
    bool covered=false;
    for(unsigned i=0;i<r->span_count;++i)
        if(start_lo>=r->spans[i].start_utc_ms&&end_hi<=r->spans[i].end_utc_ms)covered=true;
    if(!covered){r->blockers|=TE_HISTORY_OUTSIDE_AUTHORITY;return;}
    r->check=TE_HISTORY_STRUCTURE_MATCHED;
    /* Intentionally no permission result: local unsigned records cannot prove
     * actual apply, original trusted time, placement closure, or durable quota. */
}
