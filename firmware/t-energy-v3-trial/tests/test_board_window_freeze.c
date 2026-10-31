#include "board_window_freeze.h"
#include "board_stats_window.h"
#include "board_admission.h"
#include <assert.h>
#include <openssl/sha.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Synthetic reports only. The statistics core and serializer are production
 * sources; OpenSSL independently verifies the exact frozen body digest. */
typedef struct { unsigned calls; bool fail; } hash_state_t;
static bool hash(void *context,const void *body,size_t bytes,uint8_t digest[32]) {
    hash_state_t *state=context;
    ++state->calls;
    return !state->fail && SHA256(body,bytes,digest)!=NULL;
}
static te_v3_window_freeze_t freezer(hash_state_t *state) {
    te_v3_window_freeze_t c={.seq=19,.sha256=hash,.sha_context=state};
    strcpy(c.batch_id,"00000000-0000-4000-8000-000000000019");
    return c;
}
static cp_v3_capture_window_t snapshot(unsigned duration,unsigned window,unsigned variant) {
    cp_v3_stats_config_t config={.capacity=512,.window_ms=duration,.bin_ms=5000,
        .rules_version=CP_V3_STATS_RULESET};
    size_t bytes=cp_v3_stats_memory_bytes(config.capacity),align=cp_v3_stats_memory_alignment();
    void *raw=malloc(bytes+align);assert(raw);
    uintptr_t arena=(uintptr_t)raw;arena+=(align-arena%align)%align;
    te_v3_stats_window_t worker={0};
    assert(te_v3_window_init(&worker,(void *)arena,bytes,&config));
    uint64_t start=1000000,end=start+(uint64_t)duration*1000;
    assert(te_v3_window_begin(&worker,start,true));
    assert(te_v3_window_scan_state(&worker,start,true));
    unsigned reports=0;
    for(unsigned bin=0;bin<duration/5000;bin++) {
        for(unsigned key=0;key<2;key++) {
            te_v3_report_t report;
            te_v3_report_init(&report,++reports,start+(uint64_t)bin*5000000+1000+key);
            memset(report.address,variant?0xa7:0xb8,sizeof report.address);
            report.address[0]=(uint8_t)key;report.rssi=-60;report.event_type=key?4:0;
            const char *name=variant?"PRIVATE-NAME-B":"PRIVATE-NAME-A";
            report.payload[0]=(uint8_t)(strlen(name)+1);report.payload[1]=9;
            memcpy(report.payload+2,name,strlen(name));report.length=(uint16_t)(strlen(name)+2);
            assert(te_v3_window_report(&worker,&report));
        }
    }
    assert(te_v3_window_stop(&worker,end,true,true));
    cp_v3_capture_window_t w={.window_seq=window};
    cp_v3_stats_source_t source={.reports_seen_known=true,.queue_drops_known=true,
        .processing_losses_known=true,.reports_seen=reports};
    assert(te_v3_window_finish(&worker,true,source,&w.statistics));
    assert(w.statistics.source_consistent && w.statistics.unique_keys==2);
    w.scope.assignment_generation=1;w.scope.window_seq=window;
    strcpy(w.scope.node_id,"synthetic-te-only");strcpy(w.scope.policy_id,"synthetic-policy");
    strcpy(w.scope.placement_id,"synthetic-placement");strcpy(w.scope.dataset,"controlled_test");
    strcpy(w.scope.boot_id,"00000000-0000-4000-8000-000000000001");
    memset(w.scope.policy_sha256,'0',64);
    w.end_time=(cp_v3_small_time_t){.mono_ms=end/1000,.utc_ms=1898553600000ULL+end/1000,
        .clock_epoch=1,.utc_known=true};
    cp_v3_stats_free(worker.worker.core);free(raw);return w;
}
static bool freeze(te_v3_window_freeze_t *c,const cp_v3_capture_window_t *w,
    char *body,size_t cap,size_t *bytes,cp_v3_expected_t *expected,size_t *identity_bytes) {
    return te_v3_window_freeze(c,w,sizeof *w,body,cap,bytes,expected,sizeof *expected,identity_bytes);
}
static void verify(const cp_v3_capture_window_t *w,const te_v3_window_freeze_t *c,
    const char *body,size_t bytes,const cp_v3_expected_t *expected,size_t identity_bytes) {
    assert(bytes && bytes<=TE_WINDOW_BODY_MAX && bytes==strlen(body));
    assert(identity_bytes==sizeof *expected && expected->body_bytes==bytes && expected->accepted_count==1);
    assert(expected->seq_first==c->seq && expected->seq_last==c->seq);
    assert(!strcmp(expected->batch_id,c->batch_id) && !strcmp(expected->stream,"window_statistics"));
    assert(!memcmp(&expected->scope,&w->scope,sizeof w->scope));
    uint8_t digest[32];char hex[65];assert(SHA256((const unsigned char *)body,bytes,digest));
    for(unsigned i=0;i<32;i++)snprintf(hex+i*2,3,"%02x",digest[i]);
    assert(!strcmp(hex,expected->body_sha256));
    assert(!strstr(body,"address") && !strstr(body,"payload") && !strstr(body,"raw") &&
        !strstr(body,"PRIVATE-NAME") && !strstr(body,"a7a7") && !strstr(body,"b8b8"));
    const unsigned char *scratch=(const unsigned char *)&c->scratch;
    for(size_t i=0;i<sizeof c->scratch;i++)assert(!scratch[i]);
}
static void valid_windows(unsigned duration) {
    hash_state_t state={0};te_v3_window_freeze_t c=freezer(&state);
    cp_v3_capture_window_t w=snapshot(duration,7,0),before=w;
    char body[2048],again[2048];size_t bytes,identity_bytes,more,other_identity_bytes;
    cp_v3_expected_t expected,other;
    assert(freeze(&c,&w,body,sizeof body,&bytes,&expected,&identity_bytes));
    verify(&w,&c,body,bytes,&expected,identity_bytes);
    assert(!memcmp(&w,&before,sizeof w));
    /* Retries retain the caller's allocated UUID/sequence and exact bytes. */
    assert(freeze(&c,&w,again,sizeof again,&more,&other,&other_identity_bytes));
    assert(bytes==more && !memcmp(body,again,bytes) && !memcmp(&expected,&other,sizeof expected));
    assert(!memcmp(&w,&before,sizeof w) && c.seq==19 && !strcmp(c.batch_id,expected.batch_id));
    assert(freeze(&c,&w,again,bytes+1,&more,&other,&other_identity_bytes));
    assert(bytes==more && !memcmp(body,again,bytes));
    assert(!freeze(&c,&w,again,bytes,&more,&other,&other_identity_bytes));
    assert(!more && !other_identity_bytes && !again[0] && !memcmp(&w,&before,sizeof w));
    assert(freeze(&c,&w,again,sizeof again,&more,&other,&other_identity_bytes));
    assert(bytes==more && !memcmp(body,again,bytes) && !memcmp(&expected,&other,sizeof expected));
    /* Different private addresses/names produce the same aggregate wire body. */
    cp_v3_capture_window_t private_variant=snapshot(duration,7,1);
    assert(freeze(&c,&private_variant,again,sizeof again,&more,&other,&other_identity_bytes));
    assert(bytes==more && !memcmp(body,again,bytes));
    /* Window identity is retained even when the aggregate values are equal. */
    private_variant.window_seq=private_variant.scope.window_seq=8;
    assert(freeze(&c,&private_variant,again,sizeof again,&more,&other,&other_identity_bytes));
    assert(strcmp(body,again) && strcmp(expected.body_sha256,other.body_sha256));
    assert(other.scope.window_seq==8);
    printf("board frozen synthetic window %us: %zu bytes\n",duration/1000,bytes);
}
static void rejects(void) {
    hash_state_t state={0};te_v3_window_freeze_t c=freezer(&state),identity_before=c;
    cp_v3_capture_window_t w=snapshot(60000,7,0),before;
    char body[4096];size_t bytes=99,identity_bytes=99;cp_v3_expected_t expected;
    w.scope.window_seq=8;before=w;
    assert(!freeze(&c,&w,body,sizeof body,&bytes,&expected,&identity_bytes));
    assert(!bytes && !identity_bytes && !state.calls && !memcmp(&w,&before,sizeof w));
    w.scope.window_seq=7;w.statistics.source_consistent=false;before=w;
    assert(!freeze(&c,&w,body,sizeof body,&bytes,&expected,&identity_bytes));
    assert(!state.calls && !memcmp(&w,&before,sizeof w));
    w.statistics.source_consistent=true;before=w;state.fail=true;
    assert(!freeze(&c,&w,body,sizeof body,&bytes,&expected,&identity_bytes));
    assert(!bytes && !identity_bytes && !body[0] && !memcmp(&w,&before,sizeof w));
    state.fail=false;
    assert(freeze(&c,&w,body,sizeof body,&bytes,&expected,&identity_bytes));
    c.seq=0;
    assert(!freeze(&c,&w,body,sizeof body,&bytes,&expected,&identity_bytes));
    assert(!bytes && !identity_bytes);c.seq=identity_before.seq;
    memset(c.batch_id,'x',sizeof c.batch_id);
    assert(!freeze(&c,&w,body,sizeof body,&bytes,&expected,&identity_bytes));
    assert(!bytes && !identity_bytes);memcpy(c.batch_id,identity_before.batch_id,sizeof c.batch_id);
    /* Derived synthetic stress vector: valid aggregates exceed the board's
     * body budget, while the shared serializer still fits its larger budget. */
    const uint64_t n=UINT64_C(100000000000);
    cp_v3_stats_snapshot_t *s=&w.statistics;
    s->worker_reports=s->received_reports=s->rssi_samples=n*s->bin_count;
    s->adv_reports=s->worker_reports;s->scan_response_reports=0;
    s->rssi_sum=-(int64_t)s->worker_reports*60;
    for(unsigned i=0;i<s->bin_count;i++) {
        s->bins[i].reports=s->bins[i].rssi_samples=n;s->bins[i].rssi_sum=-(int64_t)n*60;
    }
    before=w;
    assert(cp_v3_small_window_body(&w.scope,s,w.end_time,c.batch_id,c.seq,hash,&state,
        body,sizeof body,&bytes,&expected)==CP_V3_OK && bytes>TE_WINDOW_BODY_MAX);
    unsigned calls=state.calls;
    assert(!freeze(&c,&w,body,sizeof body,&bytes,&expected,&identity_bytes));
    assert(!bytes && !identity_bytes && !body[0] && state.calls==calls);
    assert(!memcmp(&w,&before,sizeof w) && c.seq==identity_before.seq &&
        !memcmp(c.batch_id,identity_before.batch_id,sizeof c.batch_id));
    puts("board frozen oversized synthetic window rejected without truncation");
}
int main(void) {
    assert(!te_v3_runtime_ready());
    valid_windows(30000);valid_windows(60000);rejects();
    puts("board window freeze tests passed (runtime gate closed)");
}
