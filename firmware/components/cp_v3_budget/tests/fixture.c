#include "cp_v3_budget.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

#define DAY UINT64_C(86400000)
#define NOW UINT64_C(1793318401000)
static const uint8_t owner[32]={1,2,3,4,5,6,7,8,9};
typedef struct {
    uint8_t bytes[96];size_t length;
    unsigned loads,stores,commits;
    bool exists,read_io,fail_before,fail_after,corrupt_write,wrong_absent;
} memory_t;
static cp_v3_budget_load_t load(void *ctx,void *out,size_t cap,size_t *n) {
    memory_t *m=ctx;++m->loads;*n=0;
    if(m->read_io)return CP_V3_BUDGET_LOAD_IO;
    if(!m->exists){if(m->wrong_absent)*n=1;return CP_V3_BUDGET_LOAD_ABSENT;}
    size_t count=m->length<cap?m->length:cap;memcpy(out,m->bytes,count);*n=m->length;return CP_V3_BUDGET_LOAD_PRESENT;
}
static bool save(void *ctx,const void *bytes,size_t n) {
    memory_t *m=ctx;++m->stores;assert(n==96);cp_v3_budget_record_t decoded;assert(cp_v3_budget_decode(bytes,n,&decoded));
    if(m->fail_before)return false;
    memcpy(m->bytes,bytes,n);m->length=n;m->exists=true;++m->commits;
    if(m->corrupt_write)m->bytes[45]^=1;
    return !m->fail_after;
}
static cp_v3_budget_store_t provider(memory_t *m) {return(cp_v3_budget_store_t){m,load,save,4096};}
static void open_configure(cp_v3_budget_t *b,memory_t *m,uint64_t limit) {
    assert(cp_v3_budget_open(b,provider(m),owner)==CP_V3_BUDGET_OK);
    assert(cp_v3_budget_configure(b,limit,65536)==CP_V3_BUDGET_OK);
}
static cp_v3_budget_result_t charge(cp_v3_budget_t *b,uint64_t bytes) {return cp_v3_budget_charge(b,bytes,NOW-10,NOW+10);}
static cp_v3_budget_snapshot_t snapshot(cp_v3_budget_t *b) {cp_v3_budget_snapshot_t s;cp_v3_budget_snapshot(b,&s);return s;}
static void codec(void) {
    cp_v3_budget_record_t r={.sequence=0x102030405ULL,.reserved_bytes=0x405060708ULL,.utc_day=(uint32_t)(NOW/DAY)};
    memcpy(r.owner_key,owner,32);uint8_t bytes[96],copy[96];assert(cp_v3_budget_encode(&r,bytes));
    assert(!memcmp(bytes,"CPV3BD01",8)&&bytes[16]==5&&bytes[17]==4&&bytes[18]==3&&bytes[19]==2&&bytes[20]==1);
    assert(bytes[32]==8&&bytes[33]==7&&bytes[34]==6&&bytes[35]==5&&bytes[36]==4);
    cp_v3_budget_record_t actual;assert(cp_v3_budget_decode(bytes,sizeof bytes,&actual));
    assert(actual.sequence==r.sequence&&actual.reserved_bytes==r.reserved_bytes&&actual.utc_day==r.utc_day&&!memcmp(actual.owner_key,owner,32));
    for(unsigned i=0;i<96;++i){memcpy(copy,bytes,96);copy[i]^=1;assert(!cp_v3_budget_decode(copy,96,&actual));}
    assert(!cp_v3_budget_decode(bytes,95,&actual)&&!cp_v3_budget_decode(bytes,97,&actual));
    r.sequence=0;assert(!cp_v3_budget_encode(&r,bytes));r.sequence=1;r.utc_day=0;assert(!cp_v3_budget_encode(&r,bytes));
    r.utc_day=(uint32_t)(NOW/DAY);r.reserved_bytes=CP_V3_BUDGET_MAX_BYTES+1;assert(!cp_v3_budget_encode(&r,bytes));
}
static void quantum_and_reboots(void) {
    memory_t m={0};cp_v3_budget_t b;open_configure(&b,&m,200000);assert(!m.stores);
    for(unsigned i=0;i<200;++i)assert(charge(&b,1)==CP_V3_BUDGET_OK);
    cp_v3_budget_snapshot_t s=snapshot(&b);assert(m.stores==1&&s.persisted_reserved_bytes==69632&&s.available_credit_bytes==65336);
    assert(s.authorized_io_bytes_since_open==200&&s.journal_logical_bytes_since_open==4096&&s.persist_successes==1);
    open_configure(&b,&m,200000);s=snapshot(&b);assert(s.available_credit_bytes==0&&s.carry_in_reserved_bytes==69632);
    assert(charge(&b,1)==CP_V3_BUDGET_OK);assert(snapshot(&b).persisted_reserved_bytes==139264);
    open_configure(&b,&m,200000);assert(charge(&b,1)==CP_V3_BUDGET_OK);s=snapshot(&b);
    assert(s.persisted_reserved_bytes==200000&&s.available_credit_bytes==56639);
    open_configure(&b,&m,200000);assert(charge(&b,1)==CP_V3_BUDGET_LIMIT&&m.stores==3);
    assert(snapshot(&b).authorized_io_bytes_since_open==0);
}
static void limits(void) {
    memory_t m={0};cp_v3_budget_t b;open_configure(&b,&m,200000);assert(charge(&b,10)==CP_V3_BUDGET_OK);
    assert(cp_v3_budget_configure(&b,1000,65536)==CP_V3_BUDGET_OK);assert(charge(&b,1)==CP_V3_BUDGET_LIMIT&&snapshot(&b).available_credit_bytes==0);
    assert(cp_v3_budget_configure(&b,69632,65536)==CP_V3_BUDGET_OK);assert(charge(&b,65526)==CP_V3_BUDGET_OK&&m.stores==1);
    assert(charge(&b,1)==CP_V3_BUDGET_LIMIT);assert(cp_v3_budget_configure(&b,200000,65536)==CP_V3_BUDGET_OK);
    assert(charge(&b,1)==CP_V3_BUDGET_OK&&m.stores==2);
    memory_t tiny={0};open_configure(&b,&tiny,5000);assert(cp_v3_budget_configure(&b,5000,CP_V3_BUDGET_MAX_BYTES)==CP_V3_BUDGET_OK);
    assert(charge(&b,1)==CP_V3_BUDGET_OK&&snapshot(&b).persisted_reserved_bytes==5000);
    assert(charge(&b,904)==CP_V3_BUDGET_LIMIT&&charge(&b,903)==CP_V3_BUDGET_OK);
    assert(cp_v3_budget_configure(&b,0,1)==CP_V3_BUDGET_OK&&charge(&b,1)==CP_V3_BUDGET_LIMIT);
    assert(cp_v3_budget_configure(&b,CP_V3_BUDGET_MAX_BYTES+1,1)==CP_V3_BUDGET_INVALID);
}
static void clock_days(void) {
    memory_t m={0};cp_v3_budget_t b;open_configure(&b,&m,200000);
    assert(cp_v3_budget_charge(&b,1,0,0)==CP_V3_BUDGET_CLOCK_UNKNOWN);
    uint64_t tomorrow=(NOW/DAY+1)*DAY;
    assert(cp_v3_budget_charge(&b,1,tomorrow-1,tomorrow)==CP_V3_BUDGET_DAY_AMBIGUOUS&&!m.stores);
    assert(charge(&b,1)==CP_V3_BUDGET_OK);
    assert(cp_v3_budget_charge(&b,1,tomorrow+100,tomorrow+200)==CP_V3_BUDGET_OK);
    cp_v3_budget_snapshot_t s=snapshot(&b);assert(s.persisted_reserved_bytes==69632&&s.discarded_credit_bytes==65535&&b.record.sequence==2);
    assert(charge(&b,1)==CP_V3_BUDGET_DAY_REGRESSION);
    assert(cp_v3_budget_charge(&b,1,tomorrow+20,tomorrow+30)==CP_V3_BUDGET_OK&&m.stores==2);
    open_configure(&b,&m,200000);assert(charge(&b,1)==CP_V3_BUDGET_DAY_REGRESSION);
    assert(cp_v3_budget_charge(&b,1,tomorrow+30,tomorrow+20)==CP_V3_BUDGET_CLOCK_UNKNOWN);
    memory_t fresh={0};open_configure(&b,&fresh,200000);assert(charge(&b,1)==CP_V3_BUDGET_OK);
    assert(cp_v3_budget_configure(&b,0,65536)==CP_V3_BUDGET_OK);
    assert(cp_v3_budget_charge(&b,1,tomorrow+10,tomorrow+20)==CP_V3_BUDGET_LIMIT);
    assert(charge(&b,1)==CP_V3_BUDGET_DAY_REGRESSION&&m.stores==2);
}
static void uncertain_commit(void) {
    for(unsigned committed=0;committed<2;++committed){memory_t m={0};cp_v3_budget_t b;open_configure(&b,&m,200000);
        m.fail_before=!committed;m.fail_after=committed;assert(charge(&b,100)==CP_V3_BUDGET_IO);
        cp_v3_budget_snapshot_t s=snapshot(&b);assert(s.latched&&s.authorized_io_bytes_since_open==0&&s.uncertain_reserved_bytes==69632);
        assert(charge(&b,1)==CP_V3_BUDGET_LATCHED&&m.stores==1&&cp_v3_budget_configure(&b,200000,1)==CP_V3_BUDGET_LATCHED);
        m.fail_before=m.fail_after=false;open_configure(&b,&m,200000);assert(snapshot(&b).available_credit_bytes==0);
        assert(charge(&b,1)==CP_V3_BUDGET_OK);assert(snapshot(&b).persisted_reserved_bytes==(committed?139264:69632));}
    memory_t m={0};cp_v3_budget_t b;open_configure(&b,&m,200000);m.corrupt_write=true;
    assert(charge(&b,1)==CP_V3_BUDGET_CORRUPT&&snapshot(&b).latched);uint8_t retained[96];memcpy(retained,m.bytes,96);
    assert(cp_v3_budget_open(&b,provider(&m),owner)==CP_V3_BUDGET_CORRUPT&&!memcmp(retained,m.bytes,96)&&m.stores==1);
}
static void corrupt_and_foreign(void) {
    memory_t m={0};cp_v3_budget_t b;m.read_io=true;
    assert(cp_v3_budget_open(&b,provider(&m),owner)==CP_V3_BUDGET_IO&&!m.stores);
    m.read_io=false;m.wrong_absent=true;assert(cp_v3_budget_open(&b,provider(&m),owner)==CP_V3_BUDGET_CORRUPT);
    m.wrong_absent=false;open_configure(&b,&m,200000);assert(charge(&b,1)==CP_V3_BUDGET_OK);
    uint8_t foreign[32]={9};assert(cp_v3_budget_open(&b,provider(&m),foreign)==CP_V3_BUDGET_OWNER_MISMATCH);
    m.length=95;assert(cp_v3_budget_open(&b,provider(&m),owner)==CP_V3_BUDGET_CORRUPT&&m.stores==1);
    m.length=96;cp_v3_budget_record_t r;assert(cp_v3_budget_decode(m.bytes,96,&r));r.sequence=UINT64_C(9007199254740991);
    assert(cp_v3_budget_encode(&r,m.bytes));open_configure(&b,&m,200000);assert(charge(&b,1)==CP_V3_BUDGET_EXHAUSTED&&m.stores==1);
    cp_v3_budget_clear(&b);for(size_t i=0;i<sizeof b;++i)assert(!((uint8_t *)&b)[i]);
}
static void randomized_reboots(void) {
    memory_t m={0};cp_v3_budget_t b;const uint64_t limit=1000000;open_configure(&b,&m,limit);
    uint64_t authorized=0;uint32_t random=12345;
    for(unsigned i=0;i<1000;++i){random=random*1664525u+1013904223u;uint64_t n=(random%20000)+1;
        if(!(i%5))open_configure(&b,&m,limit);
        m.fail_after=!(i%17);cp_v3_budget_result_t result=charge(&b,n);
        if(result==CP_V3_BUDGET_OK)authorized+=n;
        else if(result==CP_V3_BUDGET_IO){m.fail_after=false;open_configure(&b,&m,limit);}
        else assert(result==CP_V3_BUDGET_LIMIT);
        cp_v3_budget_snapshot_t s=snapshot(&b);assert(s.persisted_reserved_bytes<=limit);
        if(m.exists){cp_v3_budget_record_t r;assert(cp_v3_budget_decode(m.bytes,96,&r));
            assert(authorized+(uint64_t)m.commits*4096<=r.reserved_bytes&&r.reserved_bytes<=limit);}}
    printf("budget adversarial replay: approved=%llu committed_journal=%u reserved<=%llu\n",(unsigned long long)authorized,m.commits,(unsigned long long)limit);
}
int main(void) {
    codec();quantum_and_reboots();limits();clock_days();uncertain_commit();corrupt_and_foreign();randomized_reboots();
    puts("budget replay: codec, preauthorization, reboot burn, lower limits, UTC days and uncertain commits passed");return 0;
}
