#include "cp_v3_queue.h"
#include "raw_v3_queue_store.h"
#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <openssl/sha.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static uint8_t disk[CP_V3_QUEUE_SLOTS][CP_V3_QUEUE_SLOT_BYTES];
static size_t sizes[CP_V3_QUEUE_SLOTS];
static int fail_load,fail_store,fail_reclaim;
static bool hash(void *ctx,const void *p,size_t n,uint8_t out[32]) { (void)ctx; return SHA256(p,n,out)!=NULL; }
static void hex(const void *p,size_t n,char out[65]) {
    uint8_t digest[32]; assert(hash(NULL,p,n,digest));
    for(unsigned i=0;i<32;i++) snprintf(out+2*i,3,"%02x",digest[i]);
}
static int load(void *ctx,unsigned slot,void *out,size_t cap,size_t *n) {
    (void)ctx; if(fail_load) return -1;
    *n=sizes[slot]; if(!*n) return 0; if(*n>cap) return 2; memcpy(out,disk[slot],*n); return 1;
}
static bool store(void *ctx,unsigned slot,const void *p,size_t n) {
    (void)ctx; if(sizes[slot]) return false;
    if(fail_store==1) return false;
    memcpy(disk[slot],p,n); sizes[slot]=fail_store==2?n/2:n;
    return !fail_store;
}
static bool reclaim(void *ctx,unsigned slot,const void *p,size_t n) {
    (void)ctx;
    if(fail_reclaim||sizes[slot]!=n||memcmp(p,disk[slot],n)) return false;
    sizes[slot]=0; memset(disk[slot],0,sizeof disk[slot]); return true;
}
static const char *node="synthetic-node",*boot="00000000-0000-4000-8000-000000000001";
static const char *body="{\"synthetic\":true}";
static cp_v3_queue_store_t backend(void) { return (cp_v3_queue_store_t){NULL,load,store,reclaim}; }
static cp_v3_expected_t expected(unsigned id,cp_v3_queue_kind_t kind) {
    cp_v3_expected_t e={0}; strcpy(e.scope.node_id,node); strcpy(e.scope.boot_id,boot);
    strcpy(e.scope.placement_id,"synthetic-place"); strcpy(e.scope.policy_id,"synthetic-policy");
    memset(e.scope.policy_sha256,'a',64); strcpy(e.scope.dataset,"controlled_test");
    e.scope.assignment_generation=1; e.scope.window_seq=1;
    snprintf(e.batch_id,sizeof e.batch_id,"00000000-0000-4000-8000-%012u",id);
    strcpy(e.stream,kind==CP_V3_QUEUE_FEATURE?"feature_summaries":kind==CP_V3_QUEUE_STATUS?"node_status":"control");
    e.seq_first=e.seq_last=id; e.accepted_count=1; e.body_bytes=strlen(body); hex(body,e.body_bytes,e.body_sha256); return e;
}
static size_t receipt(const cp_v3_expected_t *e,char out[2048]) {
    int n=snprintf(out,2048,"{\"protocol\":\"campuspulse/3\",\"schema\":\"device-ingest-receipt/3\","
        "\"node_id\":\"%s\",\"boot_id\":\"%s\",\"stream\":\"%s\",\"batch_id\":\"%s\",\"body_sha256\":\"%s\","
        "\"policy_id\":\"%s\",\"policy_sha256\":\"%s\",\"assignment_generation\":%llu,"
        "\"seq_first\":%u,\"seq_last\":%u,\"accepted_count\":1,"
        "\"receipt_id\":\"00000000-0000-4000-8000-000000000099\","
        "\"received_at\":\"2026-10-30T00:00:00.000Z\",\"expires_at\":\"2026-10-31T00:00:00.000Z\","
        "\"retain_until\":\"2026-11-01T00:00:00.000Z\",\"durability\":\"committed\","
        "\"custody\":\"private_source\",\"inference\":\"not_performed\",\"window_completeness\":\"not_established\"}",
        e->scope.node_id,e->scope.boot_id,e->stream,e->batch_id,e->body_sha256,e->scope.policy_id,e->scope.policy_sha256,
        (unsigned long long)e->scope.assignment_generation,e->seq_first,e->seq_last);
    assert(n>0&&n<2048); return (size_t)n;
}
static void reset(void) { memset(sizes,0,sizeof sizes); memset(disk,0,sizeof disk); fail_load=fail_store=fail_reclaim=0; }
static cp_v3_queue_t queue,recovered;
static void reopen(cp_v3_queue_t *q) { assert(cp_v3_queue_open(q,backend(),node,boot,hash,NULL)==CP_V3_QUEUE_OK); }
static unsigned push(cp_v3_queue_t *q,unsigned id,cp_v3_queue_kind_t kind) {
    cp_v3_expected_t e=expected(id,kind); unsigned slot;
    assert(cp_v3_queue_push(q,kind,&e,body,strlen(body),&slot)==CP_V3_QUEUE_OK); return slot;
}
static void tests(void) {
    reset(); reopen(&queue); unsigned first=push(&queue,1,CP_V3_QUEUE_FEATURE);
    assert(first==0&&cp_v3_queue_pending(&queue,CP_V3_QUEUE_FEATURE)==1);
    assert(cp_v3_queue_pending_bytes(&queue,CP_V3_QUEUE_FEATURE)==strlen(body));
    assert(push(&queue,1,CP_V3_QUEUE_FEATURE)==first);
    cp_v3_expected_t e=expected(1,CP_V3_QUEUE_FEATURE); e.scope.assignment_generation++;
    unsigned slot=99; assert(cp_v3_queue_push(&queue,CP_V3_QUEUE_FEATURE,&e,body,strlen(body),&slot)==CP_V3_QUEUE_MISMATCH);
    e=expected(2,CP_V3_QUEUE_FEATURE); e.body_sha256[0]^=1;
    assert(cp_v3_queue_push(&queue,CP_V3_QUEUE_FEATURE,&e,body,strlen(body),&slot)!=CP_V3_QUEUE_OK);
    reopen(&recovered); char output[4096]; size_t length; cp_v3_expected_t saved;
    assert(cp_v3_queue_read(&recovered,first,output,sizeof output,&length,&saved)==CP_V3_QUEUE_OK);
    assert(length==strlen(body)&&!memcmp(body,output,length)&&!strcmp(saved.batch_id,expected(1,CP_V3_QUEUE_FEATURE).batch_id));
    for(unsigned i=2;i<=8;i++) push(&queue,i,CP_V3_QUEUE_FEATURE);
    e=expected(9,CP_V3_QUEUE_FEATURE);
    assert(cp_v3_queue_push(&queue,CP_V3_QUEUE_FEATURE,&e,body,strlen(body),&slot)==CP_V3_QUEUE_FULL);
    assert(push(&queue,20,CP_V3_QUEUE_STATUS)==8&&push(&queue,21,CP_V3_QUEUE_STATUS)==9);
    assert(push(&queue,30,CP_V3_QUEUE_CONTROL)==10&&push(&queue,31,CP_V3_QUEUE_CONTROL)==11);
    assert(cp_v3_queue_oldest(&queue,CP_V3_QUEUE_FEATURE,&slot)==CP_V3_QUEUE_OK&&slot==first);
    char ack[2048]; e=expected(1,CP_V3_QUEUE_FEATURE); size_t n=receipt(&e,ack);
    assert(cp_v3_queue_ack(&queue,first,"{\"durability\":\"committed\"}",26)==CP_V3_QUEUE_MISMATCH);
    char *generation=strstr(ack,"\"assignment_generation\":1"); assert(generation); generation[strlen("\"assignment_generation\":")]='2';
    assert(cp_v3_queue_ack(&queue,first,ack,n)==CP_V3_QUEUE_MISMATCH);
    n=receipt(&e,ack); assert(cp_v3_queue_ack(&queue,first,ack,n)==CP_V3_QUEUE_OK&&!sizes[first]);
    assert(push(&queue,9,CP_V3_QUEUE_FEATURE)==first);
    e=expected(30,CP_V3_QUEUE_CONTROL); n=receipt(&e,ack);
    assert(cp_v3_queue_ack(&queue,10,ack,n)==CP_V3_QUEUE_MISMATCH);
    reset(); reopen(&queue); first=push(&queue,1,CP_V3_QUEUE_FEATURE);
    disk[first][sizes[first]-13]^=1;
    assert(cp_v3_queue_read(&queue,first,output,sizeof output,&length,&saved)==CP_V3_QUEUE_IO);
    assert(queue.slots[first].state==CP_V3_QUEUE_QUARANTINED);
    reopen(&recovered); assert(recovered.corrupt_slots==1&&sizes[first]);
    reset(); reopen(&queue); fail_store=2; e=expected(1,CP_V3_QUEUE_FEATURE);
    assert(cp_v3_queue_push(&queue,CP_V3_QUEUE_FEATURE,&e,body,strlen(body),&slot)==CP_V3_QUEUE_IO);
    fail_store=0; reopen(&recovered); assert(recovered.corrupt_slots==1&&sizes[0]);
    reset(); reopen(&queue); fail_store=3; e=expected(1,CP_V3_QUEUE_FEATURE);
    assert(cp_v3_queue_push(&queue,CP_V3_QUEUE_FEATURE,&e,body,strlen(body),&slot)==CP_V3_QUEUE_IO);
    assert(cp_v3_queue_push(&queue,CP_V3_QUEUE_FEATURE,&e,body,strlen(body),&slot)==CP_V3_QUEUE_MISMATCH);
    fail_store=0; push(&queue,2,CP_V3_QUEUE_FEATURE); reopen(&recovered);
    assert(cp_v3_queue_pending(&recovered,CP_V3_QUEUE_FEATURE)==2&&!recovered.corrupt_slots);
    reset(); reopen(&queue); first=push(&queue,1,CP_V3_QUEUE_FEATURE);
    assert(cp_v3_queue_open(&recovered,backend(),node,"00000000-0000-4000-8000-000000000002",hash,NULL)==CP_V3_QUEUE_OK);
    assert(recovered.retired_slots==1&&cp_v3_queue_oldest(&recovered,CP_V3_QUEUE_FEATURE,&slot)==CP_V3_QUEUE_NOT_FOUND);
    e=expected(1,CP_V3_QUEUE_FEATURE);
    assert(cp_v3_queue_push(&recovered,CP_V3_QUEUE_FEATURE,&e,body,strlen(body),&slot)==CP_V3_QUEUE_RETIRED);
    reset(); reopen(&queue); first=push(&queue,1,CP_V3_QUEUE_FEATURE); n=receipt(&e,ack); fail_reclaim=1;
    assert(cp_v3_queue_ack(&queue,first,ack,n)==CP_V3_QUEUE_IO&&sizes[first]);
    fail_reclaim=0; reopen(&recovered); assert(cp_v3_queue_pending(&recovered,CP_V3_QUEUE_FEATURE)==1);
    assert(cp_v3_queue_ack(&recovered,first,ack,n)==CP_V3_QUEUE_OK);
    fail_load=1; assert(cp_v3_queue_open(&recovered,backend(),node,boot,hash,NULL)==CP_V3_QUEUE_IO&&!recovered.ready);
    printf("queue synthetic failures passed; RAM=%zu bytes, body budget=%u, slot budget=%u\n",sizeof queue,
        CP_V3_QUEUE_BODY_MAX*CP_V3_QUEUE_SLOTS,CP_V3_QUEUE_SLOT_BYTES*CP_V3_QUEUE_SLOTS);
}
static raw_v3_queue_store_t files;
static unsigned sync_calls,fail_sync_at;
static bool media(void *ctx) { (void)ctx; return ++sync_calls!=fail_sync_at; }
static void write_file(const char *path,const void *p,size_t n) {
    FILE *f=fopen(path,"wb"); assert(f&&fwrite(p,1,n,f)==n&&!fclose(f));
}
static void files_test(const char *root) {
    char dir[192],raw[224],file[224]; snprintf(dir,sizeof dir,"%s/cpv3queue",root); snprintf(raw,sizeof raw,"%s/cpraw",root);
    assert(!mkdir(raw,0700)); snprintf(file,sizeof file,"%s/cpraw/original.bin",root); write_file(file,"preserved",9);
    cp_v3_queue_store_t fs; assert(raw_v3_queue_store_prepare(&files,dir,NULL,NULL,&fs));
    assert(cp_v3_queue_open(&queue,fs,node,boot,hash,NULL)==CP_V3_QUEUE_OK); unsigned slot=push(&queue,1,CP_V3_QUEUE_FEATURE);
    assert(cp_v3_queue_open(&recovered,fs,node,boot,hash,NULL)==CP_V3_QUEUE_OK);
    assert(cp_v3_queue_pending(&recovered,CP_V3_QUEUE_FEATURE)==1);
    char ack[2048]; cp_v3_expected_t e=expected(1,CP_V3_QUEUE_FEATURE); size_t n=receipt(&e,ack);
    assert(cp_v3_queue_ack(&recovered,slot,ack,n)==CP_V3_QUEUE_OK);
    snprintf(file,sizeof file,"%s/q00.tmp",dir); write_file(file,"torn",4);
    assert(cp_v3_queue_open(&queue,fs,node,boot,hash,NULL)==CP_V3_QUEUE_OK&&queue.corrupt_slots==1);
    slot=push(&queue,2,CP_V3_QUEUE_FEATURE); assert(slot==1);
    snprintf(file,sizeof file,"%s/q01.rec",dir); FILE *f=fopen(file,"r+b"); assert(f); assert(!fseek(f,490,SEEK_SET)); assert(fputc('X',f)!=EOF); assert(!fclose(f));
    char output[4096]; size_t length; cp_v3_expected_t saved;
    assert(cp_v3_queue_read(&queue,slot,output,sizeof output,&length,&saved)==CP_V3_QUEUE_IO);
    /* Fail metadata sync after publishing: caller receives no false success;
     * restart recovers unchanged identity from surviving complete file. */
    sync_calls=0; fail_sync_at=2; assert(raw_v3_queue_store_prepare(&files,dir,media,NULL,&fs));
    assert(cp_v3_queue_open(&queue,fs,node,boot,hash,NULL)==CP_V3_QUEUE_OK);
    e=expected(3,CP_V3_QUEUE_FEATURE);
    assert(cp_v3_queue_push(&queue,CP_V3_QUEUE_FEATURE,&e,body,strlen(body),&slot)==CP_V3_QUEUE_IO);
    fail_sync_at=0; assert(cp_v3_queue_open(&queue,fs,node,boot,hash,NULL)==CP_V3_QUEUE_OK);
    assert(cp_v3_queue_pending(&queue,CP_V3_QUEUE_FEATURE)==1);
    assert(cp_v3_queue_oldest(&queue,CP_V3_QUEUE_FEATURE,&slot)==CP_V3_QUEUE_OK);
    n=receipt(&e,ack); sync_calls=0; fail_sync_at=2;
    assert(cp_v3_queue_ack(&queue,slot,ack,n)==CP_V3_QUEUE_IO);
    fail_sync_at=0; assert(cp_v3_queue_open(&queue,fs,node,boot,hash,NULL)==CP_V3_QUEUE_OK);
    assert(cp_v3_queue_pending(&queue,CP_V3_QUEUE_FEATURE)==0&&queue.corrupt_slots==3);
    snprintf(file,sizeof file,"%s/cpraw/original.bin",root); char check[10]={0}; f=fopen(file,"rb");
    assert(f&&fread(check,1,9,f)==9&&!fclose(f)&&!strcmp(check,"preserved"));
    puts("TF/POSIX synthetic failure recovery passed; original raw preserved");
}
int main(int argc,char **argv) { tests(); if(argc==2) files_test(argv[1]); return 0; }
