/* Real board adapter + shared queue + NVS adapter. Only NVS and arbitration /
 * applied-policy boundaries are host substitutes. All hashes are OpenSSL
 * SHA-256; control receipts use the production stateless strict matcher.
 * Run from the repository root (or pass request/receipt fixture paths).
 */
#define main inherited_nvs_test_main
#include "../flash_queue/nvs_store/tests/test.c"
#undef main
#include "board_small_queue.h"
#include "cp_v3_control.h"
#include "internal.h"
#include <openssl/sha.h>
#include <time.h>

static te_v3_small_queue_t board, restarted;
static cp_v3_control_workspace_t control_workspace;
static bool held;
static cp_v3_budget_t budget;
static uint8_t budget_record[CP_V3_BUDGET_RECORD_BYTES];
static bool budget_present, budget_store_fails;
static cp_v3_budget_load_t budget_load(void *ctx,void *out,size_t cap,size_t *len) {
    (void)ctx; assert(held || !board.opened); *len=0;
    if(!budget_present) return CP_V3_BUDGET_LOAD_ABSENT;
    assert(cap>=sizeof budget_record); memcpy(out,budget_record,sizeof budget_record);
    *len=sizeof budget_record; return CP_V3_BUDGET_LOAD_PRESENT;
}
static bool budget_save(void *ctx,const void *record,size_t n) {
    (void)ctx; assert(held && n==sizeof budget_record);
    if(budget_store_fails) return false;
    memcpy(budget_record,record,n); budget_present=true; return true;
}
static const char *node_id="synthetic-node";
static const char *boot_id="00000000-0000-4000-8000-000000000001";
static const char *other_boot="00000000-0000-4000-8000-000000000099";
static uint64_t utc_lower,utc_upper,deadline;
static bool utc_known,deny_policy;
static unsigned lock_attempts,unlocks,policy_calls,control_calls;
static cp_v3_scope_t applied_scope;

static bool sha_real(void *ctx,const void *p,size_t n,uint8_t h[32]) {
    (void)ctx; return SHA256(p,n,h)!=NULL;
}
static void digest_real(const void *p,size_t n,char hex[65]) {
    uint8_t h[32]; const char *digits="0123456789abcdef";
    assert(sha_real(NULL,p,n,h));
    for(unsigned i=0;i<32;i++) { hex[i*2]=digits[h[i]>>4]; hex[i*2+1]=digits[h[i]&15]; } hex[64]=0;
}
static bool trusted_time(void *ctx,uint64_t *lower,uint64_t *upper) {
    (void)ctx; assert(held); *lower=utc_lower; *upper=utc_upper; return utc_known;
}
static bool lock_try(void *ctx) {
    (void)ctx; lock_attempts++; if(held) return false; held=true; return true;
}
static void lock_release(void *ctx) { (void)ctx; assert(held); held=false; unlocks++; }
static bool policy_admits(void *ctx,cp_v3_queue_kind_t kind,const cp_v3_expected_t *e,size_t n,uint64_t expires) {
    (void)ctx; assert(held); policy_calls++;
    /* A bounded representation check makes even a buggy caller safe in this
     * test, while malformed-input tests separately assert it is never called. */
    if(!memchr(e->scope.placement_id,0,sizeof e->scope.placement_id)||
       !memchr(e->scope.policy_id,0,sizeof e->scope.policy_id)||
       !memchr(e->scope.policy_sha256,0,sizeof e->scope.policy_sha256)||
       !memchr(e->scope.dataset,0,sizeof e->scope.dataset)||
       !memchr(e->body_sha256,0,sizeof e->body_sha256)||!memchr(e->stream,0,sizeof e->stream)) return false;
    cp_v3_scope_t actual=e->scope,wanted=applied_scope; actual.window_seq=wanted.window_seq=0;
    return !deny_policy&&!memcmp(&actual,&wanted,sizeof wanted)&&n<=1024&&expires<=deadline+20000&&
        ((kind==CP_V3_QUEUE_WINDOW&&!strcmp(e->stream,"window_statistics"))||
         (kind==CP_V3_QUEUE_STATUS&&!strcmp(e->stream,"node_status"))||
         (kind==CP_V3_QUEUE_CONTROL&&(!strcmp(e->stream,"config_ack")||!strcmp(e->stream,"lease"))));
}
static te_v3_small_queue_config_t config(void) {
    return (te_v3_small_queue_config_t){.sha256=sha_real,.clock=trusted_time,.try_lock=lock_try,
        .unlock=lock_release,.admit_new=policy_admits,.write_budget=&budget};
}
static cp_v3_expected_t expected(cp_v3_queue_kind_t kind,unsigned batch,const void *body,size_t n) {
    cp_v3_expected_t e={0}; strcpy(e.scope.node_id,node_id); strcpy(e.scope.boot_id,boot_id);
    strcpy(e.scope.placement_id,"place"); strcpy(e.scope.policy_id,"policy");
    memset(e.scope.policy_sha256,'a',64); strcpy(e.scope.dataset,"controlled_test");
    e.scope.assignment_generation=1; e.scope.window_seq=1;
    snprintf(e.batch_id,sizeof e.batch_id,"00000000-0000-4000-8000-%012u",batch);
    strcpy(e.stream,kind==CP_V3_QUEUE_WINDOW?"window_statistics":kind==CP_V3_QUEUE_STATUS?"node_status":"config_ack");
    e.seq_first=e.seq_last=batch; e.accepted_count=1; e.body_bytes=n; digest_real(body,n,e.body_sha256); return e;
}
static void fresh(void) {
    reset(); memset(&board,0,sizeof board); memset(&restarted,0,sizeof restarted);
    held=deny_policy=false; lock_attempts=unlocks=policy_calls=control_calls=0;
    budget_present=budget_store_fails=false; memset(budget_record,0,sizeof budget_record);
    uint8_t budget_owner[CP_V3_BUDGET_OWNER_BYTES]={1};
    cp_v3_budget_store_t budget_store={.load=budget_load,.store=budget_save,.logical_write_bytes=4096};
    assert(cp_v3_budget_open(&budget,budget_store,budget_owner)==CP_V3_BUDGET_OK);
    assert(cp_v3_budget_configure(&budget,UINT64_C(1)<<30,CP_V3_BUDGET_DEFAULT_QUANTUM)==CP_V3_BUDGET_OK);
    utc_known=true;
    /* A real host UTC sample anchors normal operations; only boundary/failure
     * cases deliberately change its conservative bounds. This does not claim
     * that a device clock provider has been installed or validated. */
    struct timespec ts; assert(timespec_get(&ts,TIME_UTC)==TIME_UTC);
    utc_lower=(uint64_t)ts.tv_sec*1000+(uint64_t)ts.tv_nsec/1000000; utc_upper=utc_lower+1; deadline=utc_lower+10000;
    for(unsigned i=0;i<sizeof data;i++) data[i]=(unsigned char)(i*17u+3u);
    cp_v3_expected_t e=expected(CP_V3_QUEUE_WINDOW,2,data,1024); applied_scope=e.scope;
    te_v3_small_queue_config_t cfg=config();
    assert(te_v3_small_queue_open(&board,node_id,boot_id,&cfg)==TE_SMALL_QUEUE_OK);
    assert(!exists&&!held&&lock_attempts==unlocks);
}
static void preserved_record(unsigned slot,const void *record,size_t n) {
    assert(lengths[slot]==n&&!memcmp(values[slot],record,n)); assert(!lengths[slot+12]);
}
static void reopen(const char *node,const char *boot) {
    te_v3_small_queue_config_t cfg=config();
    assert(te_v3_small_queue_open(&restarted,node,boot,&cfg)==TE_SMALL_QUEUE_OK); assert(!held);
}
static void basic_profile_and_capacity(void) {
    fresh(); te_v3_small_queue_capacity_t cap; unsigned slot=99;
    cp_v3_expected_t e=expected(CP_V3_QUEUE_WINDOW,2,data,1024);
    assert(board.queue.config.profile==CP_V3_QUEUE_SMALL_RESULTS);
    assert(cp_v3_queue_capacity(&board.queue,CP_V3_QUEUE_WINDOW)==1);
    assert(cp_v3_queue_capacity(&board.queue,CP_V3_QUEUE_EVENT)==0);
    assert(cp_v3_queue_capacity(&board.queue,CP_V3_QUEUE_STATUS)==1);
    assert(cp_v3_queue_capacity(&board.queue,CP_V3_QUEUE_CONTROL)==1);
    assert(board.queue.config.limits.max_body_bytes==1024);
    assert(te_v3_small_queue_preflight(&board,CP_V3_QUEUE_WINDOW,&e,1024,deadline,&cap)==TE_SMALL_QUEUE_OK);
    assert(cap.encoded_bytes==1542&&cap.required_entries==181&&cap.available_entries==500&&!cap.occupied_keys);
    available=cap.required_entries-1;
    assert(te_v3_small_queue_push(&board,CP_V3_QUEUE_WINDOW,&e,data,1024,deadline,&slot)==TE_SMALL_QUEUE_FULL);
    assert(!exists&&slot==99&&!board.storage.uncertain&&board.queue.next_ordinal==1);
    available=cap.required_entries;
    assert(te_v3_small_queue_push(&board,CP_V3_QUEUE_WINDOW,&e,data,1024,deadline,&slot)==TE_SMALL_QUEUE_OK&&slot==0);
    assert(lengths[0]==1542);
    assert(budget.authorized_io_bytes==16384);
    unsigned char frozen[TE_NVS_RECORD_MAX]; size_t frozen_n=lengths[0]; memcpy(frozen,values[0],frozen_n);
    /* Exact durable retry succeeds with zero currently available entries. */
    available=0; slot=99;
    assert(te_v3_small_queue_push(&board,CP_V3_QUEUE_WINDOW,&e,data,1024,deadline,&slot)==TE_SMALL_QUEUE_OK&&slot==0);
    assert(board.queue.next_ordinal==2 && budget.authorized_io_bytes==16384); preserved_record(0,frozen,frozen_n);
    cp_v3_expected_t changed=e; changed.scope.window_seq++;
    assert(te_v3_small_queue_push(&board,CP_V3_QUEUE_WINDOW,&changed,data,1024,deadline,&slot)==TE_SMALL_QUEUE_MISMATCH);
    assert(te_v3_small_queue_push(&board,CP_V3_QUEUE_WINDOW,&e,data,1024,deadline+1,&slot)==TE_SMALL_QUEUE_MISMATCH);
    preserved_record(0,frozen,frozen_n); available=500;
    changed=expected(CP_V3_QUEUE_WINDOW,3,data,1024);
    assert(te_v3_small_queue_push(&board,CP_V3_QUEUE_WINDOW,&changed,data,1024,deadline,&slot)==TE_SMALL_QUEUE_FULL);
    const cp_v3_queue_kind_t kinds[]={CP_V3_QUEUE_STATUS,CP_V3_QUEUE_CONTROL};
    for(unsigned i=0;i<2;i++) {
        changed=expected(kinds[i],i+4,data,1024);
        assert(te_v3_small_queue_push(&board,kinds[i],&changed,data,1024,deadline+10000,&slot)==TE_SMALL_QUEUE_OK&&slot==i+1);
    }
    assert(te_v3_small_queue_preflight(&board,CP_V3_QUEUE_STATUS,&changed,1024,deadline,&cap)!=TE_SMALL_QUEUE_OK);
    changed=e; strcpy(changed.stream,"candidate_events");
    assert(te_v3_small_queue_push(&board,CP_V3_QUEUE_EVENT,&changed,data,1024,deadline,&slot)==TE_SMALL_QUEUE_INVALID);
    changed=expected(CP_V3_QUEUE_WINDOW,20,data,1025);
    assert(te_v3_small_queue_push(&board,CP_V3_QUEUE_WINDOW,&changed,data,1025,deadline,&slot)==TE_SMALL_QUEUE_INVALID);
    assert(lengths[0]&&lengths[1]&&lengths[2]); for(unsigned i=3;i<12;i++) assert(!lengths[i]);
    /* Preflight never implicitly expires even an elapsed source. After an
     * explicit sweep its target tombstone can be reused at the three-key cap. */
    utc_lower=deadline; utc_upper=deadline+1; data[0]^=1;
    changed=expected(CP_V3_QUEUE_WINDOW,21,data,1024);
    assert(te_v3_small_queue_preflight(&board,CP_V3_QUEUE_WINDOW,&changed,1024,deadline+10000,&cap)==TE_SMALL_QUEUE_FULL);
    preserved_record(0,frozen,frozen_n);
    uint64_t authorized_before_expiry=budget.authorized_io_bytes;
    assert(te_v3_small_queue_expire(&board)==TE_SMALL_QUEUE_OK&&!lengths[0]&&lengths[12]);
    assert(budget.authorized_io_bytes==authorized_before_expiry+16384);
    assert(te_v3_small_queue_preflight(&board,CP_V3_QUEUE_WINDOW,&changed,1024,deadline+10000,&cap)==TE_SMALL_QUEUE_OK);
    assert(cap.occupied_keys==3&&cap.target_reuses_tombstone&&!cap.quarantined_slots);
    assert(te_v3_small_queue_push(&board,CP_V3_QUEUE_WINDOW,&changed,data,1024,deadline+10000,&slot)==TE_SMALL_QUEUE_OK&&slot==0);
    assert(lengths[0]&&lengths[1]&&lengths[2]&&!lengths[12]);
    assert(!held&&lock_attempts==unlocks);
}
static void boundaries_and_policy(void) {
    fresh(); unsigned slot=99; te_v3_small_queue_capacity_t cap;
    cp_v3_expected_t e=expected(CP_V3_QUEUE_WINDOW,2,data,1024);
    unsigned policy_before=policy_calls; held=true; unsigned releases=unlocks;
    assert(te_v3_small_queue_preflight(&board,CP_V3_QUEUE_WINDOW,&e,1024,deadline,&cap)==TE_SMALL_QUEUE_BUSY);
    assert(te_v3_small_queue_push(&board,CP_V3_QUEUE_WINDOW,&e,data,1024,deadline,&slot)==TE_SMALL_QUEUE_BUSY);
    assert(te_v3_small_queue_expire(&board)==TE_SMALL_QUEUE_BUSY&&unlocks==releases&&policy_calls==policy_before);
    held=false; deny_policy=true;
    assert(te_v3_small_queue_push(&board,CP_V3_QUEUE_WINDOW,&e,data,1024,deadline,&slot)==TE_SMALL_QUEUE_POLICY);
    assert(!exists&&board.queue.next_ordinal==1); deny_policy=false;
    cp_v3_expected_t wrong=e; wrong.scope.assignment_generation++;
    assert(te_v3_small_queue_preflight(&board,CP_V3_QUEUE_WINDOW,&wrong,1024,deadline,&cap)==TE_SMALL_QUEUE_POLICY);
    wrong=e; strcpy(wrong.scope.boot_id,other_boot);
    assert(te_v3_small_queue_push(&board,CP_V3_QUEUE_WINDOW,&wrong,data,1024,deadline,&slot)==TE_SMALL_QUEUE_RETIRED);
    utc_known=false; policy_before=policy_calls;
    assert(te_v3_small_queue_push(&board,CP_V3_QUEUE_WINDOW,&e,data,1024,deadline,&slot)==TE_SMALL_QUEUE_CLOCK_UNKNOWN);
    utc_known=true; utc_upper=deadline;
    assert(te_v3_small_queue_push(&board,CP_V3_QUEUE_WINDOW,&e,data,1024,deadline,&slot)==TE_SMALL_QUEUE_CLOCK_UNKNOWN);
    utc_lower=deadline;
    assert(te_v3_small_queue_push(&board,CP_V3_QUEUE_WINDOW,&e,data,1024,deadline,&slot)==TE_SMALL_QUEUE_EXPIRED);
    utc_lower=deadline+1; utc_upper=deadline;
    assert(te_v3_small_queue_push(&board,CP_V3_QUEUE_WINDOW,&e,data,1024,deadline,&slot)==TE_SMALL_QUEUE_CLOCK_UNKNOWN);
    assert(policy_calls==policy_before&&!exists);
}
static void malformed_never_reaches_policy(void) {
    fresh(); cp_v3_expected_t good=expected(CP_V3_QUEUE_WINDOW,2,data,1024); unsigned slot=99;
    /* The callback contract must not require unbounded reads to reject malformed
     * envelopes: every fixed-width string is validated before policy admission. */
    const size_t offsets[]={offsetof(cp_v3_expected_t,scope.node_id),offsetof(cp_v3_expected_t,scope.boot_id),
        offsetof(cp_v3_expected_t,scope.placement_id),offsetof(cp_v3_expected_t,scope.policy_id),
        offsetof(cp_v3_expected_t,scope.policy_sha256),offsetof(cp_v3_expected_t,scope.dataset),
        offsetof(cp_v3_expected_t,batch_id),offsetof(cp_v3_expected_t,body_sha256),offsetof(cp_v3_expected_t,stream)};
    const size_t widths[]={65,37,65,65,65,17,37,65,24};
    for(unsigned i=0;i<sizeof widths/sizeof widths[0];i++) {
        cp_v3_expected_t malformed=good; memset((uint8_t *)&malformed+offsets[i],'x',widths[i]);
        unsigned before=policy_calls;
        assert(te_v3_small_queue_preflight(&board,CP_V3_QUEUE_WINDOW,&malformed,1024,deadline,NULL)==TE_SMALL_QUEUE_INVALID);
        assert(te_v3_small_queue_push(&board,CP_V3_QUEUE_WINDOW,&malformed,data,1024,deadline,&slot)==TE_SMALL_QUEUE_INVALID);
        assert(policy_calls==before&&!exists&&slot==99);
    }
    for(unsigned i=0;i<8;i++) {
        cp_v3_expected_t malformed=good;
        switch(i) {
        case 0: malformed.accepted_count=2; break;
        case 1: malformed.seq_last++; break;
        case 2: malformed.scope.assignment_generation=0; break;
        case 3: malformed.body_bytes--; break;
        case 4: malformed.batch_id[14]='1'; break;
        case 5: malformed.body_sha256[0]='A'; break;
        case 6: malformed.scope.window_seq=0; break;
        default: strcpy(malformed.stream,"candidate_events"); break;
        }
        unsigned before=policy_calls;
        assert(te_v3_small_queue_preflight(&board,CP_V3_QUEUE_WINDOW,&malformed,1024,deadline,NULL)==TE_SMALL_QUEUE_INVALID);
        assert(policy_calls==before&&!exists);
    }
}
static void restart_receipts_and_expiry(void) {
    fresh(); cp_v3_expected_t e=expected(CP_V3_QUEUE_WINDOW,2,data,1024); unsigned slot=99;
    assert(te_v3_small_queue_push(&board,CP_V3_QUEUE_WINDOW,&e,data,1024,deadline,&slot)==TE_SMALL_QUEUE_OK);
    uint8_t frozen[TE_NVS_RECORD_MAX]; size_t frozen_n=lengths[0]; memcpy(frozen,values[0],frozen_n);
    reopen(node_id,other_boot); cp_v3_expected_t saved; size_t n=0; uint8_t restored[1024];
    assert(restarted.queue.historical_slots==1);
    assert(te_v3_small_queue_read(&restarted,0,restored,sizeof restored,&n,&saved)==TE_SMALL_QUEUE_OK);
    assert(n==1024&&!memcmp(restored,data,n)&&!memcmp(&e,&saved,sizeof e));
    assert(te_v3_small_queue_push(&restarted,CP_V3_QUEUE_WINDOW,&e,data,1024,deadline,&slot)==TE_SMALL_QUEUE_RETIRED);
    char ack[2048]; size_t ack_n=receipt(&e,ack);
    assert(cp_v3_statistics_receipt_matches(ack,ack_n,&e));
    utc_known=false;
    assert(te_v3_small_queue_oldest(&restarted,CP_V3_QUEUE_WINDOW,&slot)==TE_SMALL_QUEUE_CLOCK_UNKNOWN);
    assert(te_v3_small_queue_read(&restarted,0,restored,sizeof restored,&n,&saved)==TE_SMALL_QUEUE_CLOCK_UNKNOWN&&n==0);
    assert(te_v3_small_queue_ack(&restarted,0,ack,ack_n)==TE_SMALL_QUEUE_CLOCK_UNKNOWN);
    assert(te_v3_small_queue_expire(&restarted)==TE_SMALL_QUEUE_CLOCK_UNKNOWN); preserved_record(0,frozen,frozen_n);
    utc_known=true; utc_upper=deadline;
    assert(te_v3_small_queue_ack(&restarted,0,ack,ack_n)==TE_SMALL_QUEUE_CLOCK_UNKNOWN); preserved_record(0,frozen,frozen_n);
    utc_upper=utc_lower+1;
    char *p=strstr(ack,"\"body_sha256\":\""); assert(p); p+=strlen("\"body_sha256\":\""); *p=*p=='0'?'1':'0';
    assert(te_v3_small_queue_ack(&restarted,0,ack,ack_n)==TE_SMALL_QUEUE_MISMATCH); preserved_record(0,frozen,frozen_n);
    ack_n=receipt(&e,ack);
    ack[ack_n++]='x'; assert(te_v3_small_queue_ack(&restarted,0,ack,ack_n)==TE_SMALL_QUEUE_MISMATCH); preserved_record(0,frozen,frozen_n);
    ack_n=receipt(&e,ack);
    ack[ack_n-1]=',';
    const char *duplicate="\"durability\":\"committed\"}";
    memcpy(ack+ack_n,duplicate,strlen(duplicate)); ack_n+=strlen(duplicate);
    assert(te_v3_small_queue_ack(&restarted,0,ack,ack_n)==TE_SMALL_QUEUE_MISMATCH); preserved_record(0,frozen,frozen_n);
    ack_n=receipt(&e,ack); p=strstr(ack,"small_statistics"); assert(p); *p='x';
    assert(te_v3_small_queue_ack(&restarted,0,ack,ack_n)==TE_SMALL_QUEUE_MISMATCH); preserved_record(0,frozen,frozen_n);
    ack_n=receipt(&e,ack);
    uint64_t authorized_before_ack=budget.authorized_io_bytes;
    assert(te_v3_small_queue_ack(&restarted,0,ack,ack_n)==TE_SMALL_QUEUE_OK&&!lengths[0]&&!lengths[12]);
    assert(budget.authorized_io_bytes==authorized_before_ack+16384);
    /* True source expiry leaves a verified tombstone, not a receipt ACK. */
    fresh(); e=expected(CP_V3_QUEUE_WINDOW,2,data,1024);
    assert(te_v3_small_queue_push(&board,CP_V3_QUEUE_WINDOW,&e,data,1024,deadline,&slot)==TE_SMALL_QUEUE_OK);
    utc_lower=deadline; utc_upper=deadline+1;
    assert(te_v3_small_queue_expire(&board)==TE_SMALL_QUEUE_OK&&!lengths[0]&&lengths[12]==CP_V3_QUEUE_TOMBSTONE_BYTES);
    cp_v3_queue_tombstone_t t; assert(cp_v3_queue_tombstone_decode(values[12],lengths[12],&t));
    assert(t.ordinal==1&&t.source_expires_at_ms==deadline&&!strcmp(t.body_sha256,e.body_sha256));
    reopen(node_id,boot_id); assert(restarted.queue.next_ordinal==2);
    cp_v3_expected_t next=expected(CP_V3_QUEUE_WINDOW,3,data,1024);
    assert(te_v3_small_queue_push(&restarted,CP_V3_QUEUE_WINDOW,&next,data,1024,deadline+10000,&slot)==TE_SMALL_QUEUE_EXPIRED);
    data[0]^=1; next=expected(CP_V3_QUEUE_WINDOW,3,data,1024); te_v3_small_queue_capacity_t cap;
    assert(te_v3_small_queue_preflight(&restarted,CP_V3_QUEUE_WINDOW,&next,1024,deadline+10000,&cap)==TE_SMALL_QUEUE_OK);
    assert(cap.target_reuses_tombstone&&cap.occupied_keys==1);
    assert(te_v3_small_queue_push(&restarted,CP_V3_QUEUE_WINDOW,&next,data,1024,deadline+10000,&slot)==TE_SMALL_QUEUE_OK&&slot==0);
    assert(!lengths[12]&&restarted.queue.next_ordinal==3);
}
static void corrupt_and_foreign(void) {
    fresh(); cp_v3_expected_t e=expected(CP_V3_QUEUE_WINDOW,2,data,1024); unsigned slot=99;
    assert(te_v3_small_queue_push(&board,CP_V3_QUEUE_WINDOW,&e,data,1024,deadline,&slot)==TE_SMALL_QUEUE_OK);
    values[0][lengths[0]-13]^=1; uint8_t frozen[TE_NVS_RECORD_MAX]; size_t frozen_n=lengths[0]; memcpy(frozen,values[0],frozen_n);
    cp_v3_expected_t status=expected(CP_V3_QUEUE_STATUS,3,data,1024);
    assert(te_v3_small_queue_preflight(&board,CP_V3_QUEUE_STATUS,&status,1024,deadline,NULL)==TE_SMALL_QUEUE_UNCERTAIN);
    char ack[2048]; size_t ack_n=receipt(&e,ack);
    assert(te_v3_small_queue_ack(&board,0,ack,ack_n)==TE_SMALL_QUEUE_IO); preserved_record(0,frozen,frozen_n);
    reopen(node_id,boot_id); assert(restarted.queue.slots[0].state==CP_V3_QUEUE_QUARANTINED);
    assert(te_v3_small_queue_preflight(&restarted,CP_V3_QUEUE_STATUS,&status,1024,deadline,NULL)==TE_SMALL_QUEUE_UNCERTAIN);
    preserved_record(0,frozen,frozen_n);
    fresh(); exists=1; lengths[11]=3; memcpy(values[11],"bad",3); reopen(node_id,boot_id);
    assert(te_v3_small_queue_preflight(&restarted,CP_V3_QUEUE_WINDOW,&e,1024,deadline,NULL)==TE_SMALL_QUEUE_UNCERTAIN);
    assert(lengths[11]==3&&!memcmp(values[11],"bad",3)&&!lengths[0]);
    fresh(); e=expected(CP_V3_QUEUE_WINDOW,2,data,1024);
    assert(te_v3_small_queue_push(&board,CP_V3_QUEUE_WINDOW,&e,data,1024,deadline,&slot)==TE_SMALL_QUEUE_OK);
    reopen("synthetic-other-node",boot_id); assert(restarted.queue.slots[0].state==CP_V3_QUEUE_QUARANTINED);
    assert(te_v3_small_queue_ack(&restarted,0,ack,ack_n)==TE_SMALL_QUEUE_NOT_FOUND&&lengths[0]);
}
static bool strict_control(void *ctx,const cp_v3_expected_t *e,const void *body,size_t bn,const void *reply,size_t rn) {
    assert(held); control_calls++;
    return cp_v3_control_match_frozen_receipt(ctx,&e->scope,body,bn,reply,rn,sha_real,NULL)==CP_V3_CONTROL_OK;
}
static size_t fixture(const char *path,char *bytes,size_t cap) {
    FILE *f=fopen(path,"rb"); assert(f); size_t n=fread(bytes,1,cap,f); assert(!ferror(f)&&feof(f)&&n<cap); fclose(f); bytes[n]=0; return n;
}
static void historical_control(const char *request_path,const char *reply_path) {
    fresh(); char body[2048],reply[4096]; size_t bn=fixture(request_path,body,sizeof body),rn=fixture(reply_path,reply,sizeof reply);
    assert(bn<=1024); cp_v3_expected_t e=expected(CP_V3_QUEUE_CONTROL,2,body,bn);
    assert(v3_parse(&control_workspace,body,bn));
    strcpy(e.scope.node_id,"synthetic-stats-notregister");
    assert(v3_string(&control_workspace,v3_field(&control_workspace,0,"boot_id"),e.scope.boot_id,sizeof e.scope.boot_id));
    assert(v3_string(&control_workspace,v3_field(&control_workspace,0,"policy_id"),e.scope.policy_id,sizeof e.scope.policy_id));
    assert(v3_string(&control_workspace,v3_field(&control_workspace,0,"policy_sha256"),e.scope.policy_sha256,sizeof e.scope.policy_sha256));
    assert(v3_uint(&control_workspace,v3_field(&control_workspace,0,"assignment_generation"),1,V3_SAFE,&e.scope.assignment_generation));
    if(v3_field(&control_workspace,0,"contact_seq")>=0) strcpy(e.stream,"lease");
    applied_scope=e.scope; te_v3_small_queue_config_t cfg=config();
    assert(te_v3_small_queue_open(&board,e.scope.node_id,e.scope.boot_id,&cfg)==TE_SMALL_QUEUE_OK);
    unsigned slot=99; assert(te_v3_small_queue_push(&board,CP_V3_QUEUE_CONTROL,&e,body,bn,deadline,&slot)==TE_SMALL_QUEUE_OK&&slot==2);
    uint8_t frozen[TE_NVS_RECORD_MAX]; size_t frozen_n=lengths[2]; memcpy(frozen,values[2],frozen_n);
    reopen(e.scope.node_id,other_boot); assert(restarted.queue.historical_slots==1);
    assert(te_v3_small_queue_ack(&restarted,2,reply,rn)==TE_SMALL_QUEUE_MISMATCH);
    assert(te_v3_small_queue_ack_control(&restarted,2,reply,rn,NULL,NULL)==TE_SMALL_QUEUE_INVALID);
    unsigned before=control_calls; utc_known=false;
    assert(te_v3_small_queue_ack_control(&restarted,2,reply,rn,strict_control,&control_workspace)==TE_SMALL_QUEUE_CLOCK_UNKNOWN);
    assert(control_calls==before); utc_known=true;
    const char *fields[]={"boot_id","body_sha256","policy_sha256"};
    for(unsigned i=0;i<3;i++) {
        char modified[4096],key[80]; memcpy(modified,reply,rn+1); snprintf(key,sizeof key,"\"%s\"",fields[i]);
        char *p=strstr(modified,key); assert(p); p=strchr(p,':'); assert(p); p++;
        while(*p==' '||*p=='\n'||*p=='\r'||*p=='\t') p++;
        assert(*p=='"'); p++; *p=*p=='0'?'1':'0';
        assert(te_v3_small_queue_ack_control(&restarted,2,modified,rn,strict_control,&control_workspace)==TE_SMALL_QUEUE_MISMATCH);
        preserved_record(2,frozen,frozen_n);
    }
    assert(te_v3_small_queue_ack_control(&restarted,2,reply,rn,strict_control,&control_workspace)==TE_SMALL_QUEUE_OK);
    assert(!lengths[2]&&!lengths[14]&&control_calls==before+4);
    assert(te_v3_small_queue_push(&restarted,CP_V3_QUEUE_CONTROL,&e,body,bn,deadline,&slot)==TE_SMALL_QUEUE_RETIRED);
}
static void injected_storage_failures(void) {
    unsigned uncertain_cases=0,success_cases=0;
    for(int injection=1;injection<=130;injection++) {
        fresh(); cp_v3_expected_t e=expected(CP_V3_QUEUE_WINDOW,2,data,1024); unsigned slot=99;
        op=0; fail=injection;
        te_v3_small_queue_result_t r=te_v3_small_queue_push(&board,CP_V3_QUEUE_WINDOW,&e,data,1024,deadline,&slot); fail=0;
        assert(r==TE_SMALL_QUEUE_OK||r==TE_SMALL_QUEUE_IO);
        if(board.storage.uncertain) {
            uncertain_cases++; assert(te_v3_small_queue_expire(&board)==TE_SMALL_QUEUE_UNCERTAIN);
        }
        if(r==TE_SMALL_QUEUE_OK) { success_cases++; assert(lengths[0]&&slot==0); }
        reopen(node_id,boot_id);
        assert(restarted.queue.slots[0].state==CP_V3_QUEUE_FREE||restarted.queue.slots[0].state==CP_V3_QUEUE_PENDING);
        if(lengths[0]) {
            uint8_t restored[1024]; size_t n; cp_v3_expected_t saved;
            assert(te_v3_small_queue_read(&restarted,0,restored,sizeof restored,&n,&saved)==TE_SMALL_QUEUE_OK);
            assert(n==1024&&!memcmp(restored,data,n)&&!memcmp(&saved,&e,sizeof e));
        }
        assert(!held);
    }
    assert(uncertain_cases&&success_cases);
}
static void budget_guards_mutations(void) {
    fresh(); unsigned slot=99;
    cp_v3_expected_t e=expected(CP_V3_QUEUE_WINDOW,2,data,1024);
    budget_store_fails=true;
    assert(te_v3_small_queue_push(&board,CP_V3_QUEUE_WINDOW,&e,data,1024,deadline,&slot)==TE_SMALL_QUEUE_IO);
    assert(!exists && !lengths[0] && budget.latched && board.last_budget_result==CP_V3_BUDGET_IO);
    /* An ambiguous budget commit cannot permit a retry without reconciliation. */
    budget_store_fails=false;
    assert(te_v3_small_queue_push(&board,CP_V3_QUEUE_WINDOW,&e,data,1024,deadline,&slot)!=TE_SMALL_QUEUE_OK);

    fresh();
    assert(cp_v3_budget_configure(&budget,1000,CP_V3_BUDGET_DEFAULT_QUANTUM)==CP_V3_BUDGET_OK);
    e=expected(CP_V3_QUEUE_WINDOW,2,data,1024);
    assert(te_v3_small_queue_push(&board,CP_V3_QUEUE_WINDOW,&e,data,1024,deadline,&slot)==TE_SMALL_QUEUE_IO);
    assert(!exists && !lengths[0] && board.last_budget_result==CP_V3_BUDGET_LIMIT);

    /* A valid server receipt cannot erase the frozen record without budget. */
    fresh(); e=expected(CP_V3_QUEUE_WINDOW,2,data,1024);
    assert(te_v3_small_queue_push(&board,CP_V3_QUEUE_WINDOW,&e,data,1024,deadline,&slot)==TE_SMALL_QUEUE_OK);
    unsigned char frozen[TE_NVS_RECORD_MAX]; size_t frozen_n=lengths[0]; memcpy(frozen,values[0],frozen_n);
    char ack[2048]; size_t ack_n=receipt(&e,ack);
    assert(cp_v3_budget_configure(&budget,1000,CP_V3_BUDGET_DEFAULT_QUANTUM)==CP_V3_BUDGET_OK);
    assert(te_v3_small_queue_ack(&board,0,ack,ack_n)==TE_SMALL_QUEUE_IO);
    assert(board.last_budget_result==CP_V3_BUDGET_LIMIT); preserved_record(0,frozen,frozen_n);
}
int main(int argc,char **argv) {
    assert(argc==1||argc==3);
    basic_profile_and_capacity(); boundaries_and_policy(); malformed_never_reaches_policy();
    restart_receipts_and_expiry(); corrupt_and_foreign(); injected_storage_failures(); budget_guards_mutations();
    historical_control(argc==3?argv[1]:"firmware/t-energy-v3-trial/flash_queue/nvs_store/tests/fixtures/applied-ack-request.json",
        argc==3?argv[2]:"firmware/t-energy-v3-trial/flash_queue/nvs_store/tests/fixtures/applied-ack-receipt.json");
    puts("board small queue: real queue/NVS/SHA/strict receipt integration passed"); return 0;
}
