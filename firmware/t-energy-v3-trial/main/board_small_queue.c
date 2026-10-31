#include "board_small_queue.h"
#include "nvs.h"
#include <string.h>
#define SAFE_UTC 9007199254740991ULL
/* A conservative logical authorization per whole NVS adapter mutation,
 * including its potential tombstone transition. This is not measured flash
 * wear or a bound on NVS garbage-collection amplification. */
#define TE_QUEUE_MUTATION_ALLOWANCE UINT64_C(16384)
static te_v3_small_queue_result_t result(cp_v3_queue_result_t r) { return (te_v3_small_queue_result_t)r; }
static bool clock_bound(void *ctx,uint64_t *lower,uint64_t *upper) {
    te_v3_small_queue_t *b=ctx;
    return b->config.clock(b->config.clock_context,lower,upper);
}
static bool expire_record(void *ctx,unsigned slot,const void *bytes,size_t n,const cp_v3_queue_tombstone_t *t) {
    te_v3_small_queue_t *b=ctx;
    uint64_t lower=0,upper=0;
    if(!clock_bound(b,&lower,&upper)) { b->last_budget_result=CP_V3_BUDGET_CLOCK_UNKNOWN; return false; }
    b->last_budget_result=cp_v3_budget_charge(b->config.write_budget,TE_QUEUE_MUTATION_ALLOWANCE,lower,upper);
    if(b->last_budget_result!=CP_V3_BUDGET_OK) return false;
    return te_nvs_store_expire(&b->storage,slot,bytes,n,t);
}
static int guarded_load(void *ctx,unsigned slot,void *bytes,size_t cap,size_t *n) {
    te_v3_small_queue_t *b=ctx;
    return b->raw_store.load(b->raw_store.context,slot,bytes,cap,n);
}
static bool reserve_mutation(te_v3_small_queue_t *b) {
    uint64_t lower=0,upper=0;
    if(!clock_bound(b,&lower,&upper)) { b->last_budget_result=CP_V3_BUDGET_CLOCK_UNKNOWN; return false; }
    b->last_budget_result=cp_v3_budget_charge(b->config.write_budget,TE_QUEUE_MUTATION_ALLOWANCE,lower,upper);
    return b->last_budget_result==CP_V3_BUDGET_OK;
}
static bool guarded_store(void *ctx,unsigned slot,const void *bytes,size_t n) {
    te_v3_small_queue_t *b=ctx;
    return reserve_mutation(b) && b->raw_store.store(b->raw_store.context,slot,bytes,n);
}
static bool guarded_reclaim(void *ctx,unsigned slot,const void *bytes,size_t n) {
    te_v3_small_queue_t *b=ctx;
    return reserve_mutation(b) && b->raw_store.reclaim(b->raw_store.context,slot,bytes,n);
}
static te_v3_small_queue_result_t enter(te_v3_small_queue_t *b) {
    if(!b||!b->opened) return TE_SMALL_QUEUE_INVALID;
    if(!b->config.try_lock(b->config.lock_context)) return TE_SMALL_QUEUE_BUSY;
    if(b->storage.uncertain) { b->config.unlock(b->config.lock_context); return TE_SMALL_QUEUE_UNCERTAIN; }
    return TE_SMALL_QUEUE_OK;
}
static te_v3_small_queue_result_t leave(te_v3_small_queue_t *b,te_v3_small_queue_result_t r) {
    b->config.unlock(b->config.lock_context); return r;
}
static unsigned target(cp_v3_queue_kind_t kind) {
    if(kind==CP_V3_QUEUE_WINDOW) return 0;
    if(kind==CP_V3_QUEUE_STATUS) return 1;
    if(kind==CP_V3_QUEUE_CONTROL) return 2;
    return CP_V3_QUEUE_SLOTS;
}
static bool text_field(const char *s,size_t capacity) { return s[0] && memchr(s,0,capacity); }
static bool sha_text(const char *s) {
    if(strlen(s)!=64) return false;
    for(unsigned i=0;i<64;i++) if(!((s[i]>='0'&&s[i]<='9')||(s[i]>='a'&&s[i]<='f'))) return false;
    return true;
}
static bool uuid4(const char *s) {
    if(strlen(s)!=36 || s[14]!='4' || !strchr("89ab",s[19])) return false;
    for(unsigned i=0;i<36;i++) {
        if(i==8||i==13||i==18||i==23) { if(s[i]!='-') return false; }
        else if(!((s[i]>='0'&&s[i]<='9')||(s[i]>='a'&&s[i]<='f'))) return false;
    }
    return true;
}
static bool expected_fields(const cp_v3_expected_t *e,cp_v3_queue_kind_t kind,size_t bytes) {
    if(!e || !text_field(e->scope.node_id,sizeof e->scope.node_id) ||
       !text_field(e->scope.boot_id,sizeof e->scope.boot_id) ||
       !text_field(e->scope.placement_id,sizeof e->scope.placement_id) ||
       !text_field(e->scope.policy_id,sizeof e->scope.policy_id) ||
       !text_field(e->scope.policy_sha256,sizeof e->scope.policy_sha256) ||
       !text_field(e->scope.dataset,sizeof e->scope.dataset) ||
       !text_field(e->batch_id,sizeof e->batch_id) || !text_field(e->body_sha256,sizeof e->body_sha256) ||
       !text_field(e->stream,sizeof e->stream) || e->body_bytes!=bytes ||
       !e->scope.assignment_generation || e->scope.assignment_generation>SAFE_UTC ||
       !e->seq_first || e->seq_first!=e->seq_last || e->accepted_count!=1 ||
       !uuid4(e->scope.boot_id) || !uuid4(e->batch_id) ||
       !sha_text(e->scope.policy_sha256) || !sha_text(e->body_sha256)) return false;
    if(kind==CP_V3_QUEUE_WINDOW) return e->scope.window_seq && !strcmp(e->stream,"window_statistics");
    if(kind==CP_V3_QUEUE_STATUS) return !strcmp(e->stream,"node_status");
    if(kind==CP_V3_QUEUE_CONTROL) return !strcmp(e->stream,"config_ack") || !strcmp(e->stream,"lease");
    return false;
}
static te_v3_small_queue_result_t admit(te_v3_small_queue_t *b,cp_v3_queue_kind_t kind,
    const cp_v3_expected_t *e,size_t bytes,uint64_t expiry) {
    if(!bytes||bytes>TE_SMALL_QUEUE_BODY_MAX||!expiry||expiry>SAFE_UTC||
       !expected_fields(e,kind,bytes)) return TE_SMALL_QUEUE_INVALID;
    if(strcmp(e->scope.node_id,b->queue.node_id)||strcmp(e->scope.boot_id,b->queue.boot_id)) return TE_SMALL_QUEUE_RETIRED;
    uint64_t lower=0,upper=0;
    if(!clock_bound(b,&lower,&upper)||lower>upper||upper>SAFE_UTC) return TE_SMALL_QUEUE_CLOCK_UNKNOWN;
    if(lower>=expiry) return TE_SMALL_QUEUE_EXPIRED;
    if(upper>=expiry) return TE_SMALL_QUEUE_CLOCK_UNKNOWN;
    if(!b->config.admit_new(b->config.policy_context,kind,e,bytes,expiry)) return TE_SMALL_QUEUE_POLICY;
    return TE_SMALL_QUEUE_OK;
}
/* No expiry sweep here: a capacity query must never delete a record. The
 * caller can explicitly sweep, then retry. The subsequent store checks again. */
static te_v3_small_queue_result_t preflight(te_v3_small_queue_t *b,cp_v3_queue_kind_t kind,
    const cp_v3_expected_t *e,size_t bytes,uint64_t expiry,te_v3_small_queue_capacity_t *cap) {
    te_v3_small_queue_capacity_t c={0};
    te_v3_small_queue_result_t r=admit(b,kind,e,bytes,expiry);
    if(r!=TE_SMALL_QUEUE_OK) return r;
    if(b->storage.uncertain) return TE_SMALL_QUEUE_UNCERTAIN;
    c.encoded_bytes=cp_v3_queue_encoded_size(&b->queue,bytes);
    if(!c.encoded_bytes||c.encoded_bytes>TE_NVS_RECORD_MAX) return TE_SMALL_QUEUE_INVALID;
    unsigned index=target(kind);
    for(unsigned i=0;i<CP_V3_QUEUE_SLOTS;i++) {
        size_t n=0;
        int loaded=b->queue.store.load(b->queue.store.context,i,b->queue.scratch,sizeof b->queue.scratch,&n);
        if(loaded<0) return TE_SMALL_QUEUE_IO;
        if(loaded) c.occupied_keys++;
        if(b->queue.slots[i].state==CP_V3_QUEUE_QUARANTINED||loaded==2||loaded==4) c.quarantined_slots++;
        if(i==index) c.target_reuses_tombstone=loaded==3;
        if(loaded==1) {
            cp_v3_queue_tombstone_t identity;
            if(!cp_v3_queue_record_check(b->queue.scratch,n,i,b->config.sha256,b->config.sha_context,&identity)||
               memcmp(identity.record_sha256,b->queue.slots[i].record_sha256,32)) return TE_SMALL_QUEUE_UNCERTAIN;
        }
        /* Unexpected external changes require explicit reopen, never overwrite. */
        if((loaded==1&&b->queue.slots[i].state==CP_V3_QUEUE_FREE)||
           ((!loaded||loaded==3)&&b->queue.slots[i].state!=CP_V3_QUEUE_FREE)) return TE_SMALL_QUEUE_UNCERTAIN;
    }
    nvs_stats_t stats;
    if(nvs_get_stats(NULL,&stats)!=ESP_OK) return TE_SMALL_QUEUE_IO;
    c.available_entries=stats.available_entries;
    c.required_entries=TE_NVS_FREE_ENTRY_FLOOR+(c.encoded_bytes+31u)/32u+4u;
    if(cap) *cap=c;
    if(c.quarantined_slots) return TE_SMALL_QUEUE_UNCERTAIN;
    if(b->queue.slots[index].state!=CP_V3_QUEUE_FREE||
       c.occupied_keys-(c.target_reuses_tombstone?1u:0u)>=TE_NVS_MAX_LIVE||
       c.available_entries<c.required_entries) return TE_SMALL_QUEUE_FULL;
    return TE_SMALL_QUEUE_OK;
}
te_v3_small_queue_result_t te_v3_small_queue_open(te_v3_small_queue_t *b,
    const char *node,const char *boot,const te_v3_small_queue_config_t *cfg) {
    if(!b||!cfg||!cfg->sha256||!cfg->clock||!cfg->write_budget||!cfg->try_lock||!cfg->unlock||!cfg->admit_new) return TE_SMALL_QUEUE_INVALID;
    /* Same owner/arbitration must be retained when explicitly reopening. */
    if(b->opened&&(b->config.try_lock!=cfg->try_lock||b->config.unlock!=cfg->unlock||b->config.lock_context!=cfg->lock_context)) return TE_SMALL_QUEUE_INVALID;
    if(!cfg->try_lock(cfg->lock_context)) return TE_SMALL_QUEUE_BUSY;
    b->opened=false; b->config=*cfg;
    if(!te_nvs_store_prepare(&b->storage,&b->raw_store)||!te_nvs_store_set_hash(&b->storage,cfg->sha256,cfg->sha_context))
        return leave(b,TE_SMALL_QUEUE_INVALID);
    cp_v3_queue_store_t store={b,guarded_load,guarded_store,guarded_reclaim};
    const cp_v3_queue_profile_config_t profile={
        .profile=CP_V3_QUEUE_SMALL_RESULTS,.clock=clock_bound,.expire=expire_record,
        .retention_context=b,.limits={1,0,1,1,TE_SMALL_QUEUE_BODY_MAX},
        .allow_historical_small=true,.allow_historical_control_reclaim=true
    };
    cp_v3_queue_result_t r=cp_v3_queue_open_profile(&b->queue,store,node,boot,cfg->sha256,cfg->sha_context,&profile);
    b->opened=r==CP_V3_QUEUE_OK;
    return leave(b,result(r));
}
te_v3_small_queue_result_t te_v3_small_queue_preflight(te_v3_small_queue_t *b,
    cp_v3_queue_kind_t kind,const cp_v3_expected_t *e,size_t n,uint64_t expiry,te_v3_small_queue_capacity_t *cap) {
    if(cap) memset(cap,0,sizeof *cap);
    te_v3_small_queue_result_t r=enter(b); if(r!=TE_SMALL_QUEUE_OK) return r;
    return leave(b,preflight(b,kind,e,n,expiry,cap));
}
te_v3_small_queue_result_t te_v3_small_queue_push(te_v3_small_queue_t *b,
    cp_v3_queue_kind_t kind,const cp_v3_expected_t *e,const void *body,size_t n,uint64_t expiry,unsigned *slot) {
    te_v3_small_queue_result_t r=enter(b); if(r!=TE_SMALL_QUEUE_OK) return r;
    r=admit(b,kind,e,n,expiry);
    if(r==TE_SMALL_QUEUE_OK&&(!body||!slot)) r=TE_SMALL_QUEUE_INVALID;
    if(r==TE_SMALL_QUEUE_OK&&b->storage.uncertain) r=TE_SMALL_QUEUE_UNCERTAIN;
    /* Exact retries must reach the shared queue's complete encoded identity
     * matcher even when no new slot/space is available. */
    bool retry=false;
    if(r==TE_SMALL_QUEUE_OK) for(unsigned i=0;i<CP_V3_QUEUE_SLOTS;i++)
        if(b->queue.slots[i].state!=CP_V3_QUEUE_FREE&&!strcmp(e->batch_id,b->queue.slots[i].expected.batch_id)) retry=true;
    if(r==TE_SMALL_QUEUE_OK&&!retry) r=preflight(b,kind,e,n,expiry,NULL);
    if(r==TE_SMALL_QUEUE_OK) r=result(cp_v3_queue_push_expiring(&b->queue,kind,e,body,n,expiry,slot));
    return leave(b,r);
}
te_v3_small_queue_result_t te_v3_small_queue_oldest(te_v3_small_queue_t *b,cp_v3_queue_kind_t kind,unsigned *slot) {
    te_v3_small_queue_result_t r=enter(b); if(r!=TE_SMALL_QUEUE_OK) return r;
    uint64_t lower=0,upper=0;
    if(!clock_bound(b,&lower,&upper)||lower>upper||upper>SAFE_UTC) r=TE_SMALL_QUEUE_CLOCK_UNKNOWN;
    else r=result(cp_v3_queue_oldest(&b->queue,kind,slot));
    return leave(b,r);
}
te_v3_small_queue_result_t te_v3_small_queue_read(te_v3_small_queue_t *b,unsigned slot,void *body,size_t cap,size_t *n,cp_v3_expected_t *e) {
    te_v3_small_queue_result_t r=enter(b); if(r!=TE_SMALL_QUEUE_OK) return r;
    return leave(b,result(cp_v3_queue_read(&b->queue,slot,body,cap,n,e)));
}
te_v3_small_queue_result_t te_v3_small_queue_ack(te_v3_small_queue_t *b,unsigned slot,const void *receipt,size_t n) {
    te_v3_small_queue_result_t r=enter(b); if(r!=TE_SMALL_QUEUE_OK) return r;
    return leave(b,result(cp_v3_queue_ack(&b->queue,slot,receipt,n)));
}
te_v3_small_queue_result_t te_v3_small_queue_ack_control(te_v3_small_queue_t *b,unsigned slot,const void *receipt,size_t n,cp_v3_queue_control_match_fn match,void *ctx) {
    te_v3_small_queue_result_t r=enter(b); if(r!=TE_SMALL_QUEUE_OK) return r;
    return leave(b,result(cp_v3_queue_ack_control(&b->queue,slot,receipt,n,match,ctx)));
}
te_v3_small_queue_result_t te_v3_small_queue_expire(te_v3_small_queue_t *b) {
    te_v3_small_queue_result_t r=enter(b); if(r!=TE_SMALL_QUEUE_OK) return r;
    return leave(b,result(cp_v3_queue_expire(&b->queue)));
}
