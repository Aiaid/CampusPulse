/* Real board adapter, budget core and two-slot NVS provider. Only NVS, lock,
 * trusted UTC and the already-validated control boundary are host substitutes.
 * OpenSSL performs SHA-256; fault modes never stand in for positive hashes.
 * Build this one translation unit (the real .c files are included below). */
#define ESP_ERR_INVALID_RESPONSE 0x108
#include "board_budget.h"
#include "nvs.h"
#include <assert.h>
#include <openssl/sha.h>
#include <stdio.h>
#include <string.h>

typedef struct { bool present;size_t n;uint8_t bytes[96]; } blob_t;
typedef struct { bool exists;blob_t slots[2],pending[2];bool dirty[2]; } namespace_t;
static namespace_t namespaces[2];
static bool held,initialized=true,known=true,zero_hash,colliding_hash;
static uint64_t utc_lo,utc_hi;
static unsigned hash_calls,hash_fail_at,set_calls,commit_calls,open_calls;
static int open_fail=-1,read_fail=-1,commit_fail=-1,commit_lost=-1,torn_commit=-1;
static size_t available=1000;
static te_board_budget_t budget,rebooted;
static cp_v3_control_t policy;
static int domain_of(const char *name) {
    if(!strcmp(name,TE_BUDGET_STORAGE_NAMESPACE))return 0;
    if(!strcmp(name,TE_BUDGET_UPLINK_NAMESPACE))return 1;
    assert(!"unexpected namespace");return -1;
}
static int slot_of(const char *key) { assert(!strcmp(key,"a")||!strcmp(key,"b"));return key[0]=='a'?0:1; }
esp_err_t nvs_open(const char *name,int mode,nvs_handle_t *out) {
    assert(held);++open_calls;int i=domain_of(name);
    if(!initialized||open_fail==i)return ESP_FAIL;
    if(!namespaces[i].exists&&mode==NVS_READONLY)return ESP_ERR_NVS_NOT_FOUND;
    if(mode==NVS_READWRITE)namespaces[i].exists=true;
    *out=i+1;return ESP_OK;
}
esp_err_t nvs_get_blob(nvs_handle_t h,const char *key,void *out,size_t *n) {
    assert(held&&h>=1&&h<=2);int i=h-1;if(read_fail==i)return ESP_FAIL;
    blob_t *b=&namespaces[i].slots[slot_of(key)];if(!b->present)return ESP_ERR_NVS_NOT_FOUND;
    if(!out){*n=b->n;return ESP_OK;}if(*n<b->n)return ESP_FAIL;
    memcpy(out,b->bytes,b->n);*n=b->n;return ESP_OK;
}
esp_err_t nvs_set_blob(nvs_handle_t h,const char *key,const void *p,size_t n) {
    assert(held&&h>=1&&h<=2&&n==96);++set_calls;int slot=slot_of(key);namespace_t *ns=&namespaces[h-1];
    ns->pending[slot]=(blob_t){.present=true,.n=n};memcpy(ns->pending[slot].bytes,p,n);ns->dirty[slot]=true;return ESP_OK;
}
esp_err_t nvs_commit(nvs_handle_t h) {
    assert(held&&h>=1&&h<=2);++commit_calls;int i=h-1;namespace_t *ns=&namespaces[i];
    if(commit_fail==i)return ESP_FAIL;
    for(unsigned j=0;j<2;++j)if(ns->dirty[j]){ns->slots[j]=ns->pending[j];if(torn_commit==i)ns->slots[j].n=48;ns->dirty[j]=false;}
    return commit_lost==i||torn_commit==i?ESP_FAIL:ESP_OK;
}
void nvs_close(nvs_handle_t h) {
    assert(held&&h>=1&&h<=2);memset(namespaces[h-1].dirty,0,sizeof namespaces[h-1].dirty);
}
esp_err_t nvs_get_stats(const char *partition,nvs_stats_t *out) {
    assert(held&&!partition);*out=(nvs_stats_t){.available_entries=available,.free_entries=available};return ESP_OK;
}
static bool lock_try(void *ctx) { (void)ctx;if(held)return false;held=true;return true; }
static void lock_release(void *ctx) { (void)ctx;assert(held);held=false; }
static bool clock_now(void *ctx,uint64_t *lo,uint64_t *hi) { (void)ctx;assert(held);*lo=utc_lo;*hi=utc_hi;return known; }
static bool sha(void *ctx,const void *p,size_t n,uint8_t out[32]) {
    (void)ctx;assert(held);++hash_calls;if(hash_calls==hash_fail_at)return false;
    if(zero_hash||colliding_hash){memset(out,colliding_hash?7:0,32);return true;}
    return SHA256(p,n,out)!=NULL;
}
static te_board_budget_config_t config(void) {
    return (te_board_budget_config_t){.sha256=sha,.try_lock=lock_try,.unlock=lock_release,.trusted_utc=clock_now};
}
static te_board_budget_local_test_t authorization(void) {
    te_board_budget_local_test_t a={.authorization=TE_BUDGET_EXPLICIT_LOCAL_TEST,.storage_limit=500000,.uplink_limit=100000,
        .storage_quantum=8192,.uplink_quantum=8192};strcpy(a.node_id,"synthetic-budget-node");return a;
}
static void reset(void) {
    memset(namespaces,0,sizeof namespaces);memset(&budget,0,sizeof budget);memset(&rebooted,0,sizeof rebooted);memset(&policy,0,sizeof policy);
    held=false;initialized=known=true;zero_hash=colliding_hash=false;utc_lo=1793318400010ULL;utc_hi=utc_lo+20;
    hash_calls=hash_fail_at=set_calls=commit_calls=open_calls=0;available=1000;
    open_fail=read_fail=commit_fail=commit_lost=torn_commit=-1;
}
static void open_and_accept(te_board_budget_t *b) {
    te_board_budget_config_t cfg=config();assert(te_board_budget_open(b,"synthetic-budget-node",&cfg)==TE_BOARD_BUDGET_OK);
    te_board_budget_local_test_t a=authorization();assert(te_board_budget_accept_local_test(b,&a)==TE_BOARD_BUDGET_OK);
}
static void make_policy(uint64_t generation,uint64_t storage,uint64_t uplink) {
    memset(&policy,0,sizeof policy);policy.small_statistics=policy.policy.statistics=true;
    policy.state=CP_V3_CONTROL_OFFERED;policy.policy_length=1;strcpy(policy.policy.scope.node_id,"synthetic-budget-node");
    memset(policy.policy.scope.policy_sha256,'a',64);policy.policy.scope.assignment_generation=generation;
    policy.policy.storage_write_bytes_per_day=storage;policy.policy.max_upload_bytes_per_day=uplink;
}
int main(void) {
    reset();te_board_budget_config_t cfg=config();
    assert(te_board_budget_open(&budget,"synthetic-budget-node",&cfg)==TE_BOARD_BUDGET_OK);
    assert(!budget.storage.configured&&!budget.uplink.configured&&!set_calls&&!commit_calls);
    assert(te_board_budget_charge(&budget,TE_BUDGET_UPLINK,1)==TE_BOARD_BUDGET_STATE);
    te_board_budget_local_test_t a=authorization();a.authorization=0;
    assert(te_board_budget_accept_local_test(&budget,&a)==TE_BOARD_BUDGET_AUTHORIZATION);
    a=authorization();assert(te_board_budget_accept_local_test(&budget,&a)==TE_BOARD_BUDGET_OK);
    assert(memcmp(budget.storage.record.owner_key,budget.uplink.record.owner_key,32));
    assert(te_board_budget_open(&budget,"synthetic-budget-node",&cfg)==TE_BOARD_BUDGET_STATE);
    assert(te_board_budget_accept_local_test(&budget,&a)==TE_BOARD_BUDGET_AUTHORIZATION);
    assert(te_board_budget_charge(&budget,TE_BUDGET_STORAGE,100)==TE_BOARD_BUDGET_OK);
    assert(budget.storage.record.reserved_bytes==12288&&budget.storage.credit_bytes==8092);
    assert(te_board_budget_charge(&budget,TE_BUDGET_UPLINK,100)==TE_BOARD_BUDGET_OK);
    assert(budget.uplink.record.reserved_bytes==12288&&budget.storage.authorized_io_bytes==4196&&commit_calls==2);
    open_and_accept(&rebooted);assert(rebooted.storage.credit_bytes==0&&rebooted.uplink.credit_bytes==0);
    assert(rebooted.storage.carry_in_reserved_bytes==12288&&rebooted.uplink.carry_in_reserved_bytes==12288);
    assert(te_board_budget_charge(&rebooted,TE_BUDGET_STORAGE,100)==TE_BOARD_BUDGET_OK);
    assert(te_board_budget_charge(&rebooted,TE_BUDGET_UPLINK,100)==TE_BOARD_BUDGET_OK);
    assert(rebooted.storage.record.reserved_bytes==24576&&rebooted.uplink.record.reserved_bytes==24576);
    /* Independent limits, tightening and no local-test/policy reinit reset. */
    make_policy(1,30000,24000);assert(te_board_budget_bind_policy(&rebooted,&policy)==TE_BOARD_BUDGET_OK);
    assert(te_board_budget_charge(&rebooted,TE_BUDGET_UPLINK,1)==TE_BOARD_BUDGET_LIMIT);
    make_policy(2,900000,900000);assert(te_board_budget_bind_policy(&rebooted,&policy)==TE_BOARD_BUDGET_OK);
    assert(rebooted.storage.limit_bytes==30000&&rebooted.uplink.limit_bytes==24000);
    assert(te_board_budget_accept_local_test(&rebooted,&a)==TE_BOARD_BUDGET_AUTHORIZATION);
    make_policy(1,1,1);assert(te_board_budget_bind_policy(&rebooted,&policy)==TE_BOARD_BUDGET_AUTHORIZATION);
    /* SHA failure/zero/collision and partial open are latched without writes. */
    for(unsigned fail=1;fail<=2;++fail){reset();hash_fail_at=fail;assert(te_board_budget_open(&budget,"synthetic-budget-node",&cfg)==TE_BOARD_BUDGET_HASH);
        assert(budget.state==TE_BUDGET_FAILED&&!open_calls&&!set_calls);hash_fail_at=0;assert(te_board_budget_open(&budget,"synthetic-budget-node",&cfg)==TE_BOARD_BUDGET_STATE);}
    reset();zero_hash=true;assert(te_board_budget_open(&budget,"synthetic-budget-node",&cfg)==TE_BOARD_BUDGET_HASH);
    reset();colliding_hash=true;assert(te_board_budget_open(&budget,"synthetic-budget-node",&cfg)==TE_BOARD_BUDGET_HASH);
    reset();open_fail=1;assert(te_board_budget_open(&budget,"synthetic-budget-node",&cfg)==TE_BOARD_BUDGET_NVS);
    assert(budget.storage.opened&&!budget.storage.configured&&!set_calls&&budget.state==TE_BUDGET_FAILED);
    reset();initialized=false;assert(te_board_budget_open(&budget,"synthetic-budget-node",&cfg)==TE_BOARD_BUDGET_NVS);assert(!initialized&&!set_calls);
    /* Node/domain owner conflict cannot pick a fresh namespace or start at zero. */
    reset();open_and_accept(&budget);assert(te_board_budget_charge(&budget,TE_BUDGET_STORAGE,100)==TE_BOARD_BUDGET_OK);
    unsigned writes=set_calls;assert(te_board_budget_open(&rebooted,"other-node",&cfg)==TE_BOARD_BUDGET_OWNER_MISMATCH);assert(set_calls==writes);
    /* Lock contention does not mutate state; returned lock serializes raw-core users. */
    reset();held=true;assert(te_board_budget_open(&budget,"synthetic-budget-node",&cfg)==TE_BOARD_BUDGET_BUSY);assert(budget.state==TE_BUDGET_NEW);
    held=false;open_and_accept(&budget);held=true;assert(te_board_budget_charge(&budget,TE_BUDGET_STORAGE,1)==TE_BOARD_BUDGET_BUSY);assert(!set_calls);held=false;
    assert(te_board_budget_try_lock(&budget));assert(!te_board_budget_try_lock(&budget));
    assert(cp_v3_budget_charge(&budget.uplink,100,utc_lo,utc_hi)==CP_V3_BUDGET_OK);te_board_budget_unlock(&budget);assert(!held&&budget.storage.authorized_io_bytes==4096);
    /* Unknown time, uncertainty crossing midnight and rollback never refill. */
    reset();open_and_accept(&budget);known=false;assert(te_board_budget_charge(&budget,TE_BUDGET_STORAGE,1)==TE_BOARD_BUDGET_CLOCK_UNKNOWN);known=true;
    utc_lo=1793404799999ULL;utc_hi=utc_lo+2;assert(te_board_budget_charge(&budget,TE_BUDGET_STORAGE,1)==TE_BOARD_BUDGET_DAY_AMBIGUOUS);assert(!set_calls);
    utc_lo=1793318400010ULL;utc_hi=utc_lo+20;assert(te_board_budget_charge(&budget,TE_BUDGET_STORAGE,1)==TE_BOARD_BUDGET_OK);
    uint64_t reserved=budget.storage.record.reserved_bytes;--utc_lo;--utc_hi;
    assert(te_board_budget_charge(&budget,TE_BUDGET_STORAGE,1)==TE_BOARD_BUDGET_TIME_REGRESSION);assert(budget.storage.record.reserved_bytes==reserved);
    utc_lo+=86400001;utc_hi+=86400001;assert(te_board_budget_charge(&budget,TE_BUDGET_STORAGE,1)==TE_BOARD_BUDGET_OK);
    open_and_accept(&rebooted);utc_lo-=86400000;utc_hi-=86400000;
    assert(te_board_budget_charge(&rebooted,TE_BUDGET_STORAGE,1)==TE_BOARD_BUDGET_DAY_REGRESSION);
    /* Commit failure does not grant IO; ambiguous successful commit burns quota. */
    reset();open_and_accept(&budget);commit_fail=0;assert(te_board_budget_charge(&budget,TE_BUDGET_STORAGE,1)==TE_BOARD_BUDGET_IO);
    assert(budget.state==TE_BUDGET_FAILED&&budget.storage.authorized_io_bytes==0);
    assert(te_board_budget_open(&budget,"synthetic-budget-node",&cfg)==TE_BOARD_BUDGET_STATE);
    reset();open_and_accept(&budget);commit_lost=1;assert(te_board_budget_charge(&budget,TE_BUDGET_UPLINK,1)==TE_BOARD_BUDGET_IO);
    assert(budget.state==TE_BUDGET_FAILED&&budget.uplink.authorized_io_bytes==0&&budget.storage.authorized_io_bytes==4096);
    commit_lost=-1;open_and_accept(&rebooted);assert(rebooted.uplink.record.reserved_bytes==12288&&rebooted.uplink.credit_bytes==0);
    reset();open_and_accept(&budget);torn_commit=1;assert(te_board_budget_charge(&budget,TE_BUDGET_UPLINK,1)==TE_BOARD_BUDGET_IO);
    torn_commit=-1;assert(te_board_budget_open(&rebooted,"synthetic-budget-node",&cfg)==TE_BOARD_BUDGET_NVS);assert(rebooted.state==TE_BUDGET_FAILED);
    /* Insufficient NVS floor fails closed; low storage cannot fund uplink journal. */
    reset();open_and_accept(&budget);available=128;assert(te_board_budget_charge(&budget,TE_BUDGET_STORAGE,1)==TE_BOARD_BUDGET_IO);assert(!set_calls);
    reset();a=authorization();a.storage_limit=4096;assert(te_board_budget_open(&budget,"synthetic-budget-node",&cfg)==TE_BOARD_BUDGET_OK);
    assert(te_board_budget_accept_local_test(&budget,&a)==TE_BOARD_BUDGET_OK);
    assert(te_board_budget_charge(&budget,TE_BUDGET_UPLINK,1)==TE_BOARD_BUDGET_IO);assert(!set_calls&&budget.state==TE_BUDGET_FAILED);
    puts("board budget: real core/NVS, two domains, SHA faults, partial open/commit, reboot burn, limits, time, owner and locks passed; no physical endurance claim");
    return 0;
}

/* Include, rather than replace, production implementations. This keeps the
 * mock ESP error constant confined to this test translation unit. */
#include "../../components/cp_v3_budget/budget.c"
#include "../../components/cp_v3_budget/budget_nvs.c"
#include "../main/board_budget.c"
