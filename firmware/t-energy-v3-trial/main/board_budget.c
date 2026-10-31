#include "board_budget.h"
#include <string.h>

#define TE_DAY_MS UINT64_C(86400000)
#define TE_UTC_MIN UINT64_C(1704067200000)
#define TE_UTC_MAX UINT64_C(7258118400000)
static bool te_node_valid(const char *s) {
    if(!s)return false;
    size_t n=0;for(;n<65&&s[n];++n){char c=s[n];
        if(!((c>='a'&&c<='z')||(c>='A'&&c<='Z')||(c>='0'&&c<='9')||c=='_'||c=='-'||c=='.'||c==':'))return false;}
    return n>0&&n<65;
}
static bool te_live(const te_board_budget_t *b) {
    return b&&(b->state==TE_BUDGET_OPEN||b->state==TE_BUDGET_CONFIGURED);
}
bool te_board_budget_try_lock(void *ctx) {
    te_board_budget_t *b=ctx;
    if(!te_live(b)||!b->config.try_lock(b->config.lock_context))return false;
    if(b->lock_held||!te_live(b)){b->config.unlock(b->config.lock_context);return false;}
    b->lock_held=true;return true;
}
void te_board_budget_unlock(void *ctx) {
    te_board_budget_t *b=ctx;if(!b||!b->lock_held)return;
    if(b->storage.latched||b->uplink.latched)b->state=TE_BUDGET_FAILED;
    b->lock_held=false;b->config.unlock(b->config.lock_context);
}
static te_board_budget_result_t te_clock(te_board_budget_t *b,uint64_t *lo,uint64_t *hi) {
    if(!b->config.trusted_utc(b->config.clock_context,lo,hi)||*lo<TE_UTC_MIN||*hi>=TE_UTC_MAX||*lo>*hi)
        return (te_board_budget_result_t)(b->last_core_result=CP_V3_BUDGET_CLOCK_UNKNOWN);
    if(*lo/TE_DAY_MS!=*hi/TE_DAY_MS)
        return (te_board_budget_result_t)(b->last_core_result=CP_V3_BUDGET_DAY_AMBIGUOUS);
    if(b->have_clock&&*lo<b->trusted_lower_ms)return TE_BOARD_BUDGET_TIME_REGRESSION;
    b->have_clock=true;b->trusted_lower_ms=*lo;return TE_BOARD_BUDGET_OK;
}
static cp_v3_budget_load_t te_storage_load(void *ctx,void *out,size_t cap,size_t *n) {
    te_board_budget_t *b=ctx;
    if(!b->lock_held){if(n)*n=0;return CP_V3_BUDGET_LOAD_IO;}
    return b->storage_backend.load(b->storage_backend.context,out,cap,n);
}
static cp_v3_budget_load_t te_uplink_load(void *ctx,void *out,size_t cap,size_t *n) {
    te_board_budget_t *b=ctx;
    if(!b->lock_held){if(n)*n=0;return CP_V3_BUDGET_LOAD_IO;}
    return b->uplink_backend.load(b->uplink_backend.context,out,cap,n);
}
static bool te_storage_store(void *ctx,const void *record,size_t n) {
    te_board_budget_t *b=ctx;
    return b->lock_held&&b->state==TE_BUDGET_CONFIGURED&&
        b->storage_backend.store(b->storage_backend.context,record,n);
}
static bool te_uplink_store(void *ctx,const void *record,size_t n) {
    te_board_budget_t *b=ctx;cp_v3_budget_record_t next;uint64_t lo,hi;
    if(!b->lock_held||b->state!=TE_BUDGET_CONFIGURED||!cp_v3_budget_decode(record,n,&next)||
       te_clock(b,&lo,&hi)!=TE_BOARD_BUDGET_OK||next.utc_day!=lo/TE_DAY_MS)return false;
    /* Charge the actual conservative provider metadata write allowance before
     * the uplink ledger can mutate NVS. Its own core pays storage checkpoint cost.
     * No rollback/refund after either reservation or ambiguous commit. */
    b->last_core_result=cp_v3_budget_charge(&b->storage,b->uplink_backend.logical_write_bytes,lo,hi);
    return b->last_core_result==CP_V3_BUDGET_OK&&b->uplink_backend.store(b->uplink_backend.context,record,n);
}
static bool te_owner(te_board_budget_t *b,const char *domain,uint8_t out[32]) {
    static const char prefix[]="campuspulse/3\0t-energy-budget/1\0";
    uint8_t input[128];size_t n=sizeof prefix-1,domain_n=strlen(domain),node_n=strlen(b->node_id);
    memcpy(input,prefix,n);memcpy(input+n,domain,domain_n+1);n+=domain_n+1;memcpy(input+n,b->node_id,node_n);n+=node_n;
    if(!b->config.sha256(b->config.hash_context,input,n,out))return false;
    unsigned bits=0;for(unsigned i=0;i<32;++i)bits|=out[i];return bits!=0;
}
te_board_budget_result_t te_board_budget_open(te_board_budget_t *b,const char *node,const te_board_budget_config_t *cfg) {
    if(!b||!cfg||!cfg->sha256||!cfg->trusted_utc||!cfg->try_lock||!cfg->unlock||!te_node_valid(node))
        return (te_board_budget_result_t)CP_V3_BUDGET_INVALID;
    if(b->state!=TE_BUDGET_NEW)return TE_BOARD_BUDGET_STATE;
    if(!cfg->try_lock(cfg->lock_context))return TE_BOARD_BUDGET_BUSY;
    if(b->state!=TE_BUDGET_NEW){cfg->unlock(cfg->lock_context);return TE_BOARD_BUDGET_STATE;}
    b->state=TE_BUDGET_OPENING;b->config=*cfg;b->lock_held=true;strcpy(b->node_id,node);
    uint8_t storage_owner[32],uplink_owner[32];te_board_budget_result_t result=TE_BOARD_BUDGET_OK;
    if(!te_owner(b,"storage",storage_owner)||!te_owner(b,"uplink",uplink_owner)||!memcmp(storage_owner,uplink_owner,32)){
        result=TE_BOARD_BUDGET_HASH;goto finish;}
    b->last_nvs_error=cp_v3_budget_nvs_open(&b->storage_nvs,TE_BUDGET_STORAGE_NAMESPACE,&b->storage_backend);
    if(b->last_nvs_error!=ESP_OK){result=TE_BOARD_BUDGET_NVS;goto finish;}
    b->last_core_result=cp_v3_budget_open(&b->storage,b->storage_backend,storage_owner);
    if(b->last_core_result!=CP_V3_BUDGET_OK){result=(te_board_budget_result_t)b->last_core_result;goto finish;}
    b->last_nvs_error=cp_v3_budget_nvs_open(&b->uplink_nvs,TE_BUDGET_UPLINK_NAMESPACE,&b->uplink_backend);
    if(b->last_nvs_error!=ESP_OK){result=TE_BOARD_BUDGET_NVS;goto finish;}
    b->last_core_result=cp_v3_budget_open(&b->uplink,b->uplink_backend,uplink_owner);
    if(b->last_core_result!=CP_V3_BUDGET_OK){result=(te_board_budget_result_t)b->last_core_result;goto finish;}
    b->storage.store=(cp_v3_budget_store_t){b,te_storage_load,te_storage_store,b->storage_backend.logical_write_bytes};
    b->uplink.store=(cp_v3_budget_store_t){b,te_uplink_load,te_uplink_store,b->uplink_backend.logical_write_bytes};
finish:
    b->state=result==TE_BOARD_BUDGET_OK?TE_BUDGET_OPEN:TE_BUDGET_FAILED;
    b->lock_held=false;cfg->unlock(cfg->lock_context);return result;
}
static bool te_limits(uint64_t a,uint64_t b,uint64_t aq,uint64_t bq) {
    return a<=CP_V3_BUDGET_MAX_BYTES&&b<=CP_V3_BUDGET_MAX_BYTES&&aq&&bq&&
        aq<=CP_V3_BUDGET_MAX_BYTES&&bq<=CP_V3_BUDGET_MAX_BYTES;
}
static te_board_budget_result_t te_configure(te_board_budget_t *b,uint64_t storage,uint64_t uplink,uint64_t sq,uint64_t uq) {
    if(b->storage.configured&&storage>b->storage.limit_bytes)storage=b->storage.limit_bytes;
    if(b->uplink.configured&&uplink>b->uplink.limit_bytes)uplink=b->uplink.limit_bytes;
    b->last_core_result=cp_v3_budget_configure(&b->storage,storage,sq);
    if(b->last_core_result==CP_V3_BUDGET_OK)b->last_core_result=cp_v3_budget_configure(&b->uplink,uplink,uq);
    if(b->last_core_result!=CP_V3_BUDGET_OK){b->state=TE_BUDGET_FAILED;return (te_board_budget_result_t)b->last_core_result;}
    b->state=TE_BUDGET_CONFIGURED;return TE_BOARD_BUDGET_OK;
}
te_board_budget_result_t te_board_budget_accept_local_test(te_board_budget_t *b,const te_board_budget_local_test_t *a) {
    if(!te_live(b)||!a||a->authorization!=TE_BUDGET_EXPLICIT_LOCAL_TEST||!memchr(a->node_id,0,sizeof a->node_id)||
       strcmp(a->node_id,b->node_id)||!te_limits(a->storage_limit,a->uplink_limit,a->storage_quantum,a->uplink_quantum))return TE_BOARD_BUDGET_AUTHORIZATION;
    if(!te_board_budget_try_lock(b))return TE_BOARD_BUDGET_BUSY;
    te_board_budget_result_t r=TE_BOARD_BUDGET_AUTHORIZATION;
    if(!b->policy_bound&&!b->local_test_bound){r=te_configure(b,a->storage_limit,a->uplink_limit,a->storage_quantum,a->uplink_quantum);
        if(r==TE_BOARD_BUDGET_OK)b->local_test_bound=true;}
    te_board_budget_unlock(b);return r;
}
te_board_budget_result_t te_board_budget_bind_policy(te_board_budget_t *b,const cp_v3_control_t *c) {
    if(!te_live(b)||!c||!c->small_statistics||!c->policy.statistics||!c->policy_length||
       (c->state!=CP_V3_CONTROL_OFFERED&&c->state!=CP_V3_CONTROL_ACK_PENDING&&c->state!=CP_V3_CONTROL_APPLIED&&c->state!=CP_V3_CONTROL_PAUSED)||
       !memchr(c->policy.scope.node_id,0,sizeof c->policy.scope.node_id)||strcmp(c->policy.scope.node_id,b->node_id)||
       !memchr(c->policy.scope.policy_sha256,0,sizeof c->policy.scope.policy_sha256)||strlen(c->policy.scope.policy_sha256)!=64||
       !c->policy.scope.assignment_generation||!te_limits(c->policy.storage_write_bytes_per_day,c->policy.max_upload_bytes_per_day,1,1))return TE_BOARD_BUDGET_AUTHORIZATION;
    if(!te_board_budget_try_lock(b))return TE_BOARD_BUDGET_BUSY;
    te_board_budget_result_t r=TE_BOARD_BUDGET_AUTHORIZATION;
    if(!b->policy_bound||c->policy.scope.assignment_generation>b->policy_generation||
       (c->policy.scope.assignment_generation==b->policy_generation&&!strcmp(c->policy.scope.policy_sha256,b->policy_hash))){
        r=te_configure(b,c->policy.storage_write_bytes_per_day,c->policy.max_upload_bytes_per_day,
            b->storage.configured?b->storage.quantum_bytes:CP_V3_BUDGET_DEFAULT_QUANTUM,
            b->uplink.configured?b->uplink.quantum_bytes:CP_V3_BUDGET_DEFAULT_QUANTUM);
        if(r==TE_BOARD_BUDGET_OK){b->policy_bound=true;b->policy_generation=c->policy.scope.assignment_generation;strcpy(b->policy_hash,c->policy.scope.policy_sha256);}
    }
    te_board_budget_unlock(b);return r;
}
te_board_budget_result_t te_board_budget_charge(te_board_budget_t *b,te_board_budget_domain_t domain,uint64_t bytes) {
    if(!b||b->state!=TE_BUDGET_CONFIGURED)return TE_BOARD_BUDGET_STATE;
    if(domain!=TE_BUDGET_STORAGE&&domain!=TE_BUDGET_UPLINK)return (te_board_budget_result_t)CP_V3_BUDGET_INVALID;
    if(!te_board_budget_try_lock(b))return TE_BOARD_BUDGET_BUSY;
    uint64_t lo,hi;te_board_budget_result_t r=te_clock(b,&lo,&hi);
    if(r==TE_BOARD_BUDGET_OK){b->last_core_result=cp_v3_budget_charge(domain==TE_BUDGET_STORAGE?&b->storage:&b->uplink,bytes,lo,hi);
        r=(te_board_budget_result_t)b->last_core_result;}
    te_board_budget_unlock(b);return r;
}
