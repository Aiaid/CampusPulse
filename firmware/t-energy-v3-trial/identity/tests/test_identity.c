/* Synthetic durability model only. Crypto and shared budget are real; backend
 * RAM images survive modeled resets, not power loss on an ESP32/NVS device. */
#include "identity.h"
#include <assert.h>
#include <openssl/evp.h>
#include <setjmp.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <zlib.h>

#define UTC UINT64_C(1793318400000)
#define NODE "synthetic-identity-node"
typedef struct {
    uint8_t ledger[TE_IDENTITY_RECORD_BYTES],budget[CP_V3_BUDGET_RECORD_BYTES];
    size_t ledger_n,budget_n;
    bool ledger_present,budget_present;
} medium_t;
static medium_t medium;
static te_identity_t ledger;
static cp_v3_budget_t budget;
static te_identity_config_t config;
static bool locked,clock_known,space_known,entropy_known,hash_known,lock_available;
static bool budget_commit_error,budget_commit_after,load_error,readback_error;
static uint64_t lo,hi,mono,entropy_serial,charged_before_commit;
static uint32_t entries;
static unsigned commits,loads,space_reads,locks,unlocks,readback_after_commits;
static unsigned crash_at,checkpoint_count;
static jmp_buf restart;
typedef enum { WRITE_OK, WRITE_FAIL, WRITE_FAIL_AFTER, WRITE_TORN, WRITE_STALE } write_mode_t;
static write_mode_t write_mode;
static void checkpoint(void) { if(crash_at&&++checkpoint_count==crash_at) longjmp(restart,1); }
static bool sha(void *unused,const void *p,size_t n,uint8_t out[32]) {
    (void)unused;unsigned length=0;
    return hash_known&&EVP_Digest(p,n,out,&length,EVP_sha256(),NULL)==1&&length==32;
}
static bool try_lock(void *context) { assert(context==&medium);if(!lock_available) return false;assert(!locked);locked=true;locks++;return true; }
static void unlock(void *context) { assert(context==&medium&&locked);locked=false;unlocks++; }
static bool clock_read(void *unused,uint64_t *lower,uint64_t *upper,uint64_t *uptime) {
    (void)unused;assert(locked);*lower=lo;*upper=hi;*uptime=mono;return clock_known;
}
static bool entropy(void *unused,uint8_t out[16]) {
    (void)unused;if(!entropy_known) return false;
    /* Deterministic test entropy. Never a production entropy implementation. */
    uint8_t digest[32];uint64_t serial=++entropy_serial;
    assert(sha(NULL,&serial,sizeof serial,digest));memcpy(out,digest,16);return true;
}
static cp_v3_budget_load_t budget_load(void *context,void *out,size_t cap,size_t *n) {
    assert(context==&medium&&locked);checkpoint();*n=0;
    if(!medium.budget_present) return CP_V3_BUDGET_LOAD_ABSENT;
    assert(cap>=medium.budget_n);memcpy(out,medium.budget,medium.budget_n);*n=medium.budget_n;checkpoint();return CP_V3_BUDGET_LOAD_PRESENT;
}
static bool budget_store(void *context,const void *record,size_t n) {
    assert(context==&medium&&locked&&n==sizeof medium.budget);checkpoint();
    if(budget_commit_error) return false;
    memcpy(medium.budget,record,n);medium.budget_n=n;medium.budget_present=true;checkpoint();
    return !budget_commit_after;
}
static te_identity_load_t load(void *context,void *out,size_t cap,size_t *n) {
    assert(context==&medium&&locked);loads++;checkpoint();*n=0;
    if(load_error||(readback_error&&commits>=readback_after_commits)) return TE_IDENTITY_LOAD_IO;
    if(!medium.ledger_present) return TE_IDENTITY_ABSENT;
    assert(cap>=medium.ledger_n);memcpy(out,medium.ledger,medium.ledger_n);*n=medium.ledger_n;checkpoint();return TE_IDENTITY_PRESENT;
}
static bool commit(void *context,const void *record,size_t n) {
    assert(context==&medium&&locked&&n==sizeof medium.ledger);
    /* The real budget must have granted this write first, under this lock. */
    assert(budget.authorized_io_bytes>=charged_before_commit+TE_IDENTITY_WRITE_ALLOWANCE);
    charged_before_commit=budget.authorized_io_bytes;commits++;checkpoint();
    if(write_mode==WRITE_FAIL) return false;
    if(write_mode!=WRITE_STALE) {
        size_t copy=write_mode==WRITE_TORN?n/2:n;
        memset(medium.ledger,0,n);memcpy(medium.ledger,record,copy);medium.ledger_n=n;medium.ledger_present=true;
    }
    checkpoint();return write_mode!=WRITE_FAIL_AFTER&&write_mode!=WRITE_TORN;
}
static bool available(void *context,uint32_t *out) {
    assert(context==&medium&&locked);space_reads++;checkpoint();*out=entries;return space_known;
}
static void owner_hash(const char *node,uint8_t out[32]) {
    static const char prefix[]="campuspulse/3\0t-energy-budget/1\0storage\0";
    uint8_t input[sizeof prefix+64];size_t n=sizeof prefix-1;
    memcpy(input,prefix,n);memcpy(input+n,node,strlen(node));n+=strlen(node);assert(sha(NULL,input,n,out));
}
static void reopen_budget(const char *node,bool configured) {
    uint8_t owner[32];owner_hash(node,owner);
    assert(try_lock(&medium));
    assert(cp_v3_budget_open(&budget,(cp_v3_budget_store_t){&medium,budget_load,budget_store,4096},owner)==CP_V3_BUDGET_OK);
    if(configured) assert(cp_v3_budget_configure(&budget,UINT64_C(100000000),TE_IDENTITY_WRITE_ALLOWANCE)==CP_V3_BUDGET_OK);
    unlock(&medium);charged_before_commit=0;
}
static void fresh(void) {
    memset(&medium,0,sizeof medium);memset(&ledger,0,sizeof ledger);memset(&budget,0,sizeof budget);
    locked=false;clock_known=space_known=entropy_known=hash_known=lock_available=true;
    budget_commit_error=budget_commit_after=load_error=readback_error=false;
    lo=UTC;hi=UTC+1;mono=100;entries=1000;entropy_serial=100;
    commits=loads=space_reads=locks=unlocks=crash_at=checkpoint_count=0;readback_after_commits=1;write_mode=WRITE_OK;
    config=(te_identity_config_t){.backend={&medium,load,commit,available},.storage_budget=&budget,
        .try_lock=try_lock,.unlock=unlock,.lock_context=&medium,.sha256=sha,
        .clock=clock_read,.entropy=entropy};
    reopen_budget(NODE,true);
}
static void modeled_reboot(void) {
    /* Discard all software-owned ledger/budget/lock/credit state; retain only
     * the backend's committed images and physical test clock/RNG source. */
    memset(&ledger,0,sizeof ledger);memset(&budget,0,sizeof budget);locked=false;locks=unlocks=0;
    crash_at=0;checkpoint_count=0;load_error=readback_error=false;
    budget_commit_error=budget_commit_after=false;write_mode=WRITE_OK;
    mono=0;lo+=1000;hi=lo+1;reopen_budget(NODE,true);
}
static void start(char boot[37]) {
    assert(te_identity_open(&ledger,NODE,&config)==TE_IDENTITY_OK);
    assert(!medium.ledger_present||ledger.have_record);
    assert(te_identity_begin_boot(&ledger,boot)==TE_IDENTITY_OK);assert(strlen(boot)==36);
    assert(!locked&&locks==unlocks);
}
static void uuid(unsigned n,char out[37]) { assert(snprintf(out,37,"10000000-0000-4000-8000-%012x",n)==36); }
static void successful_and_restart(void) {
    fresh();char boot[37],id[37],second[37];
    assert(te_identity_open(&ledger,NODE,&config)==TE_IDENTITY_OK);assert(!commits&&!medium.ledger_present);
    assert(te_identity_begin_boot(&ledger,boot)==TE_IDENTITY_OK);
    assert(budget.authorized_io_bytes==TE_IDENTITY_WRITE_ALLOWANCE);
    uuid(1,id);assert(te_identity_reserve_callback(&ledger,NODE,boot,id,1));
    uuid(2,second);assert(te_identity_reserve(&ledger,NODE,boot,second,19)==TE_IDENTITY_OK);
    assert(budget.authorized_io_bytes==3*TE_IDENTITY_WRITE_ALLOWANCE);
    assert(commits==3&&space_reads==7&&!locked);
    uint8_t previous[TE_IDENTITY_RECORD_BYTES];memcpy(previous,medium.ledger,sizeof previous);
    modeled_reboot();char new_boot[37];start(new_boot);assert(strcmp(boot,new_boot));
    assert(!memcmp(medium.ledger+128,previous+128,16));
    assert(!memcmp(medium.ledger+128+16*128,previous+128+16*128,2*24));
    assert(te_identity_reserve(&ledger,NODE,new_boot,id,1)==TE_IDENTITY_REUSED);
    assert(te_identity_reserve(&ledger,NODE,new_boot,second,2)==TE_IDENTITY_LATCHED);
}
static void sequences_and_owners(void) {
    const uint32_t bad[]={0,1,7};
    for(unsigned i=0;i<sizeof bad/sizeof bad[0];i++) {
        fresh();char boot[37],id[37];start(boot);uuid(1,id);
        assert(te_identity_reserve(&ledger,NODE,boot,id,7)==TE_IDENTITY_OK);
        uuid(2,id);unsigned before=commits;
        assert(te_identity_reserve(&ledger,NODE,boot,id,bad[i])==TE_IDENTITY_SEQUENCE);assert(commits==before);
    }
    fresh();char boot[37],id[37];start(boot);uuid(1,id);
    assert(te_identity_reserve(&ledger,"other-node",boot,id,1)==TE_IDENTITY_OWNER);
    fresh();start(boot);assert(te_identity_reserve(&ledger,NODE,boot,boot,1)==TE_IDENTITY_REUSED);
    fresh();start(boot);assert(te_identity_reserve(&ledger,NODE,"10000000-0000-4000-8000-000000000077",id,1)==TE_IDENTITY_OWNER);
    fresh();start(boot);assert(te_identity_reserve(&ledger,NODE,boot,id,UINT32_MAX)==TE_IDENTITY_OK);
    uuid(2,id);assert(te_identity_reserve(&ledger,NODE,boot,id,1)==TE_IDENTITY_SEQUENCE);
    fresh();start(boot);modeled_reboot();
    assert(te_identity_open(&ledger,"other-node",&config)==TE_IDENTITY_OWNER);
    fresh();start(boot);memset(&ledger,0,sizeof ledger);memset(&budget,0,sizeof budget);
    memset(medium.budget,0,sizeof medium.budget);medium.budget_present=false;reopen_budget("other-node",true);
    assert(te_identity_open(&ledger,"other-node",&config)==TE_IDENTITY_OWNER);
}
static void budgets_capacity_and_time(void) {
    fresh();budget.configured=false;assert(te_identity_open(&ledger,NODE,&config)==TE_IDENTITY_BUDGET);assert(!commits);
    fresh();space_known=false;assert(te_identity_open(&ledger,NODE,&config)==TE_IDENTITY_SPACE);
    fresh();entries=TE_IDENTITY_REQUIRED_ENTRIES-1;assert(te_identity_open(&ledger,NODE,&config)==TE_IDENTITY_SPACE);
    fresh();clock_known=false;assert(te_identity_open(&ledger,NODE,&config)==TE_IDENTITY_CLOCK);
    fresh();lo=UTC+UINT64_C(86400000)-1;hi=lo+1;assert(te_identity_open(&ledger,NODE,&config)==TE_IDENTITY_CLOCK);
    fresh();lo=hi=0;assert(te_identity_open(&ledger,NODE,&config)==TE_IDENTITY_CLOCK);
    fresh();char boot[37],id[37];start(boot);uuid(1,id);lo--;hi--;
    assert(te_identity_reserve(&ledger,NODE,boot,id,1)==TE_IDENTITY_CLOCK);
    fresh();start(boot);mono--;assert(te_identity_reserve(&ledger,NODE,boot,id,1)==TE_IDENTITY_CLOCK);
    fresh();start(boot);modeled_reboot();lo=UTC-1;hi=UTC;
    assert(te_identity_open(&ledger,NODE,&config)==TE_IDENTITY_CLOCK);
    fresh();start(boot);mono+=TE_IDENTITY_TRIAL_MS;
    assert(te_identity_reserve(&ledger,NODE,boot,id,1)==TE_IDENTITY_TRIAL_ENDED);
    fresh();start(boot);hi=lo+TE_IDENTITY_TRIAL_MS;
    assert(te_identity_reserve(&ledger,NODE,boot,id,1)==TE_IDENTITY_TRIAL_ENDED);
    fresh();start(boot);space_known=false;unsigned before=commits;
    assert(te_identity_reserve(&ledger,NODE,boot,id,1)==TE_IDENTITY_SPACE);assert(commits==before);
    fresh();assert(cp_v3_budget_configure(&budget,1,1)==CP_V3_BUDGET_OK);
    assert(te_identity_open(&ledger,NODE,&config)==TE_IDENTITY_OK);
    assert(te_identity_begin_boot(&ledger,boot)==TE_IDENTITY_BUDGET);assert(!commits&&boot[0]==0);
    fresh();budget_commit_error=true;assert(te_identity_open(&ledger,NODE,&config)==TE_IDENTITY_OK);
    assert(te_identity_begin_boot(&ledger,boot)==TE_IDENTITY_BUDGET);assert(!commits&&!boot[0]);
    fresh();budget_commit_after=true;assert(te_identity_open(&ledger,NODE,&config)==TE_IDENTITY_OK);
    assert(te_identity_begin_boot(&ledger,boot)==TE_IDENTITY_BUDGET);assert(!commits&&medium.budget_present&&!boot[0]);
    fresh();lock_available=false;assert(te_identity_open(&ledger,NODE,&config)==TE_IDENTITY_BUSY);assert(!commits);
}
static void corruption_and_uncertainty(void) {
    for(write_mode_t mode=WRITE_FAIL;mode<=WRITE_STALE;mode++) {
        fresh();char boot[37];assert(te_identity_open(&ledger,NODE,&config)==TE_IDENTITY_OK);write_mode=mode;
        assert(te_identity_begin_boot(&ledger,boot)!=TE_IDENTITY_OK);assert(!boot[0]&&ledger.state==TE_IDENTITY_FAILED);
        assert(budget.authorized_io_bytes==TE_IDENTITY_WRITE_ALLOWANCE);modeled_reboot();
        te_identity_result_t r=te_identity_open(&ledger,NODE,&config);
        if(mode==WRITE_TORN) assert(r==TE_IDENTITY_CORRUPT);
        else assert(r==TE_IDENTITY_OK);
        if(mode==WRITE_FAIL_AFTER) assert(ledger.have_record);
    }
    fresh();char boot[37],id[37];start(boot);uuid(1,id);write_mode=WRITE_FAIL_AFTER;
    assert(te_identity_reserve(&ledger,NODE,boot,id,1)==TE_IDENTITY_IO);
    modeled_reboot();start(boot);assert(te_identity_reserve(&ledger,NODE,boot,id,1)==TE_IDENTITY_REUSED);
    fresh();start(boot);readback_error=true;readback_after_commits=commits+1;
    assert(te_identity_generate(&ledger,1,id)==TE_IDENTITY_IO&&!id[0]);assert(commits==2);
    fresh();start(boot);medium.ledger[128]^=1;
    assert(te_identity_generate(&ledger,1,id)==TE_IDENTITY_CHANGED&&!id[0]);
    const size_t offsets[]={0,8,10,12,16,20,22,24,88,95,96,104,112,120,128,143,2048,2176,5247,5248,5280,5287};
    for(unsigned i=0;i<sizeof offsets/sizeof offsets[0];i++) {
        fresh();start(boot);medium.ledger[offsets[i]]^=1;modeled_reboot();
        assert(te_identity_open(&ledger,NODE,&config)==TE_IDENTITY_CORRUPT);
    }
    const size_t lengths[]={0,1,127,128,2048,TE_IDENTITY_RECORD_BYTES-1};
    for(unsigned i=0;i<sizeof lengths/sizeof lengths[0];i++) {
        fresh();start(boot);medium.ledger_n=lengths[i];modeled_reboot();
        assert(te_identity_open(&ledger,NODE,&config)==TE_IDENTITY_CORRUPT);
    }
    fresh();start(boot);load_error=true;assert(te_identity_generate(&ledger,1,id)==TE_IDENTITY_IO&&!id[0]);
    fresh();start(boot);hash_known=false;uuid(1,id);
    assert(te_identity_reserve(&ledger,NODE,boot,id,1)==TE_IDENTITY_OWNER);
    fresh();assert(te_identity_open(&ledger,NODE,&config)==TE_IDENTITY_OK);entropy_known=false;
    assert(te_identity_begin_boot(&ledger,boot)==TE_IDENTITY_ENTROPY&&!boot[0]);
}
static void checksum_and_semantics(void) {
    fresh();char boot[37],id[37];start(boot);uuid(1,id);
    assert(te_identity_reserve(&ledger,NODE,boot,id,1)==TE_IDENTITY_OK);
    const size_t hash_offset=TE_IDENTITY_RECORD_BYTES-40,crc_offset=TE_IDENTITY_RECORD_BYTES-8;
    uint8_t digest[32];assert(sha(NULL,medium.ledger,hash_offset,digest));
    assert(!memcmp(digest,medium.ledger+hash_offset,32));
    uLong checksum=crc32(0,medium.ledger,(uInt)crc_offset);
    for(unsigned i=0;i<4;i++) assert(medium.ledger[crc_offset+i]==(uint8_t)(checksum>>(8*i)));
    /* Repaired CRC cannot hide wrong SHA; actual independent zlib CRC used. */
    medium.ledger[hash_offset]^=1;checksum=crc32(0,medium.ledger,(uInt)crc_offset);
    for(unsigned i=0;i<4;i++) medium.ledger[crc_offset+i]=(uint8_t)(checksum>>(8*i));
    modeled_reboot();assert(te_identity_open(&ledger,NODE,&config)==TE_IDENTITY_CORRUPT);
    fresh();start(boot);uuid(1,id);assert(te_identity_reserve(&ledger,NODE,boot,id,1)==TE_IDENTITY_OK);
    /* Checksums are integrity checks, not authentication: structural decode
     * must independently reject even correctly hashed forbidden identities. */
    memcpy(medium.ledger+128+128*16+8,medium.ledger+128,16);
    assert(sha(NULL,medium.ledger,hash_offset,medium.ledger+hash_offset));
    checksum=crc32(0,medium.ledger,(uInt)crc_offset);
    for(unsigned i=0;i<4;i++) medium.ledger[crc_offset+i]=(uint8_t)(checksum>>(8*i));
    modeled_reboot();assert(te_identity_open(&ledger,NODE,&config)==TE_IDENTITY_CORRUPT);
}
static void bounded_capacity(void) {
    fresh();char boot[37],id[37];start(boot);
    for(unsigned i=1;i<=TE_IDENTITY_IDS_MAX;i++) {
        uuid(i,id);assert(te_identity_reserve(&ledger,NODE,boot,id,i)==TE_IDENTITY_OK);
        lo+=30000;hi=lo+1;mono+=30000;
    }
    uint8_t saved[TE_IDENTITY_RECORD_BYTES];memcpy(saved,medium.ledger,sizeof saved);uuid(129,id);
    assert(te_identity_reserve(&ledger,NODE,boot,id,129)==TE_IDENTITY_EXHAUSTED);
    assert(!memcmp(saved,medium.ledger,sizeof saved));modeled_reboot();
    assert(te_identity_open(&ledger,NODE,&config)==TE_IDENTITY_OK);
    assert(te_identity_begin_boot(&ledger,boot)==TE_IDENTITY_EXHAUSTED&&!boot[0]);
    assert(!memcmp(saved,medium.ledger,sizeof saved));
    fresh();for(unsigned i=0;i<TE_IDENTITY_BOOTS_MAX;i++) { start(boot);modeled_reboot(); }
    assert(te_identity_open(&ledger,NODE,&config)==TE_IDENTITY_OK);
    assert(te_identity_begin_boot(&ledger,boot)==TE_IDENTITY_EXHAUSTED&&!boot[0]);
}
static void crash_recovery(void) {
    /* Interrupt before/after each modelled backend operation (including the
     * budget reservation). Recreate both owners, then prove the previously
     * published batch remains burned; if the new commit landed it is burned too. */
    fresh();char boot[37],prior[37],next[37];start(boot);uuid(1,prior);uuid(2,next);
    assert(te_identity_reserve(&ledger,NODE,boot,prior,1)==TE_IDENTITY_OK);
    medium_t baseline=medium;uint64_t baseline_entropy=entropy_serial;
    unsigned exercised=0;
    for(unsigned point=1;point<32;point++) {
        medium=baseline;entropy_serial=baseline_entropy;modeled_reboot();start(boot);
        crash_at=point;checkpoint_count=0;
        if(setjmp(restart)==0) {
            te_identity_result_t r=te_identity_reserve(&ledger,NODE,boot,next,1);
            assert(r==TE_IDENTITY_OK);unsigned reached=checkpoint_count;crash_at=0;
            if(point>reached) break;
        } else exercised++;
        /* Test expects last committed byte image, never resurrected RAM credit. */
        bool next_committed=false;
        for(unsigned i=0;i<128;i++) {
            const uint8_t *item=medium.ledger+128+128*16+i*24;
            if(item[8]==0x10&&item[23]==2) next_committed=true;
        }
        modeled_reboot();assert(budget.credit_bytes==0);start(boot);
        assert(te_identity_reserve(&ledger,NODE,boot,prior,1)==TE_IDENTITY_REUSED);
        modeled_reboot();start(boot);
        te_identity_result_t r=te_identity_reserve(&ledger,NODE,boot,next,1);
        assert(r==(next_committed?TE_IDENTITY_REUSED:TE_IDENTITY_OK));
    }
    assert(exercised>=10);
    printf("modeled restart checkpoints exercised: %u\n",exercised);
}
int main(void) {
    successful_and_restart();sequences_and_owners();budgets_capacity_and_time();
    corruption_and_uncertainty();checksum_and_semantics();bounded_capacity();crash_recovery();
    puts("identity: real SHA-256/CRC32/shared budget, exact readback, owner/UUID/seq, time/capacity, bounded history and modeled restart faults passed; no physical NVS claim");
    return 0;
}
