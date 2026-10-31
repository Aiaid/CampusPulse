#include "board_runtime_adapters.h"
#include <assert.h>
#include <string.h>
#include <stdio.h>
static bool durable,released,acknowledged,good_receipt=true,store_error;
static bool historical_pending,historical_allowed,historical_mode,historical_control_pending;
/* Stateful ordering mocks only: production JSON receipt, TLS, persistent
 * budgets and NVS are validated by the separate real-component host suites. */
static const char old_body[]="{\"original\": \"frozen control\"}\n";
static cp_v3_expected_t frozen_control;
typedef struct { cp_v3_expected_t expected; char body[sizeof old_body]; bool committed; } mock_receipt_t;
static bool unknown_clock,control_ack_error;
static unsigned receipt_posts,matches,control_acks,charges;
static uint64_t last_charge;
typedef enum { REPLAY_OK,REPLAY_409,REPLAY_TLS,REPLAY_ERROR,REPLAY_INCOMPLETE,REPLAY_BAD,REPLAY_BOOT,REPLAY_SCOPE } replay_fault_t;
static replay_fault_t replay_fault;
static unsigned entropy_serial,reservations;
static bool entropy_fail,identity_reject,repeat_entropy;
static bool entropy(void *v,uint8_t out[16]) {(void)v;if(entropy_fail)return false;memset(out,1,16);out[0]=repeat_entropy?1:(uint8_t)++entropy_serial;return true;}
static bool reserve(void *v,const char *node,const char *boot,const char *id,uint32_t seq) {(void)v;assert(*node && *boot && *id && seq);reservations++;return !identity_reject;}
static cp_v3_capture_window_t window;
static cp_v3_expected_t expected;
static bool sha(void *c,const void *p,size_t n,uint8_t d[32]) { (void)c; memset(d,0,32); const unsigned char *b=p; for(size_t i=0;i<n;i++)d[i%32]^=b[i]; return true; }
static bool now(void *c,cp_v3_time_t *t) {(void)c; memset(t,0,sizeof *t); return true;}
static bool ready(void *c) {(void)c; return true;}
static bool backlog_empty(void *c) {(void)c; return true;}
static bool history_ok(void *c,cp_v3_queue_kind_t k,const void *body,size_t n,const cp_v3_expected_t *e,cp_v3_time_t t) {
    (void)c;(void)t;
    if(k==CP_V3_QUEUE_CONTROL)return historical_allowed && n==sizeof old_body-1 && !memcmp(body,old_body,n) && !memcmp(e,&frozen_control,sizeof *e);
    assert(k==CP_V3_QUEUE_WINDOW && n==3 && !memcmp(body,"abc",3) && !memcmp(e,&expected,sizeof *e));
    return historical_allowed;
}
static bool history_aged(void *c,const void *body,size_t n,const cp_v3_expected_t *e,cp_v3_time_t t) {
    return history_ok(c,CP_V3_QUEUE_WINDOW,body,n,e,t);
}
static bool post(void *c,const void *b,size_t n,const cp_v3_expected_t *e,void *r,size_t cap,size_t *rn) {
    (void)c; assert((historical_mode || released) && durable && n==3 && !memcmp(b,"abc",3) && !memcmp(e,&expected,sizeof *e));
    assert(cap>=1); ((char *)r)[0]=good_receipt?'Y':'N'; *rn=1; return true;
}
bool cp_v3_statistics_receipt_matches(const void *r,size_t n,const cp_v3_expected_t *e) {return n==1 && *(const char *)r=='Y' && !memcmp(e,&expected,sizeof *e);}
bool te_v3_shared_capture_window(te_v3_shared_capture_t *c,cp_v3_capture_window_t *w) {(void)c; *w=window; return true;}
bool te_v3_shared_capture_window_release(te_v3_shared_capture_t *c,const cp_v3_capture_window_t *w) {(void)c; assert(durable && !memcmp(w,&window,sizeof window)); released=true;return true;}
esp_err_t te_v3_shared_capture_maintain(te_v3_shared_capture_t *c,cp_v3_control_t *k,cp_v3_time_t t,bool r) {(void)c;(void)k;(void)t;return r?ESP_OK:ESP_FAIL;}
esp_err_t te_v3_shared_capture_pause(te_v3_shared_capture_t *c,cp_v3_temporal_reason_t r,uint32_t n) {(void)c;(void)r;(void)n;return ESP_OK;}
bool te_v3_window_freeze(void *c,const void *s,size_t sn,void *b,size_t cap,size_t *n,void *id,size_t ic,size_t *in) {
    (void)c;assert(sn==sizeof window&&!memcmp(s,&window,sn)&&cap>=3&&ic>=sizeof expected);memcpy(b,"abc",3);*n=3;memcpy(id,&expected,sizeof expected);*in=sizeof expected;return true;
}
te_v3_small_queue_result_t te_v3_small_queue_push(te_v3_small_queue_t *q,cp_v3_queue_kind_t k,const cp_v3_expected_t *e,const void *b,size_t n,uint64_t x,unsigned *slot) {
    (void)q;if(acknowledged){released=false;acknowledged=false;durable=false;}assert(k==CP_V3_QUEUE_WINDOW && !released && n==3 && !memcmp(b,"abc",3) && !memcmp(e,&expected,sizeof *e) && x==10);if(store_error)return TE_SMALL_QUEUE_UNCERTAIN; durable=true;*slot=2;return TE_SMALL_QUEUE_OK;
}
te_v3_small_queue_result_t te_v3_small_queue_read(te_v3_small_queue_t *q,unsigned slot,void *b,size_t cap,size_t *n,cp_v3_expected_t *e) {
    (void)q;assert(durable&&slot==2&&cap>=sizeof old_body);
    if(historical_control_pending){memcpy(b,old_body,sizeof old_body-1);*n=sizeof old_body-1;}else{memcpy(b,"abc",3);*n=3;}
    *e=expected;return TE_SMALL_QUEUE_OK;
}
te_v3_small_queue_result_t te_v3_small_queue_ack(te_v3_small_queue_t *q,unsigned slot,const void *r,size_t n) {(void)q;assert(slot==2&&(historical_mode||released)&&n==1&&*(const char *)r=='Y');acknowledged=true;historical_pending=false;return TE_SMALL_QUEUE_OK;}
static te_runtime_window_adapter_t a;
static te_v3_small_queue_t q;
static te_v3_shared_capture_t c;
static cp_v3_control_t control;
static te_v3_window_freeze_t f;
static cp_settings_t settings;
static cp_v3_transport_config_t transport_config;
static te_v3_capability_request_t cap;
static cp_v3_control_workspace_t workspace;
static cp_v3_budget_t budget;
static bool simulate_tls_bad, simulate_budget_bad;
static unsigned posts;
static bool budget_lock(void *p) {(void)p;return true;}
static void budget_unlock(void *p) {(void)p;}
static void reset_test(void) {historical_pending=historical_allowed=historical_mode=historical_control_pending=false;unknown_clock=control_ack_error=simulate_tls_bad=false;receipt_posts=matches=control_acks=charges=posts=0;last_charge=0;replay_fault=REPLAY_OK;memset(&a,0,sizeof a);memset(&control,0,sizeof control);memset(&f,0,sizeof f);durable=released=acknowledged=store_error=false;good_receipt=true;simulate_budget_bad=false;entropy_fail=identity_reject=repeat_entropy=false;entropy_serial=reservations=0;strcpy(control.node_id,"test");strcpy(control.boot_id,"00000000-0000-4000-8000-000000000001");control.policy.accept_until_utc_ms=10;f.sha256=sha;a.queue=&q;a.capture=&c;a.control=&control;a.freeze=&f;a.expiry_utc_ms=10;a.now=now;a.queue_ready=ready;a.post_statistics=post;a.uplink_budget=&budget;a.budget_lock=budget_lock;a.budget_unlock=budget_unlock;a.entropy=entropy;a.reserve_identity=reserve;}
static void setup_old_control(const char *stream) {
    reset_test();memset(&cap,0,sizeof cap);strcpy(cap.node_id,"test");strcpy(cap.boot_id,control.boot_id);
    memset(&q,0,sizeof q);q.opened=true;strcpy(q.queue.node_id,cap.node_id);strcpy(q.queue.boot_id,cap.boot_id);
    memset(&budget,0,sizeof budget);budget.opened=budget.configured=true;q.config.write_budget=&budget;
    memset(&expected,0,sizeof expected);strcpy(expected.scope.node_id,"test");
    strcpy(expected.scope.boot_id,"00000000-0000-4000-8000-000000000002");
    strcpy(expected.scope.policy_id,"original-policy");strcpy(expected.scope.placement_id,"original-placement");
    strcpy(expected.scope.dataset,"research");expected.scope.assignment_generation=7;
    strcpy(expected.stream,stream);expected.seq_first=expected.seq_last=11;expected.accepted_count=1;
    expected.body_bytes=sizeof old_body-1;frozen_control=expected;
    a.settings=&settings;a.transport_config=&transport_config;a.capability=&cap;a.workspace=&workspace;
    a.registration_seq=1;a.backlog_audit_empty=backlog_empty;a.historical_authorized=history_ok;
    historical_control_pending=historical_allowed=durable=true;
}
static void no_new_authority(void) {
    assert(!a.registered && !a.ack_committed && !a.lease_committed);
    assert(control.state==CP_V3_CONTROL_EMPTY && !control.acknowledged_at_utc_ms && !strcmp(control.boot_id,cap.boot_id));
    assert(te_runtime_window_perform(&a,TE_RT_START)==TE_RT_FAIL);
}
static void failed_recovery(unsigned calls,unsigned charged) {
    assert(te_runtime_window_perform(&a,TE_RT_CONNECT)==TE_RT_FAIL);
    assert(historical_control_pending && !acknowledged && control_acks==0 && posts==0);
    assert(receipt_posts==calls && charges==charged);no_new_authority();
    assert(te_runtime_window_perform(&a,TE_RT_REGISTER)==TE_RT_FAIL && posts==0);
}
static void test_old_control_recovery(void) {
    const char *streams[]={"config_ack","lease"};
    for(unsigned i=0;i<2;i++) {
        for(replay_fault_t fault=REPLAY_409;fault<=REPLAY_SCOPE;fault++) {
            setup_old_control(streams[i]);replay_fault=fault;failed_recovery(1,1);assert(last_charge==sizeof old_body-1);
            /* Retry the original queue entry in the same adapter, without
             * rebuilding its body or resetting the historical identity. */
            replay_fault=REPLAY_OK;
            assert(te_runtime_window_perform(&a,TE_RT_RECOVER)==TE_RT_OK);
            assert(!historical_control_pending && acknowledged && receipt_posts==2 && charges==2 && posts==0);
            no_new_authority();
            assert(te_runtime_window_perform(&a,TE_RT_RECOVER)==TE_RT_EMPTY && a.recovery_complete);
            assert(te_runtime_window_perform(&a,TE_RT_REGISTER)==TE_RT_OK && posts==1);
        }
        setup_old_control(streams[i]);unknown_clock=true;failed_recovery(0,0);
        setup_old_control(streams[i]);simulate_budget_bad=true;failed_recovery(0,1);
        setup_old_control(streams[i]);historical_allowed=false;failed_recovery(0,0);
        setup_old_control(streams[i]);strcpy(expected.scope.node_id,"other");failed_recovery(0,0);
        setup_old_control(streams[i]);strcpy(expected.scope.boot_id,cap.boot_id);failed_recovery(0,0);
        /* There is no user_id in wire scope. A different user's policy,
         * placement, dataset or assignment must fail the exact local guard. */
        setup_old_control(streams[i]);strcpy(expected.scope.policy_id,"other-user-policy");failed_recovery(0,0);
        setup_old_control(streams[i]);strcpy(expected.scope.placement_id,"other-placement");failed_recovery(0,0);
        setup_old_control(streams[i]);strcpy(expected.scope.dataset,"other");failed_recovery(0,0);
        setup_old_control(streams[i]);expected.scope.assignment_generation++;failed_recovery(0,0);
        setup_old_control(streams[i]);control_ack_error=true;
        assert(te_runtime_window_perform(&a,TE_RT_CONNECT)==TE_RT_FAIL);
        assert(historical_control_pending && !acknowledged && control_acks==1 && posts==0);no_new_authority();
        assert(te_runtime_window_perform(&a,TE_RT_REGISTER)==TE_RT_FAIL && posts==0);
        setup_old_control(streams[i]);
        assert(te_runtime_window_perform(&a,TE_RT_CONNECT)==TE_RT_OK);
        assert(!historical_control_pending && acknowledged && control_acks==1 && matches==2);
        assert(receipt_posts==1 && posts==0 && a.recovery_complete);no_new_authority();
        assert(te_runtime_window_perform(&a,TE_RT_REGISTER)==TE_RT_OK && a.registered && posts==1);
        assert(!a.ack_committed && !a.lease_committed);
    }
    setup_old_control("node_status");failed_recovery(0,0);
}
int main(void) {
    reset_test();assert(te_runtime_window_perform(&a,TE_RT_CONNECT)==TE_RT_FAIL);
    assert(te_runtime_window_perform(&a,TE_RT_RELEASE)==TE_RT_FAIL);
    assert(te_runtime_window_perform(&a,TE_RT_MONITOR)==TE_RT_OK);
    assert(te_runtime_window_perform(&a,TE_RT_PEEK)==TE_RT_OK);
    char first_id[37];memcpy(first_id,f.batch_id,sizeof first_id);assert(f.seq==1 && reservations==1);
    assert(te_runtime_window_perform(&a,TE_RT_FREEZE)==TE_RT_OK);
    assert(te_runtime_window_perform(&a,TE_RT_STORE)==TE_RT_OK);
    assert(te_runtime_window_perform(&a,TE_RT_RELEASE)==TE_RT_OK);
    simulate_budget_bad=true; assert(te_runtime_window_perform(&a,TE_RT_SEND)==TE_RT_FAIL && !acknowledged);
    simulate_budget_bad=false;
    good_receipt=false;assert(te_runtime_window_perform(&a,TE_RT_SEND)==TE_RT_FAIL && !acknowledged);
    good_receipt=true;assert(te_runtime_window_perform(&a,TE_RT_SEND)==TE_RT_OK && acknowledged);
    assert(te_runtime_window_perform(&a,TE_RT_PEEK)==TE_RT_OK && f.seq==2 && strcmp(first_id,f.batch_id) && reservations==2);
    assert(te_runtime_window_perform(&a,TE_RT_FREEZE)==TE_RT_OK);
    assert(te_runtime_window_perform(&a,TE_RT_STORE)==TE_RT_OK);
    assert(te_runtime_window_perform(&a,TE_RT_RELEASE)==TE_RT_OK);
    assert(te_runtime_window_perform(&a,TE_RT_SEND)==TE_RT_OK);
    repeat_entropy=true; assert(te_runtime_window_perform(&a,TE_RT_PEEK)==TE_RT_FAIL && a.sent && a.identity_fault && reservations==2);
    repeat_entropy=false; assert(te_runtime_window_perform(&a,TE_RT_PEEK)==TE_RT_FAIL && a.sent && reservations==2);
    reset_test(); entropy_fail=true; assert(te_runtime_window_perform(&a,TE_RT_PEEK)==TE_RT_FAIL && a.identity_fault && reservations==0);
    reset_test(); a.window_seq=UINT32_MAX; assert(te_runtime_window_perform(&a,TE_RT_PEEK)==TE_RT_FAIL && reservations==0);
    /* A fresh RAM instance cannot reuse a persisted node/boot/sequence: the
     * durable reservation provider rejects the duplicate. */
    reset_test(); identity_reject=true; assert(te_runtime_window_perform(&a,TE_RT_PEEK)==TE_RT_FAIL && reservations==1 && a.identity_fault);
    reset_test(); strcpy(control.boot_id,"00000000-0000-4000-8000-000000000002");
    assert(te_runtime_window_perform(&a,TE_RT_PEEK)==TE_RT_OK && f.seq==1 && !strcmp(a.identity_boot,control.boot_id));
    reset_test();assert(te_runtime_window_perform(&a,TE_RT_PEEK)==TE_RT_OK);assert(te_runtime_window_perform(&a,TE_RT_FREEZE)==TE_RT_OK);store_error=true;
    assert(te_runtime_window_perform(&a,TE_RT_STORE)==TE_RT_FAIL && !released && a.handoff.state==TE_HANDOFF_FROZEN);
    reset_test(); memset(&cap,0,sizeof cap); strcpy(cap.node_id,"test");
    strcpy(cap.boot_id,"00000000-0000-4000-8000-000000000001");
    memset(&q,0,sizeof q); q.opened=true; strcpy(q.queue.node_id,cap.node_id); strcpy(q.queue.boot_id,cap.boot_id);
    memset(&budget,0,sizeof budget); budget.opened=true; budget.configured=true; q.config.write_budget=&budget;
    a.settings=&settings; a.transport_config=&transport_config; a.capability=&cap; a.workspace=&workspace;
    a.uplink_budget=&budget; a.budget_lock=budget_lock; a.budget_unlock=budget_unlock; a.registration_seq=1;
    a.backlog_audit_empty=backlog_empty;
    simulate_tls_bad=true; assert(te_runtime_window_perform(&a,TE_RT_CONNECT)==TE_RT_FAIL && !a.tls_verified);
    a.transport_started=false; simulate_tls_bad=false;
    assert(te_runtime_window_perform(&a,TE_RT_CONNECT)==TE_RT_OK && a.tls_verified);
    simulate_budget_bad=true; posts=0;
    assert(te_runtime_window_perform(&a,TE_RT_REGISTER)==TE_RT_FAIL && posts==0 && !a.registered);
    simulate_budget_bad=false;
    assert(te_runtime_window_perform(&a,TE_RT_REGISTER)==TE_RT_OK && posts==1 && a.registered);
    assert(te_runtime_window_perform(&a,TE_RT_VALIDATE)==TE_RT_FAIL);
    control.state=CP_V3_CONTROL_ACK_PENDING;
    assert(te_runtime_window_perform(&a,TE_RT_RECOVER)==TE_RT_EMPTY);
    assert(te_runtime_window_perform(&a,TE_RT_ACK_FREEZE)==TE_RT_FAIL);
    assert(te_runtime_window_perform(&a,TE_RT_ACK_STORE)==TE_RT_FAIL);
    assert(te_runtime_window_perform(&a,TE_RT_ACK_SEND)==TE_RT_FAIL);
    assert(te_runtime_window_perform(&a,TE_RT_LEASE)==TE_RT_FAIL);
    assert(te_runtime_window_perform(&a,TE_RT_START)==TE_RT_FAIL);
    /* Same-node old-boot windows recover before registration only with a
     * separately proven historical authorization and an exact receipt. */
    reset_test(); memset(&cap,0,sizeof cap); strcpy(cap.node_id,"test");
    strcpy(cap.boot_id,"00000000-0000-4000-8000-000000000001");
    memset(&q,0,sizeof q);q.opened=true;strcpy(q.queue.node_id,cap.node_id);strcpy(q.queue.boot_id,cap.boot_id);
    memset(&budget,0,sizeof budget);budget.opened=true;budget.configured=true;q.config.write_budget=&budget;
    memset(&expected,0,sizeof expected);strcpy(expected.scope.node_id,"test");
    strcpy(expected.scope.boot_id,"00000000-0000-4000-8000-000000000002");strcpy(expected.stream,"window_statistics");
    a.settings=&settings;a.transport_config=&transport_config;a.capability=&cap;a.workspace=&workspace;
    a.backlog_audit_empty=backlog_empty;a.historical_aged=history_aged;a.historical_authorized=history_ok;
    historical_mode=historical_pending=durable=true;historical_allowed=false;
    assert(te_runtime_window_perform(&a,TE_RT_CONNECT)==TE_RT_FAIL && historical_pending && !acknowledged);
    a.transport_started=false;historical_allowed=true;
    assert(te_runtime_window_perform(&a,TE_RT_CONNECT)==TE_RT_OK && !historical_pending && acknowledged && !a.registered);
    a.transport_started=false;a.tls_verified=false;acknowledged=false;posts=0;historical_control_pending=true;
    assert(te_runtime_window_perform(&a,TE_RT_CONNECT)==TE_RT_FAIL && historical_control_pending && !acknowledged && posts==0);
    test_old_control_recovery();
    puts("window/control adapter ordering tests passed (stateful mock boundaries)");
}
/* The registration path stays closed without explicit bootstrap evidence; these
 * substitutes ensure this test never reaches a device, network or real budget. */
esp_err_t cp_v3_transport_start(const cp_settings_t *s,const cp_v3_transport_config_t *c) {(void)s;(void)c;return ESP_OK;}
esp_err_t cp_v3_transport_time(cp_v3_time_t *t) {*t=(cp_v3_time_t){.mono_ms=5,.utc_ms=1700000000000ULL,.clock_epoch=unknown_clock?0:1,.uncertainty_ms=1};return ESP_OK;}
esp_err_t cp_v3_transport_request(cp_v3_http_method_t m,const char *p,const void *b,size_t n,char *r,size_t c,cp_v3_transport_response_t *o) {(void)b;(void)n;assert(c);if(m==CP_V3_HTTP_POST)assert(!strcmp(p,"/api/v3/device/capabilities") && !historical_control_pending);r[0]='Y';*o=(cp_v3_transport_response_t){.complete=true,.stage=CP_V3_TRANSPORT_COMPLETE,.tls_connected=1,.tls_verify_flags=simulate_tls_bad?1:0,.http_status=200,.body_bytes=1};if(m==CP_V3_HTTP_POST)posts++;return ESP_OK;}
esp_err_t cp_v3_transport_request_receipt_only(cp_v3_http_method_t m,const char *p,const void *b,size_t n,char *r,size_t c,cp_v3_transport_response_t *o) {
    assert(m==CP_V3_HTTP_POST && historical_control_pending && durable && !a.registered);
    const char *path=!strcmp(frozen_control.stream,"config_ack")?"/api/v3/device/config/ack":"/api/v3/device/lease";
    assert(!strcmp(p,path) && n==sizeof old_body-1 && !memcmp(b,old_body,n));
    assert(charges==receipt_posts+1 && last_charge==n);receipt_posts++;
    mock_receipt_t receipt={.expected=frozen_control,.committed=true};memcpy(receipt.body,old_body,sizeof old_body);
    if(replay_fault==REPLAY_BAD)receipt.committed=false;
    if(replay_fault==REPLAY_BOOT)strcpy(receipt.expected.scope.boot_id,cap.boot_id);
    if(replay_fault==REPLAY_SCOPE)strcpy(receipt.expected.scope.policy_id,"other-user-policy");
    assert(c>=sizeof receipt);memcpy(r,&receipt,sizeof receipt);
    *o=(cp_v3_transport_response_t){.complete=replay_fault!=REPLAY_INCOMPLETE,.stage=CP_V3_TRANSPORT_COMPLETE,
        .tls_connected=1,.tls_verify_flags=replay_fault==REPLAY_TLS,.http_status=replay_fault==REPLAY_409?409:200,.body_bytes=sizeof receipt};
    return replay_fault==REPLAY_ERROR?ESP_FAIL:ESP_OK;
}
bool cp_v3_transport_sha256(void *c,const void *p,size_t n,uint8_t d[32]) {return sha(c,p,n,d);}
cp_v3_budget_result_t cp_v3_budget_charge(cp_v3_budget_t *b,uint64_t n,uint64_t l,uint64_t h) {(void)b;assert(l && h>=l);charges++;last_charge=n;return simulate_budget_bad?CP_V3_BUDGET_LIMIT:CP_V3_BUDGET_OK;}
te_v3_capability_result_t te_v3_capabilities_build(const te_v3_capability_request_t *r,uint64_t l,uint64_t h,char *o,size_t c,size_t *n) {(void)r;(void)l;(void)h;assert(c);*o='x';*n=1;return TE_V3_CAPABILITIES_OK;}
cp_v3_control_result_t cp_v3_control_init(cp_v3_control_t *a,cp_v3_control_workspace_t *w,const char *n,const char *b,const void *j,size_t z,cp_v3_time_t t,cp_v3_sha256_fn f,void *c) {(void)a;(void)w;(void)n;(void)b;(void)j;(void)z;(void)t;(void)f;(void)c;return CP_V3_CONTROL_OK;}
cp_v3_control_result_t cp_v3_control_registration(cp_v3_control_t *a,uint32_t s,uint64_t u,const char **b,size_t *n) {(void)a;(void)s;(void)u;*b="x";*n=1;return CP_V3_CONTROL_OK;}
cp_v3_control_result_t cp_v3_control_registration_receipt(cp_v3_control_t *a,const void *b,size_t n,cp_v3_time_t t) {(void)a;(void)b;(void)n;(void)t;return CP_V3_CONTROL_OK;}
cp_v3_control_result_t cp_v3_control_offer(cp_v3_control_t *a,const void *b,size_t n,cp_v3_time_t t) {(void)a;(void)b;(void)n;(void)t;return CP_V3_CONTROL_INVALID;}
cp_v3_control_result_t cp_v3_control_apply(cp_v3_control_t *a,cp_v3_time_t t,cp_v3_boundary_t b,uint32_t s,cp_v3_actual_apply_fn f,void *c) {(void)a;(void)t;(void)b;(void)s;(void)f;(void)c;return CP_V3_CONTROL_INVALID;}
cp_v3_control_result_t cp_v3_control_match_frozen_receipt(cp_v3_control_workspace_t *w,const cp_v3_scope_t *s,const void *b,size_t n,const void *r,size_t rn,cp_v3_sha256_fn h,void *c) {
    (void)w;(void)h;(void)c;matches++;
    if(rn!=sizeof(mock_receipt_t) || n!=sizeof old_body-1 || memcmp(b,old_body,n) || memcmp(s,&frozen_control.scope,sizeof *s))return CP_V3_CONTROL_INVALID;
    mock_receipt_t receipt;memcpy(&receipt,r,sizeof receipt);
    return receipt.committed && !memcmp(&receipt.expected,&frozen_control,sizeof frozen_control) &&
        !memcmp(receipt.body,old_body,sizeof old_body)?CP_V3_CONTROL_OK:CP_V3_CONTROL_INVALID;
}
const char *cp_v3_control_ack_bytes(const cp_v3_control_t *a,size_t *n) {(void)a;*n=0;return NULL;}
cp_v3_control_result_t cp_v3_control_ack_receipt(cp_v3_control_t *a,const void *r,size_t n,cp_v3_time_t t) {(void)a;(void)r;(void)n;(void)t;return CP_V3_CONTROL_INVALID;}
cp_v3_control_result_t cp_v3_control_lease_request(cp_v3_control_t *a,uint32_t s,uint64_t u,const char **b,size_t *n) {(void)a;(void)s;(void)u;(void)b;(void)n;return CP_V3_CONTROL_INVALID;}
cp_v3_control_result_t cp_v3_control_lease_receipt(cp_v3_control_t *a,const void *r,size_t n,cp_v3_time_t t) {(void)a;(void)r;(void)n;(void)t;return CP_V3_CONTROL_INVALID;}
esp_err_t te_v3_shared_capture_start(te_v3_shared_capture_t *a,cp_v3_control_t *b,cp_v3_time_t t,uint32_t s,bool q) {(void)a;(void)b;(void)t;(void)s;(void)q;return ESP_FAIL;}
te_v3_small_queue_result_t te_v3_small_queue_oldest(te_v3_small_queue_t *q,cp_v3_queue_kind_t k,unsigned *s) {(void)q;if((historical_pending&&k==CP_V3_QUEUE_WINDOW)||(historical_control_pending&&k==CP_V3_QUEUE_CONTROL)){*s=2;return TE_SMALL_QUEUE_OK;}return TE_SMALL_QUEUE_NOT_FOUND;}
te_v3_small_queue_result_t te_v3_small_queue_ack_control(te_v3_small_queue_t *queue,unsigned slot,const void *r,size_t n,cp_v3_queue_control_match_fn match,void *context) {
    (void)queue;assert(slot==2 && historical_control_pending && durable && match);control_acks++;
    if(control_ack_error)return TE_SMALL_QUEUE_IO;
    if(!match(context,&expected,old_body,sizeof old_body-1,r,n))return TE_SMALL_QUEUE_MISMATCH;
    historical_control_pending=false;acknowledged=true;return TE_SMALL_QUEUE_OK;
}
