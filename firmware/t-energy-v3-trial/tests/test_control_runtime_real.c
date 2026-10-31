/* Synthetic host only: real control verifier, board queue, NVS adapter and SHA-256. */
#include <stdlib.h>

#include "queue_support.h"

#include "board_runtime_adapters.h"
/* Historical receipt-only transport is outside this test's TLS mock. */
esp_err_t cp_v3_transport_request_receipt_only(cp_v3_http_method_t method,const char *path,
    const void *body,size_t length,char *response,size_t capacity,cp_v3_transport_response_t *result) {
    (void)method;(void)path;(void)body;(void)length;(void)response;(void)capacity;(void)result;
    return ESP_FAIL;
}
void control_capability_fixture(te_v3_capability_request_t *);
const char *control_offer_fixture(void);
void control_capability_fixture_free(void);
static te_runtime_window_adapter_t adapter;
static cp_v3_control_t ctl;
static cp_v3_control_workspace_t ws;
static te_v3_capability_request_t cap;
static cp_settings_t settings;
static cp_v3_transport_config_t transport;
static te_v3_shared_capture_t capture;
static bool tamper;
static unsigned posts,starts,applies;
static unsigned char lease_frozen[TE_NVS_RECORD_MAX];static size_t lease_frozen_n;
static void unlock_budget(void *ctx){lock_release(ctx);}
static bool empty(void *ctx){(void)ctx;return true;}
static cp_v3_apply_result_t apply_policy(void *ctx,const cp_v3_trial_policy_t *p,cp_v3_boundary_t *b){(void)ctx;(void)b;assert(p->statistics);applies++;applied_scope=p->scope;return CP_V3_APPLY_OK;}
esp_err_t cp_v3_transport_start(const cp_settings_t *s,const cp_v3_transport_config_t *c){(void)s;(void)c;return ESP_OK;}
esp_err_t cp_v3_transport_time(cp_v3_time_t *t){*t=(cp_v3_time_t){.mono_ms=60000,.utc_ms=1793318460000ULL,.clock_epoch=1,.uncertainty_ms=10};return ESP_OK;}
bool cp_v3_transport_sha256(void *ctx,const void *p,size_t n,uint8_t out[32]){return sha_real(ctx,p,n,out);}
esp_err_t cp_v3_transport_request(cp_v3_http_method_t method,const char *path,const void *body,size_t n,char *out,size_t capout,cp_v3_transport_response_t *result){
    int written=0; char digest[65];
    if(method==CP_V3_HTTP_GET) {
        const char *fixture=adapter.registered?control_offer_fixture():"{}";
        written=snprintf(out,capout,"%s",fixture);
    } else if(strstr(path,"capabilities")) {
        posts++; written=snprintf(out,capout,"{\"protocol\":\"campuspulse/3\",\"node_id\":\"%s\",\"boot_id\":\"%s\",\"registration_seq\":1,\"capability_sha256\":\"%s\",\"registered_at\":\"2026-10-30T00:01:00.000Z\",\"applied\":false,\"capability_evidence\":\"device_claim\"}",ctl.node_id,ctl.boot_id,ctl.capability_sha256);
    } else if(strstr(path,"config/ack")) {
        posts++; assert(n>1 && ((const char *)body)[n-1]=='}'); digest_real(body,n,digest);
        assert(n<capout);memcpy(out,body,n-1);
        written=(int)n-1+snprintf(out+n-1,capout-n+1,",\"node_id\":\"%s\",\"received_at\":\"2026-10-30T00:01:00.000Z\",\"body_sha256\":\"%s\",\"durability\":\"committed\",\"evidence\":\"device_ack\",\"server_time\":\"2026-10-30T00:01:00.000Z\",\"lease_until_ms\":1793318580000,\"contact_seq\":0}",ctl.node_id,digest);
    } else {
        assert(strstr(path,"lease"));posts++;digest_real(body,n,digest);
        lease_frozen_n=lengths[2];assert(lease_frozen_n);memcpy(lease_frozen,values[2],lease_frozen_n);
        written=snprintf(out,capout,"{\"protocol\":\"campuspulse/3\",\"schema\":\"device-lease/3\",\"node_id\":\"%s\",\"boot_id\":\"%s\",\"policy_id\":\"%s\",\"policy_sha256\":\"%s\",\"assignment_generation\":1,\"contact_seq\":%u,\"uptime_ms\":%llu,\"body_sha256\":\"%s\",\"durability\":\"committed\",\"server_time\":\"2026-10-30T00:01:00.000Z\",\"lease_until_ms\":1793318580000,\"span_seq\":1,\"contiguous\":true}",ctl.node_id,ctl.boot_id,ctl.policy.scope.policy_id,ctl.policy.scope.policy_sha256,(unsigned)ctl.pending_contact_seq,(unsigned long long)ctl.pending_uptime_ms,digest);
    }
    assert(written>0&&(size_t)written<capout);
    if(tamper && method==CP_V3_HTTP_POST && !strstr(path,"capabilities")){char *p=strstr(out,"body_sha256\":\"");assert(p);p+=14;*p=*p=='0'?'1':'0';}
    *result=(cp_v3_transport_response_t){.complete=true,.stage=CP_V3_TRANSPORT_COMPLETE,.tls_connected=1,.http_status=200,.body_bytes=(size_t)written};return ESP_OK;
}
/* Uplink budget denial is injected at its persistence boundary, real budget code remains linked. */
static bool uplink_lock(void *ctx){return lock_try(ctx);}
esp_err_t te_v3_shared_capture_start(te_v3_shared_capture_t *c,cp_v3_control_t *k,cp_v3_time_t t,uint32_t s,bool q){(void)c;(void)k;(void)t;(void)s;(void)q;starts++;return ESP_OK;}
bool te_v3_shared_capture_window(te_v3_shared_capture_t *c,cp_v3_capture_window_t *w){(void)c;(void)w;return false;}
bool te_v3_shared_capture_window_release(te_v3_shared_capture_t *c,const cp_v3_capture_window_t *w){(void)c;(void)w;return false;}
esp_err_t te_v3_shared_capture_maintain(te_v3_shared_capture_t *c,cp_v3_control_t *k,cp_v3_time_t t,bool r){(void)c;(void)k;(void)t;(void)r;return ESP_FAIL;}
esp_err_t te_v3_shared_capture_pause(te_v3_shared_capture_t *c,cp_v3_temporal_reason_t r,uint32_t n){(void)c;(void)r;(void)n;return ESP_FAIL;}
bool te_v3_window_freeze(void *c,const void *s,size_t sn,void *b,size_t cap,size_t *n,void *id,size_t ic,size_t *in){(void)c;(void)s;(void)sn;(void)b;(void)cap;(void)n;(void)id;(void)ic;(void)in;return false;}
static bool queue_ready(void *ctx){(void)ctx;return true;}
int main(void){
    fresh(); node_id="synthetic-te-notregister";boot_id="11111111-1111-4111-8111-111111111111";
    utc_lower=1793318459990ULL;utc_upper=1793318460010ULL;deadline=1793325660000ULL;
    memset(&board,0,sizeof board);te_v3_small_queue_config_t cfg=config();assert(te_v3_small_queue_open(&board,node_id,boot_id,&cfg)==TE_SMALL_QUEUE_OK);
    control_capability_fixture(&cap);
    adapter=(te_runtime_window_adapter_t){.queue=&board,.capture=&capture,.control=&ctl,.settings=&settings,.transport_config=&transport,.capability=&cap,.workspace=&ws,.uplink_budget=&budget,.budget_lock=uplink_lock,.budget_unlock=unlock_budget,.registration_seq=1,.apply_seq=1,.lease_contact_seq=1,.next_window_seq=4,.actual_apply=apply_policy,.backlog_audit_empty=empty,.queue_ready=queue_ready,.closed_boundary={.closed_window_seq=3,.closed_segment_seq=2}};
    strcpy(adapter.ack_batch_id,"00000000-0000-4000-8000-000000000001");strcpy(adapter.lease_batch_id,"00000000-0000-4000-8000-000000000002");
    assert(te_runtime_window_perform(&adapter,TE_RT_CONNECT)==TE_RT_OK);
    assert(te_runtime_window_perform(&adapter,TE_RT_START)==TE_RT_FAIL&&!starts);
    assert(te_runtime_window_perform(&adapter,TE_RT_REGISTER)==TE_RT_OK);
    assert(te_runtime_window_perform(&adapter,TE_RT_VALIDATE)==TE_RT_OK&&applies==1);
    assert(te_runtime_window_perform(&adapter,TE_RT_ACK_FREEZE)==TE_RT_OK);
    assert(te_runtime_window_perform(&adapter,TE_RT_ACK_STORE)==TE_RT_OK&&lengths[2]);
    unsigned char frozen[TE_NVS_RECORD_MAX];size_t frozen_n=lengths[2];memcpy(frozen,values[2],frozen_n);
    assert(te_runtime_window_perform(&adapter,TE_RT_START)==TE_RT_FAIL&&!starts);
    unsigned sent=posts;assert(cp_v3_budget_configure(&budget,0,CP_V3_BUDGET_DEFAULT_QUANTUM)==CP_V3_BUDGET_OK);
    assert(te_runtime_window_perform(&adapter,TE_RT_ACK_SEND)==TE_RT_FAIL&&posts==sent&&lengths[2]==frozen_n&&!memcmp(frozen,values[2],frozen_n));
    assert(cp_v3_budget_configure(&budget,UINT64_C(1)<<30,CP_V3_BUDGET_DEFAULT_QUANTUM)==CP_V3_BUDGET_OK);
    tamper=true;assert(te_runtime_window_perform(&adapter,TE_RT_ACK_SEND)==TE_RT_FAIL&&lengths[2]==frozen_n&&!memcmp(frozen,values[2],frozen_n));tamper=false;
    assert(te_runtime_window_perform(&adapter,TE_RT_ACK_SEND)==TE_RT_OK&&!lengths[2]);
    assert(te_runtime_window_perform(&adapter,TE_RT_START)==TE_RT_FAIL&&!starts);
    if(getenv("TEST_BAD_LEASE")) {
        tamper=true;assert(te_runtime_window_perform(&adapter,TE_RT_LEASE)==TE_RT_FAIL&&lengths[2]&&!adapter.lease_committed);
        assert(lengths[2]==lease_frozen_n&&!memcmp(values[2],lease_frozen,lease_frozen_n));
        assert(te_runtime_window_perform(&adapter,TE_RT_START)==TE_RT_FAIL&&!starts);
        tamper=false;assert(te_runtime_window_perform(&adapter,TE_RT_LEASE)==TE_RT_OK&&!lengths[2]);
        assert(te_runtime_window_perform(&adapter,TE_RT_START)==TE_RT_OK&&starts==1);
        control_capability_fixture_free();puts("tampered lease retained; START blocked until exact retry");return 0;
    }
    assert(te_runtime_window_perform(&adapter,TE_RT_LEASE)==TE_RT_OK&&!lengths[2]);
    assert(te_runtime_window_perform(&adapter,TE_RT_START)==TE_RT_OK&&starts==1);
    control_capability_fixture_free();puts("real control runtime/NVS synthetic path passed");
}
