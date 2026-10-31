/* Reuse only the host NVS implementation; keep its standalone main distinct. */
#define main nvs_storage_fixture_main
#define nvs_set_blob nvs_fixture_set_blob
#include "test.c"
#undef nvs_set_blob
#undef main
#include "board_window_freeze.h"
#include "board_stats_window.h"
#include "board_handoff.h"
#include <openssl/sha.h>
#include <stdlib.h>

static bool fail_blob_write;
static unsigned failed_blob_writes;
esp_err_t nvs_set_blob(nvs_handle_t h,const char *key,const void *value,size_t bytes) {
    if(fail_blob_write) { ++failed_blob_writes; return -1; }
    return nvs_fixture_set_blob(h,key,value,bytes);
}
static bool real_hash(void *context,const void *p,size_t n,uint8_t digest[32]) {
    (void)context; return SHA256(p,n,digest)!=NULL;
}
static void real_hex(const void *p,size_t n,char hex[65]) {
    uint8_t digest[32]; assert(real_hash(NULL,p,n,digest));
    for(unsigned i=0;i<32;i++)snprintf(hex+i*2,3,"%02x",digest[i]);
}
/* A real statistics core consumes only deterministic synthetic reports. */
static cp_v3_capture_window_t make_snapshot(void) {
    cp_v3_stats_config_t config={.capacity=512,.window_ms=60000,.bin_ms=5000,
        .rules_version=CP_V3_STATS_RULESET};
    size_t n=cp_v3_stats_memory_bytes(config.capacity),alignment=cp_v3_stats_memory_alignment();
    void *raw=malloc(n+alignment); assert(raw);
    uintptr_t address=(uintptr_t)raw; address+=(alignment-address%alignment)%alignment;
    te_v3_stats_window_t worker={0};
    assert(te_v3_window_init(&worker,(void *)address,n,&config));
    const uint64_t start=1000000,end=61000000;
    assert(te_v3_window_begin(&worker,start,true));
    assert(te_v3_window_scan_state(&worker,start,true));
    for(unsigned i=0;i<12;i++) {
        te_v3_report_t report; te_v3_report_init(&report,i+1,start+(uint64_t)i*5000000+1000);
        memset(report.address,0xb8,sizeof report.address); report.rssi=-60;
        report.event_type=0; report.length=0;
        assert(te_v3_window_report(&worker,&report));
    }
    assert(te_v3_window_stop(&worker,end,true,true));
    cp_v3_capture_window_t w={.window_seq=7};
    cp_v3_stats_source_t source={.reports_seen_known=true,.queue_drops_known=true,
        .processing_losses_known=true,.reports_seen=12};
    assert(te_v3_window_finish(&worker,true,source,&w.statistics));
    assert(w.statistics.source_consistent && w.statistics.unique_keys==1);
    w.scope.assignment_generation=1; w.scope.window_seq=w.window_seq;
    strcpy(w.scope.node_id,"synthetic-te-handoff"); strcpy(w.scope.policy_id,"synthetic-policy");
    strcpy(w.scope.placement_id,"synthetic-placement"); strcpy(w.scope.dataset,"controlled_test");
    strcpy(w.scope.boot_id,"00000000-0000-4000-8000-000000000001");
    memset(w.scope.policy_sha256,'a',64);
    w.end_time=(cp_v3_small_time_t){.mono_ms=end/1000,.utc_ms=1898553661000ULL,
        .clock_epoch=1,.utc_known=true};
    cp_v3_stats_free(worker.worker.core); free(raw); return w;
}
typedef struct {
    cp_v3_capture_window_t snapshot;
    te_v3_window_freeze_t freezer;
    unsigned peeks,stores,readbacks,releases,slot;
    bool pending,bad_identity_hash;
} binding_t;
static binding_t binding;
static te_handoff_t handoff;
static cp_v3_queue_profile_config_t config;
static bool admit(void *context) { (void)context; return true; }
static te_handoff_peek_result_t peek(void *context,void *dst,size_t cap,size_t *n) {
    binding_t *b=context; ++b->peeks; *n=0;
    if(!b->pending)return TE_PEEK_EMPTY;
    assert(cap>=sizeof b->snapshot); memcpy(dst,&b->snapshot,sizeof b->snapshot);
    *n=sizeof b->snapshot; return TE_PEEK_ITEM;
}
static bool freeze_window(void *context,const void *snapshot,size_t n,void *body,size_t cap,
    size_t *body_n,void *identity,size_t identity_cap,size_t *identity_n) {
    binding_t *b=context;
    bool ok=te_v3_window_freeze(&b->freezer,snapshot,n,body,cap,body_n,identity,identity_cap,identity_n);
    if(ok && b->bad_identity_hash) {
        cp_v3_expected_t e; memcpy(&e,identity,sizeof e);
        e.body_sha256[0]=e.body_sha256[0]=='0'?'1':'0'; memcpy(identity,&e,sizeof e);
    }
    return ok;
}
static void reopen_queue(void) {
    prepare(); assert(te_nvs_store_set_hash(&state,real_hash,NULL));
    assert(cp_v3_queue_open_profile(&actual_queue,q,binding.snapshot.scope.node_id,
        binding.snapshot.scope.boot_id,real_hash,NULL,&config)==CP_V3_QUEUE_OK);
}
/* Test-only binding: reconcile uncertain RAM state before each exact retry.
 * The collector and its runtime store binding are still unwired on the board. */
static te_handoff_store_result_t store_window(void *context,const void *body,size_t n,
    const void *identity,size_t identity_n,const uint8_t hash[32]) {
    binding_t *b=context; ++b->stores;
    assert(b->pending && !b->releases && identity_n==sizeof(cp_v3_expected_t));
    cp_v3_expected_t e; memcpy(&e,identity,sizeof e);
    uint8_t digest[32]; assert(real_hash(NULL,body,n,digest) && !memcmp(digest,hash,sizeof digest));
    assert(n<=1024 && e.body_bytes==n && !strcmp(e.stream,"window_statistics"));
    assert(e.seq_first==19 && e.seq_last==19 && e.accepted_count==1);
    assert(!strcmp(e.batch_id,b->freezer.batch_id));
    assert(!memcmp(&e.scope,&b->snapshot.scope,sizeof e.scope));
    reopen_queue();
    assert(cp_v3_queue_encoded_size(&actual_queue,n)==n+518 && n+518<=TE_NVS_RECORD_MAX);
    cp_v3_queue_result_t r=cp_v3_queue_push_expiring(&actual_queue,CP_V3_QUEUE_WINDOW,&e,body,n,1000,&b->slot);
    if(r==CP_V3_QUEUE_FULL)return TE_STORE_FULL;
    if(r!=CP_V3_QUEUE_OK)return TE_STORE_ERROR;
    char restored[1024]; size_t restored_n=0; cp_v3_expected_t saved;
    assert(cp_v3_queue_read(&actual_queue,b->slot,restored,sizeof restored,&restored_n,&saved)==CP_V3_QUEUE_OK);
    assert(restored_n==n && !memcmp(restored,body,n) && !memcmp(&saved,&e,sizeof e));
    assert(lengths[b->slot]==n+518 && lengths[b->slot]<=TE_NVS_RECORD_MAX);
    assert(!lengths[2]); /* Dedicated control slot has no fabricated record/ACK. */
    ++b->readbacks; return TE_STORE_DURABLE;
}
static bool release_window(void *context,const void *snapshot,size_t n) {
    binding_t *b=context;
    assert(b->pending && b->readbacks && handoff.state==TE_HANDOFF_DURABLE);
    assert(n==sizeof b->snapshot && !memcmp(snapshot,&b->snapshot,n));
    assert(lengths[b->slot] && !lengths[2]);
    b->pending=false; ++b->releases; return true;
}
static te_handoff_ops_t ops(void) {
    return (te_handoff_ops_t){.admit=admit,.peek=peek,.freeze=freeze_window,.hash=real_hash,
        .store=store_window,.release=release_window,.context=&binding};
}
static void setup(void) {
    fail_blob_write=false; failed_blob_writes=0; reset();
    memset(&binding,0,sizeof binding); memset(&handoff,0,sizeof handoff);
    clock_now=100; clock_upper_delta=1; clock_known=true;
    config=(cp_v3_queue_profile_config_t){.profile=CP_V3_QUEUE_SMALL_RESULTS,.clock=clock_mock,
        .expire=expire_mock,.limits={1,0,1,1,1024}};
    binding.snapshot=make_snapshot(); binding.pending=true;
    binding.freezer=(te_v3_window_freeze_t){.seq=19,.sha256=real_hash};
    strcpy(binding.freezer.batch_id,"00000000-0000-4000-8000-000000000019");
    reopen_queue();
}
static void stage(void) {
    te_handoff_ops_t o=ops();
    assert(te_handoff_step(&handoff,&o)==TE_STEP_PROGRESS && handoff.state==TE_HANDOFF_STAGED);
    assert(te_handoff_step(&handoff,&o)==TE_STEP_PROGRESS && handoff.state==TE_HANDOFF_FROZEN);
    assert(binding.peeks==1 && !binding.stores && !binding.releases);
    assert(handoff.snapshot_len==sizeof binding.snapshot && !memcmp(handoff.snapshot,&binding.snapshot,handoff.snapshot_len));
    cp_v3_expected_t e; memcpy(&e,handoff.identity,sizeof e);
    char digest[65]; real_hex(handoff.body,handoff.body_len,digest);
    if(!binding.bad_identity_hash) {
        assert(!strcmp(digest,e.body_sha256));
        char reference[1025]; size_t reference_n=0; cp_v3_expected_t reference_identity;
        assert(cp_v3_small_window_body(&binding.snapshot.scope,&binding.snapshot.statistics,
            binding.snapshot.end_time,binding.freezer.batch_id,binding.freezer.seq,real_hash,NULL,
            reference,sizeof reference,&reference_n,&reference_identity)==CP_V3_OK);
        assert(reference_n==handoff.body_len && !memcmp(reference,handoff.body,reference_n));
        assert(!memcmp(&reference_identity,&e,sizeof e));
    }
}
static void persist_and_ack(void) {
    te_handoff_ops_t o=ops();
    char frozen[1024]; size_t n=handoff.body_len; memcpy(frozen,handoff.body,n);
    cp_v3_expected_t expected; memcpy(&expected,handoff.identity,sizeof expected);
    assert(te_handoff_step(&handoff,&o)==TE_STEP_PROGRESS && handoff.state==TE_HANDOFF_DURABLE);
    assert(binding.pending && !binding.releases && handoff.committed==1 && binding.readbacks);
    assert(te_handoff_step(&handoff,&o)==TE_STEP_PROGRESS && handoff.state==TE_HANDOFF_EMPTY);
    assert(!binding.pending && binding.releases==1 && handoff.released==1);
    /* Simulated restart uses only the persisted NVS bytes, not the RAM handoff. */
    reopen_queue(); char restored[1024]; size_t restored_n=0; cp_v3_expected_t saved;
    assert(cp_v3_queue_read(&actual_queue,binding.slot,restored,sizeof restored,&restored_n,&saved)==CP_V3_QUEUE_OK);
    assert(restored_n==n && !memcmp(restored,frozen,n) && !memcmp(&saved,&expected,sizeof saved));
    char ack[2048]; size_t ack_n=receipt(&expected,ack);
    assert(cp_v3_statistics_receipt_matches(ack,ack_n,&expected));
    char *hash=strstr(ack,expected.body_sha256); assert(hash); hash[0]=hash[0]=='0'?'1':'0';
    assert(cp_v3_queue_ack(&actual_queue,binding.slot,ack,ack_n)==CP_V3_QUEUE_MISMATCH && lengths[binding.slot]);
    ack_n=receipt(&expected,ack);
    assert(cp_v3_queue_ack(&actual_queue,binding.slot,ack,ack_n)==CP_V3_QUEUE_OK && !lengths[binding.slot]);
    assert(!lengths[2]);
    printf("synthetic snapshot handoff: body=%zu encoded=%zu bytes, exact NVS readback and strict receipt passed\n",n,n+518);
}
static void backpressure(bool write_failure,bool physical_full) {
    setup(); stage(); te_handoff_ops_t o=ops();
    te_handoff_t original=handoff;
    if(write_failure)fail_blob_write=true;
    else if(physical_full)available=128;
    else { exists=1; for(unsigned i=3;i<6;i++){lengths[i]=1;values[i][0]=0xaa;} }
    for(unsigned i=0;i<2;i++) {
        assert(te_handoff_step(&handoff,&o)==TE_STEP_BACKPRESSURE && handoff.state==TE_HANDOFF_FROZEN);
        assert(binding.pending && !binding.releases && binding.peeks==1 && !binding.readbacks);
        assert(handoff.body_len==original.body_len && !memcmp(handoff.body,original.body,handoff.body_len));
        assert(handoff.identity_len==original.identity_len && !memcmp(handoff.identity,original.identity,handoff.identity_len));
        assert(!memcmp(handoff.snapshot,original.snapshot,handoff.snapshot_len) && !lengths[0] && !lengths[2]);
    }
    if(write_failure)assert(failed_blob_writes==2);
    fail_blob_write=false; available=500;
    /* Test fixture clears only its synthetic occupied slots; no ACK is forged. */
    for(unsigned i=3;i<6;i++)lengths[i]=0;
    persist_and_ack();
}
int main(void) {
    setup(); stage(); persist_and_ack();
    backpressure(false,false); backpressure(false,true); backpressure(true,false);
    setup(); binding.bad_identity_hash=true; stage(); te_handoff_ops_t o=ops();
    assert(te_handoff_step(&handoff,&o)==TE_STEP_BACKPRESSURE);
    assert(handoff.state==TE_HANDOFF_FROZEN && binding.pending && !binding.releases && !lengths[0]);
    setup(); stage(); o=ops(); handoff.body_hash[0]^=1;
    assert(te_handoff_step(&handoff,&o)==TE_STEP_FAULT && !binding.stores && !binding.releases && binding.pending);
    assert(!lengths[0] && !lengths[2]);
    puts("window/freezer/handoff/small-profile/mock-NVS integration passed (host only; collector remains unwired)");
    return 0;
}
