#include "nvs_store.h"
#include "nvs.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
static unsigned char values[24][TE_NVS_RECORD_MAX]; static size_t lengths[24];
static int exists, fail, op, wrong_type; static size_t available=500;
static int trouble(void) { return fail && ++op==fail; }
static int idx(const char *k) { assert((k[0]=='q' || k[0]=='t') && k[1]>='0' && k[1]<='1' && k[2]>='0' && k[2]<='9'); int i=(k[1]-'0')*10+k[2]-'0'; assert(i<12); return i+(k[0]=='t'?12:0); }
esp_err_t nvs_open(const char *ns,int mode,nvs_handle_t *h) { assert(!strcmp(ns,"cpv3stats1")); if(trouble())return -1; if(!exists && mode==NVS_READONLY)return ESP_ERR_NVS_NOT_FOUND; exists=1; *h=1; return ESP_OK; }
esp_err_t nvs_find_key(nvs_handle_t h,const char *k,nvs_type_t *t) { (void)h; if(trouble()) return -1; if(!lengths[idx(k)]) return ESP_ERR_NVS_NOT_FOUND; *t=wrong_type ? 1 : NVS_TYPE_BLOB; return ESP_OK; }
esp_err_t nvs_get_blob(nvs_handle_t h,const char *k,void *out,size_t *n) { (void)h; if(trouble())return -1; int i=idx(k); if(!lengths[i])return ESP_ERR_NVS_NOT_FOUND; if(out) { assert(*n>=lengths[i]); memcpy(out,values[i],lengths[i]); } *n=lengths[i]; return ESP_OK; }
esp_err_t nvs_set_blob(nvs_handle_t h,const char *k,const void *v,size_t n) { (void)h; if(trouble())return -1; int i=idx(k); assert(!lengths[i]); assert(n<=TE_NVS_RECORD_MAX); memcpy(values[i],v,n); lengths[i]=n; return ESP_OK; }
esp_err_t nvs_erase_key(nvs_handle_t h,const char *k) { (void)h; if(trouble())return -1; lengths[idx(k)]=0; return ESP_OK; }
esp_err_t nvs_commit(nvs_handle_t h) { (void)h; return trouble()?-1:ESP_OK; }
void nvs_close(nvs_handle_t h) { (void)h; }
esp_err_t nvs_get_stats(const char *name,nvs_stats_t *s) { assert(!name); if(trouble())return -1; memset(s,0,sizeof *s); s->available_entries=available; return ESP_OK; }
static te_nvs_store_t state; static cp_v3_queue_store_t q; static unsigned char data[TE_NVS_RECORD_MAX],out[TE_NVS_RECORD_MAX];
static bool test_hash(void *ctx,const void *p,size_t n,uint8_t out_hash[32]) {
    (void)ctx; const unsigned char *b=p; memset(out_hash,0,32);
    for(size_t i=0;i<n;i++) out_hash[i%32]=(uint8_t)(out_hash[i%32]*33u+b[i]);
    return true;
}
static uint64_t clock_now=100, clock_upper_delta=1; static bool clock_known=true;
static bool clock_mock(void *ctx,uint64_t *lower,uint64_t *upper) { (void)ctx; *lower=clock_now; *upper=clock_now+clock_upper_delta; return clock_known; }
static bool expire_mock(void *ctx,unsigned slot,const void *p,size_t n,const cp_v3_queue_tombstone_t *t) { (void)ctx; (void)slot; (void)p; (void)n; (void)t; return false; }
static void hash_hex(const void *p,size_t n,char out_hash[65]) {
    uint8_t h[32]; const char *hex="0123456789abcdef"; assert(test_hash(NULL,p,n,h));
    for(unsigned i=0;i<32;i++) { out_hash[2*i]=hex[h[i]>>4]; out_hash[2*i+1]=hex[h[i]&15]; } out_hash[64]=0;
}
static cp_v3_queue_t actual_queue, recovered_queue;
static size_t receipt(const cp_v3_expected_t *e,char out_receipt[2048]) {
    int n=snprintf(out_receipt,2048,"{\"protocol\":\"campuspulse/3\",\"schema\":\"device-statistics-receipt/3\",\"node_id\":\"%s\",\"boot_id\":\"%s\",\"stream\":\"%s\",\"batch_id\":\"%s\",\"body_sha256\":\"%s\",\"policy_id\":\"%s\",\"policy_sha256\":\"%s\",\"assignment_generation\":%llu,\"seq_first\":%u,\"seq_last\":%u,\"accepted_count\":1,\"receipt_id\":\"00000000-0000-4000-8000-000000000099\",\"received_at\":\"2026-10-30T00:00:00.000Z\",\"expires_at\":\"2026-10-31T00:00:00.000Z\",\"retain_until\":\"2026-11-01T00:00:00.000Z\",\"durability\":\"committed\",\"custody\":\"small_statistics\"}",e->scope.node_id,e->scope.boot_id,e->stream,e->batch_id,e->body_sha256,e->scope.policy_id,e->scope.policy_sha256,(unsigned long long)e->scope.assignment_generation,e->seq_first,e->seq_last);
    assert(n>0 && n<2048); return (size_t)n;
}
static void prepare(void) { assert(te_nvs_store_prepare(&state,&q)); assert(te_nvs_store_set_hash(&state,test_hash,NULL)); }
static void reset(void) { memset(lengths,0,sizeof lengths); exists=fail=op=wrong_type=0; available=500; prepare(); }
static int get(unsigned i) { size_t n=0; int r=q.load(q.context,i,out,sizeof out,&n); if(r==1) { assert(n==sizeof data); assert(!memcmp(out,data,n)); } return r; }
int main(void) {
    for(unsigned i=0;i<sizeof data;i++)data[i]=(unsigned char)i;
    reset(); assert(get(0)==0); assert(!exists); available=128; assert(!q.store(q.context,0,data,sizeof data)); assert(!exists);
    available=500; assert(q.store(q.context,0,data,sizeof data)); assert(get(0)==1); assert(!q.store(q.context,0,data,sizeof data));
    wrong_type=1; assert(get(0)==2); assert(!q.reclaim(q.context,0,data,sizeof data)); wrong_type=0;
    assert(q.store(q.context,1,data,sizeof data)); assert(q.store(q.context,2,data,sizeof data)); assert(!q.store(q.context,3,data,sizeof data)); data[0]^=1; assert(!q.reclaim(q.context,0,data,sizeof data)); data[0]^=1;
    assert(q.reclaim(q.context,0,data,sizeof data)); assert(get(0)==0 && get(1)==1); assert(!q.store(q.context,0,data,sizeof data+1));
    for(int f=1;f<=90;f++) {
        reset(); op=0; fail=f; bool ok=q.store(q.context,0,data,sizeof data); fail=0;
        if(!ok && (state.uncertain&1)) assert(get(0)==2);
        prepare(); int r=get(0); assert(r==0 || r==1); if(ok) assert(r==1);
        reset(); assert(q.store(q.context,0,data,sizeof data)); op=0; fail=f; ok=q.reclaim(q.context,0,data,sizeof data); fail=0;
        if(!ok && (state.uncertain&1)) assert(get(0)==2);
        prepare(); r=get(0); assert(r==0 || r==1); if(ok) assert(r==0);
    }
    reset();
    const char *node="synthetic-node", *boot="00000000-0000-4000-8000-000000000001";
    assert(cp_v3_queue_open(&actual_queue,q,node,boot,test_hash,NULL)==CP_V3_QUEUE_OK);
    cp_v3_expected_t e={0}; strcpy(e.scope.node_id,node); strcpy(e.scope.boot_id,boot);
    strcpy(e.scope.placement_id,"place"); strcpy(e.scope.policy_id,"policy"); memset(e.scope.policy_sha256,'a',64);
    strcpy(e.scope.dataset,"controlled_test"); e.scope.assignment_generation=1; e.scope.window_seq=1;
    strcpy(e.batch_id,"00000000-0000-4000-8000-000000000002"); strcpy(e.stream,"feature_summaries");
    e.seq_first=e.seq_last=e.accepted_count=1; e.body_bytes=1024; hash_hex(data,e.body_bytes,e.body_sha256);
    unsigned slot=99; assert(cp_v3_queue_push(&actual_queue,CP_V3_QUEUE_FEATURE,&e,data,1024,&slot)==CP_V3_QUEUE_OK);
    assert(slot==0 && lengths[0]==1524);
    prepare();
    assert(cp_v3_queue_open(&recovered_queue,q,node,boot,test_hash,NULL)==CP_V3_QUEUE_OK);
    unsigned char restored[1024]; size_t restored_len=0; cp_v3_expected_t saved;
    assert(cp_v3_queue_read(&recovered_queue,slot,restored,sizeof restored,&restored_len,&saved)==CP_V3_QUEUE_OK);
    assert(restored_len==1024 && !memcmp(restored,data,1024) && !strcmp(saved.batch_id,e.batch_id));
    reset();
    cp_v3_queue_profile_config_t config={.profile=CP_V3_QUEUE_SMALL_RESULTS,.clock=clock_mock,.expire=expire_mock};
    assert(cp_v3_queue_open_profile(&actual_queue,q,node,boot,test_hash,NULL,&config)==CP_V3_QUEUE_OK);
    strcpy(e.stream,"window_statistics"); strcpy(e.batch_id,"00000000-0000-4000-8000-000000000002");
    assert(cp_v3_queue_push_expiring(&actual_queue,CP_V3_QUEUE_WINDOW,&e,data,1024,1000,&slot)==CP_V3_QUEUE_OK);
    assert(slot==0 && lengths[0]==1542);
    strcpy(e.stream,"node_status"); strcpy(e.batch_id,"00000000-0000-4000-8000-000000000003");
    assert(cp_v3_queue_push_expiring(&actual_queue,CP_V3_QUEUE_STATUS,&e,data,1024,1000,&slot)==CP_V3_QUEUE_OK && slot==8);
    strcpy(e.stream,"control"); strcpy(e.batch_id,"00000000-0000-4000-8000-000000000004");
    assert(cp_v3_queue_push_expiring(&actual_queue,CP_V3_QUEUE_CONTROL,&e,data,1024,1000,&slot)==CP_V3_QUEUE_INVALID);
    strcpy(e.stream,"config_ack");
    assert(cp_v3_queue_push_expiring(&actual_queue,CP_V3_QUEUE_CONTROL,&e,data,1024,1000,&slot)==CP_V3_QUEUE_OK && slot==10);
    strcpy(e.stream,"candidate_events"); strcpy(e.batch_id,"00000000-0000-4000-8000-000000000005");
    assert(cp_v3_queue_push_expiring(&actual_queue,CP_V3_QUEUE_EVENT,&e,data,1024,1000,&slot)==CP_V3_QUEUE_IO);
    assert(lengths[0]==1542 && lengths[8]==1542 && lengths[10]==1542 && !lengths[4]);
    reset(); clock_now=100; config.expire=te_nvs_store_expire; config.retention_context=&state;
    assert(cp_v3_queue_open_profile(&actual_queue,q,node,boot,test_hash,NULL,&config)==CP_V3_QUEUE_OK);
    strcpy(e.stream,"window_statistics"); strcpy(e.batch_id,"00000000-0000-4000-8000-000000000002");
    assert(cp_v3_queue_push_expiring(&actual_queue,CP_V3_QUEUE_WINDOW,&e,data,1024,1000,&slot)==CP_V3_QUEUE_OK);
    uint8_t old_record[TE_NVS_RECORD_MAX], tomb_bytes[CP_V3_QUEUE_TOMBSTONE_BYTES]; size_t old_len=lengths[0];
    memcpy(old_record,values[0],old_len); cp_v3_queue_tombstone_t tomb;
    assert(cp_v3_queue_record_check(old_record,old_len,0,test_hash,NULL,&tomb));
    assert(cp_v3_queue_tombstone_encode(&tomb,tomb_bytes,sizeof tomb_bytes));
    clock_now=1001; assert(cp_v3_queue_expire(&actual_queue)==CP_V3_QUEUE_OK);
    assert(actual_queue.slots[slot].state==CP_V3_QUEUE_FREE);
    prepare();
    assert(cp_v3_queue_open_profile(&recovered_queue,q,node,boot,test_hash,NULL,&config)==CP_V3_QUEUE_OK);
    assert(recovered_queue.slots[slot].state==CP_V3_QUEUE_FREE && recovered_queue.next_ordinal==2);
    clock_now=100; strcpy(e.batch_id,"00000000-0000-4000-8000-000000000006"); data[0]^=1; hash_hex(data,1024,e.body_sha256);
    assert(cp_v3_queue_push_expiring(&recovered_queue,CP_V3_QUEUE_WINDOW,&e,data,1024,1000,&slot)==CP_V3_QUEUE_OK);
    uint8_t new_record[TE_NVS_RECORD_MAX]; size_t new_len=lengths[0]; memcpy(new_record,values[0],new_len); data[0]^=1; hash_hex(data,1024,e.body_sha256);
    cp_v3_queue_tombstone_t next; assert(cp_v3_queue_record_check(new_record,new_len,0,test_hash,NULL,&next) && next.ordinal==2);
    for(int f=0;f<=160;f++) {
        reset(); exists=1; memcpy(values[0],old_record,old_len); lengths[0]=old_len;
        op=0; fail=f; bool ok=te_nvs_store_expire(&state,0,old_record,old_len,&tomb); fail=0; prepare();
        size_t n=0; int r=q.load(q.context,0,out,sizeof out,&n);
        assert(r==1 || r==3 || r==4);
        if(r==1) assert(n==old_len && !memcmp(out,old_record,n) && !lengths[12]);
        else { cp_v3_queue_tombstone_t seen; assert(cp_v3_queue_tombstone_decode(out,n,&seen) && seen.ordinal==1); }
        if(ok) assert(r==3 && !lengths[0]);
        assert(cp_v3_queue_open_profile(&actual_queue,q,node,boot,test_hash,NULL,&config)==CP_V3_QUEUE_OK);
        assert(actual_queue.next_ordinal>=2);
    }
    for(int f=0;f<=200;f++) {
        reset(); exists=1; memcpy(values[12],tomb_bytes,sizeof tomb_bytes); lengths[12]=sizeof tomb_bytes;
        assert(!q.store(q.context,0,old_record,old_len));
        op=0; fail=f; bool ok=q.store(q.context,0,new_record,new_len); fail=0; prepare();
        size_t n=0; int r=q.load(q.context,0,out,sizeof out,&n);
        assert(r==1 || r==3 || r==4); if(ok) assert(r==1 && n==new_len && !memcmp(out,new_record,n));
        if(r==1) { cp_v3_queue_tombstone_t verified; assert(cp_v3_queue_record_check(out,n,0,test_hash,NULL,&verified) && verified.ordinal==2); }
        else { cp_v3_queue_tombstone_t verified; assert(cp_v3_queue_tombstone_decode(out,n,&verified) && verified.ordinal==1); }
        assert(cp_v3_queue_open_profile(&actual_queue,q,node,boot,test_hash,NULL,&config)==CP_V3_QUEUE_OK);
        assert(actual_queue.next_ordinal>=2);
    }
    /* An old body next to its tombstone must never be returned as pending. */
    reset(); exists=1; memcpy(values[12],tomb_bytes,sizeof tomb_bytes); lengths[12]=sizeof tomb_bytes;
    memcpy(values[0],old_record,old_len); lengths[0]=old_len; size_t check_len=0;
    assert(q.load(q.context,0,out,sizeof out,&check_len)==4);
    memcpy(values[0],new_record,new_len); lengths[0]=new_len; values[0][new_len-13]^=1;
    assert(q.load(q.context,0,out,sizeof out,&check_len)==4); /* damaged newer q */
    cp_v3_queue_tombstone_t later=tomb; later.ordinal=3;
    assert(cp_v3_queue_tombstone_encode(&later,values[12],sizeof tomb_bytes));
    memcpy(values[0],new_record,new_len); lengths[0]=new_len;
    assert(q.load(q.context,0,out,sizeof out,&check_len)==4); /* q ordinal below t */
    for(int f=0;f<=120;f++) {
        reset(); exists=1; memcpy(values[12],tomb_bytes,sizeof tomb_bytes); lengths[12]=sizeof tomb_bytes;
        memcpy(values[0],new_record,new_len); lengths[0]=new_len;
        op=0; fail=f; bool ok=q.reclaim(q.context,0,new_record,new_len); fail=0; prepare();
        size_t n=0; int r=q.load(q.context,0,out,sizeof out,&n);
        assert(r==0 || r==1); if(ok) assert(r==0);
        assert(lengths[0] || !lengths[12]); /* never erase q before old t */
        if(r==1) assert(n==new_len && !memcmp(out,new_record,n));
    }
    /* A newer committed q with an older leftover tombstone can itself expire.
     * Interrupt every operation; q must survive until its own tombstone exists. */
    for(int f=0;f<=200;f++) {
        reset(); exists=1; memcpy(values[12],tomb_bytes,sizeof tomb_bytes); lengths[12]=sizeof tomb_bytes;
        memcpy(values[0],new_record,new_len); lengths[0]=new_len;
        op=0; fail=f; bool ok=te_nvs_store_expire(&state,0,new_record,new_len,&next); fail=0; prepare();
        size_t n=0; int r=q.load(q.context,0,out,sizeof out,&n);
        assert(r==1 || r==3 || r==4);
        if(r==1) assert(n==new_len && !memcmp(out,new_record,n));
        else { cp_v3_queue_tombstone_t seen; assert(cp_v3_queue_tombstone_decode(out,n,&seen) && seen.ordinal==2); }
        if(!lengths[0]) { cp_v3_queue_tombstone_t seen; assert(lengths[12] && cp_v3_queue_tombstone_decode(values[12],lengths[12],&seen) && seen.ordinal==2); }
        if(ok) assert(r==3 && !lengths[0]);
        assert(cp_v3_queue_open_profile(&actual_queue,q,node,boot,test_hash,NULL,&config)==CP_V3_QUEUE_OK);
        assert(actual_queue.next_ordinal>=3);
    }
    reset(); clock_now=100; clock_upper_delta=1; clock_known=true;
    config=(cp_v3_queue_profile_config_t){.profile=CP_V3_QUEUE_SMALL_RESULTS,.clock=clock_mock,.expire=expire_mock,.limits={1,0,1,1,1024}};
    assert(cp_v3_queue_open_profile(&actual_queue,q,node,boot,test_hash,NULL,&config)==CP_V3_QUEUE_OK);
    cp_v3_expected_t records[3]={e,e,e}; unsigned positions[3];
    const char *streams[]={"window_statistics","node_status","config_ack"};
    cp_v3_queue_kind_t kinds[]={CP_V3_QUEUE_WINDOW,CP_V3_QUEUE_STATUS,CP_V3_QUEUE_CONTROL};
    for(unsigned i=0;i<3;i++) {
        strcpy(records[i].stream,streams[i]); snprintf(records[i].batch_id,sizeof records[i].batch_id,"00000000-0000-4000-8000-%012u",i+2);
        records[i].seq_first=records[i].seq_last=i+1;
        assert(cp_v3_queue_push_expiring(&actual_queue,kinds[i],&records[i],data,1024,1000,&positions[i])==CP_V3_QUEUE_OK);
        assert(positions[i]==i && lengths[i]==1542);
    }
    cp_v3_expected_t fourth=records[0]; strcpy(fourth.batch_id,"00000000-0000-4000-8000-000000000010"); fourth.seq_first=fourth.seq_last=10;
    assert(cp_v3_queue_push_expiring(&actual_queue,CP_V3_QUEUE_WINDOW,&fourth,data,1024,1000,&slot)==CP_V3_QUEUE_FULL);
    assert(!q.store(q.context,3,data,1024));
    prepare();
    assert(cp_v3_queue_open_profile(&recovered_queue,q,node,boot,test_hash,NULL,&config)==CP_V3_QUEUE_OK);
    for(unsigned i=0;i<3;i++) { assert(cp_v3_queue_read(&recovered_queue,positions[i],restored,sizeof restored,&restored_len,&saved)==CP_V3_QUEUE_OK);
        assert(restored_len==1024 && !memcmp(restored,data,1024) && !strcmp(saved.batch_id,records[i].batch_id)); }
    assert(cp_v3_queue_open_profile(&actual_queue,q,node,"00000000-0000-4000-8000-000000000099",test_hash,NULL,&config)==CP_V3_QUEUE_OK);
    for(unsigned i=0;i<3;i++) assert(actual_queue.slots[positions[i]].state==CP_V3_QUEUE_QUARANTINED && lengths[positions[i]]==1542);
    char ack[2048]; size_t ack_len=receipt(&records[0],ack); assert(cp_v3_statistics_receipt_matches(ack,ack_len,&records[0]));
    clock_now=999; clock_upper_delta=1; assert(cp_v3_queue_ack(&recovered_queue,0,ack,ack_len)==CP_V3_QUEUE_CLOCK_UNKNOWN && lengths[0]);
    clock_known=false; assert(cp_v3_queue_ack(&recovered_queue,0,ack,ack_len)==CP_V3_QUEUE_CLOCK_UNKNOWN && lengths[0]);
    clock_known=true; clock_now=100; clock_upper_delta=1;
    ack[ack_len-2]^=1; assert(cp_v3_queue_ack(&recovered_queue,0,ack,ack_len)==CP_V3_QUEUE_MISMATCH && lengths[0]);
    ack_len=receipt(&records[0],ack); assert(cp_v3_queue_ack(&recovered_queue,0,ack,ack_len)==CP_V3_QUEUE_OK && !lengths[0]);
    ack_len=receipt(&records[1],ack); assert(cp_v3_queue_ack(&recovered_queue,1,ack,ack_len)==CP_V3_QUEUE_OK && !lengths[1]);
    ack_len=receipt(&records[2],ack); assert(cp_v3_queue_ack(&recovered_queue,2,ack,ack_len)==CP_V3_QUEUE_MISMATCH && lengths[2]);
    puts("NVS store tests passed");
    return 0;
}
