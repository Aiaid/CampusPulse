#include "runtime_budget.h"
#include "runtime_lifecycle.h"
#include <assert.h>
#include <openssl/sha.h>
#include <stdio.h>
static uint64_t lower=1898553600000ULL,upper=1898553600010ULL;
typedef struct {uint8_t bytes[96];size_t size;unsigned writes;} provider_t;
static cp_v3_budget_load_t load(void *ctx,void *out,size_t cap,size_t *size){provider_t *p=ctx;*size=p->size;if(!p->size)return CP_V3_BUDGET_LOAD_ABSENT;assert(cap>=p->size);memcpy(out,p->bytes,p->size);return CP_V3_BUDGET_LOAD_PRESENT;}
static bool store(void *ctx,const void *bytes,size_t size){provider_t *p=ctx;assert(size==96);p->writes++;memcpy(p->bytes,bytes,size);p->size=size;return true;}
static cp_v3_budget_store_t provider(provider_t *p){return(cp_v3_budget_store_t){p,load,store,4096};}
static cp_v3_budget_t storage;
static bool charge(void *ctx,uint64_t bytes){(void)ctx;return cp_v3_budget_charge(&storage,bytes,lower,upper)==CP_V3_BUDGET_OK;}
static bool hash(void *ctx,const void *p,size_t n,uint8_t out[32]){(void)ctx;return SHA256(p,n,out)!=NULL;}
static uint8_t records[12][6144];static size_t lengths[12];static unsigned cleanups;
static int qload(void *ctx,unsigned slot,void *out,size_t cap,size_t *size){(void)ctx;*size=lengths[slot];if(!*size)return 0;assert(cap>=*size);memcpy(out,records[slot],*size);return 1;}
static bool qstore(void *ctx,unsigned slot,const void *p,size_t n){(void)ctx;assert(!lengths[slot]);memcpy(records[slot],p,n);lengths[slot]=n;return true;}
static bool qreclaim(void *ctx,unsigned slot,const void *p,size_t n){(void)ctx;(void)slot;(void)p;(void)n;return false;}
static bool clock_now(void *ctx,uint64_t *l,uint64_t *u){(void)ctx;*l=lower;*u=upper;return true;}
static bool expire(void *ctx,unsigned slot,const void *p,size_t n,const cp_v3_queue_tombstone_t *t){(void)ctx;(void)t;if(!edge_lifecycle_record(p,n,slot,"synthetic-node",hash,NULL))return false;assert(n==lengths[slot]);lengths[slot]=0;cleanups++;return true;}
int main(void){
    uint8_t owner[32]={1},other[32]={2},marker[64];edge_lifecycle_marker(owner,marker);
    assert(edge_lifecycle_marker_matches(marker,64,owner));assert(!edge_lifecycle_marker_matches(marker,64,other));marker[45]^=1;assert(!edge_lifecycle_marker_matches(marker,64,owner));assert(edge_lifecycle_charge(100)==1836&&!edge_lifecycle_charge(0)&&!edge_lifecycle_charge(6145));
    provider_t sd={0},up={0};assert(cp_v3_budget_open(&storage,provider(&sd),owner)==CP_V3_BUDGET_OK);assert(cp_v3_budget_configure(&storage,1048576,65536)==CP_V3_BUDGET_OK);
    edge_budget_bridge_t bridge={provider(&up),charge,NULL};cp_v3_budget_t uplink;
    assert(cp_v3_budget_open(&uplink,edge_budget_provider(&bridge),other)==CP_V3_BUDGET_OK);assert(cp_v3_budget_configure(&uplink,1048576,65536)==CP_V3_BUDGET_OK);
    assert(cp_v3_budget_charge(&uplink,1234,lower,upper)==CP_V3_BUDGET_OK&&sd.writes==1&&up.writes==1&&storage.authorized_io_bytes==4096);
    uint64_t spent=uplink.record.reserved_bytes;assert(cp_v3_budget_charge(&uplink,1234,lower,upper)==CP_V3_BUDGET_OK&&uplink.authorized_io_bytes==2468); /* exact body retry is charged again */
    cp_v3_budget_t reopened;assert(cp_v3_budget_open(&reopened,edge_budget_provider(&bridge),other)==CP_V3_BUDGET_OK&&reopened.record.reserved_bytes==spent&&!reopened.credit_bytes);assert(cp_v3_budget_configure(&reopened,1048576,65536)==CP_V3_BUDGET_OK);assert(cp_v3_budget_charge(&reopened,1234,lower,upper)==CP_V3_BUDGET_OK&&reopened.record.reserved_bytes>spent);
    unsigned before=up.writes;assert(cp_v3_budget_configure(&storage,0,65536)==CP_V3_BUDGET_OK);assert(cp_v3_budget_configure(&reopened,1048576,65536)==CP_V3_BUDGET_OK);reopened.credit_bytes=0;assert(cp_v3_budget_charge(&reopened,1234,lower,upper)!=CP_V3_BUDGET_OK&&up.writes==before&&reopened.latched); /* storage denial happens before uplink journal */
    assert(cp_v3_budget_configure(&storage,1048576,65536)==CP_V3_BUDGET_OK);
    cp_v3_queue_t queue;cp_v3_queue_store_t qs={NULL,qload,qstore,qreclaim};cp_v3_queue_profile_config_t config={.profile=CP_V3_QUEUE_SMALL_RESULTS,.clock=clock_now,.expire=expire,.limits={4,4,2,2,2048}};
    const char *boot="00000000-0000-4000-8000-000000000001",*body="{\"synthetic\":true}";assert(cp_v3_queue_open_profile(&queue,qs,"synthetic-node",boot,hash,NULL,&config)==CP_V3_QUEUE_OK);
    cp_v3_expected_t e={.seq_first=1,.seq_last=1,.accepted_count=1,.body_bytes=strlen(body)};strcpy(e.scope.node_id,"synthetic-node");strcpy(e.scope.boot_id,boot);strcpy(e.scope.policy_id,"synthetic-policy");strcpy(e.scope.placement_id,"synthetic-place");memset(e.scope.policy_sha256,'a',64);strcpy(e.scope.dataset,"controlled_test");e.scope.assignment_generation=1;e.scope.window_seq=1;strcpy(e.batch_id,boot);strcpy(e.stream,"window_statistics");uint8_t sha[32];assert(hash(NULL,body,strlen(body),sha));for(unsigned i=0;i<32;i++)snprintf(e.body_sha256+2*i,3,"%02x",sha[i]);
    uint64_t lifecycle=edge_lifecycle_charge(cp_v3_queue_encoded_size(&queue,strlen(body)));assert(charge(NULL,lifecycle));unsigned slot;assert(cp_v3_queue_push_expiring(&queue,CP_V3_QUEUE_WINDOW,&e,body,strlen(body),lower+1000,&slot)==CP_V3_QUEUE_OK);
    assert(edge_lifecycle_record(records[slot],lengths[slot],slot,"synthetic-node",hash,NULL));assert(!edge_lifecycle_record(records[slot],lengths[slot],slot,"other-node",hash,NULL));records[slot][0]='X';assert(!edge_lifecycle_record(records[slot],lengths[slot],slot,"synthetic-node",hash,NULL));records[slot][0]='C';
    uint64_t authorized=storage.authorized_io_bytes;assert(cp_v3_budget_configure(&storage,0,65536)==CP_V3_BUDGET_OK);lower+=2000;upper+=2000;assert(cp_v3_queue_expire(&queue)==CP_V3_QUEUE_OK&&cleanups==1&&!lengths[slot]&&storage.authorized_io_bytes==authorized); /* exact prepaid TTL obligation needs no fresh/general credit */
    puts("Persistent dual budgets, journal ordering, exact lifecycle ownership and prepaid TTL cleanup passed");
}
