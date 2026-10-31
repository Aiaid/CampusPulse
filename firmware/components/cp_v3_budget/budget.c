#include "cp_v3_budget.h"
#include <string.h>

#define DAY_MS UINT64_C(86400000)
#define UTC_MIN UINT64_C(1704067200000)
#define UTC_MAX UINT64_C(7258118400000)
#define MAX_SEQUENCE UINT64_C(9007199254740991)
static bool owner_valid(const uint8_t key[32]) {
    if(!key)return false;
    unsigned bits=0;for(unsigned i=0;i<32;++i)bits|=key[i];return bits!=0;
}
static bool record_valid(const cp_v3_budget_record_t *r) {
    return r&&owner_valid(r->owner_key)&&r->sequence&&r->sequence<=MAX_SEQUENCE&&
        r->reserved_bytes<=CP_V3_BUDGET_MAX_BYTES&&r->utc_day>=UTC_MIN/DAY_MS&&r->utc_day<UTC_MAX/DAY_MS;
}
static void put(uint8_t *p,uint64_t v,unsigned width) { for(unsigned i=0;i<width;++i)p[i]=(uint8_t)(v>>(8*i)); }
static uint64_t get(const uint8_t *p,unsigned width) { uint64_t v=0;for(unsigned i=0;i<width;++i)v|=(uint64_t)p[i]<<(8*i);return v; }
static uint32_t crc32(const void *bytes,size_t n) {
    const uint8_t *p=bytes;uint32_t crc=UINT32_MAX;
    while(n--){crc^=*p++;for(unsigned i=0;i<8;++i)crc=(crc>>1)^((crc&1)?UINT32_C(0xedb88320):0);}
    return crc^UINT32_MAX;
}
bool cp_v3_budget_encode(const cp_v3_budget_record_t *r,uint8_t out[CP_V3_BUDGET_RECORD_BYTES]) {
    if(!out||!record_valid(r))return false;
    memset(out,0,CP_V3_BUDGET_RECORD_BYTES);memcpy(out,"CPV3BD01",8);put(out+8,1,2);put(out+10,CP_V3_BUDGET_RECORD_BYTES,2);
    put(out+16,r->sequence,8);put(out+24,r->utc_day,4);put(out+32,r->reserved_bytes,8);memcpy(out+40,r->owner_key,32);
    put(out+88,crc32(out,88),4);memcpy(out+92,"BUD!",4);return true;
}
bool cp_v3_budget_decode(const void *bytes,size_t n,cp_v3_budget_record_t *out) {
    if(out)memset(out,0,sizeof *out);
    if(!bytes||!out||n!=CP_V3_BUDGET_RECORD_BYTES)return false;
    const uint8_t *p=bytes;
    if(memcmp(p,"CPV3BD01",8)||get(p+8,2)!=1||get(p+10,2)!=n||get(p+12,4)||get(p+28,4)||
        memcmp(p+92,"BUD!",4)||get(p+88,4)!=crc32(p,88))return false;
    for(unsigned i=72;i<88;++i)if(p[i])return false;
    cp_v3_budget_record_t r={.sequence=get(p+16,8),.utc_day=(uint32_t)get(p+24,4),.reserved_bytes=get(p+32,8)};
    memcpy(r.owner_key,p+40,32);if(!record_valid(&r))return false;*out=r;return true;
}
void cp_v3_budget_clear(cp_v3_budget_t *b) {
    if(!b)return;
    volatile uint8_t *p=(volatile uint8_t *)b;for(size_t i=0;i<sizeof *b;++i)p[i]=0;
}
cp_v3_budget_result_t cp_v3_budget_open(cp_v3_budget_t *b,cp_v3_budget_store_t store,const uint8_t owner[32]) {
    if(!b)return CP_V3_BUDGET_INVALID;
    cp_v3_budget_clear(b);
    if(!store.load||!store.store||store.logical_write_bytes<CP_V3_BUDGET_RECORD_BYTES||
        store.logical_write_bytes>CP_V3_BUDGET_MAX_BYTES||!owner_valid(owner))return CP_V3_BUDGET_INVALID;
    b->store=store;memcpy(b->record.owner_key,owner,32);
    uint8_t bytes[CP_V3_BUDGET_RECORD_BYTES];size_t n=0;
    cp_v3_budget_load_t result=store.load(store.context,bytes,sizeof bytes,&n);
    if(result==CP_V3_BUDGET_LOAD_ABSENT&&n==0){b->opened=true;return CP_V3_BUDGET_OK;}
    if(result==CP_V3_BUDGET_LOAD_IO){b->latched=true;return CP_V3_BUDGET_IO;}
    cp_v3_budget_record_t r;
    if(result!=CP_V3_BUDGET_LOAD_PRESENT||!cp_v3_budget_decode(bytes,n,&r)){b->latched=true;return CP_V3_BUDGET_CORRUPT;}
    if(memcmp(r.owner_key,owner,32)){b->latched=true;return CP_V3_BUDGET_OWNER_MISMATCH;}
    b->record=r;b->have_record=true;b->opened=true;b->latest_observed_day=r.utc_day;b->have_observed_day=true;
    b->carry_in_reserved_bytes=r.reserved_bytes;return CP_V3_BUDGET_OK;
}
cp_v3_budget_result_t cp_v3_budget_configure(cp_v3_budget_t *b,uint64_t limit,uint64_t quantum) {
    if(!b)return CP_V3_BUDGET_INVALID;
    if(b->latched)return CP_V3_BUDGET_LATCHED;
    if(!b->opened)return CP_V3_BUDGET_NOT_READY;
    if(limit>CP_V3_BUDGET_MAX_BYTES||!quantum||quantum>CP_V3_BUDGET_MAX_BYTES)return CP_V3_BUDGET_INVALID;
    b->limit_bytes=limit;b->quantum_bytes=quantum;b->configured=true;return CP_V3_BUDGET_OK;
}
static cp_v3_budget_result_t reject(cp_v3_budget_t *b,cp_v3_budget_result_t result,bool clock) {
    ++b->rejections;if(clock)++b->clock_rejections;return result;
}
static cp_v3_budget_result_t day_from(uint64_t lower,uint64_t upper,uint32_t *day) {
    if(lower<UTC_MIN||upper>=UTC_MAX||lower>upper)return CP_V3_BUDGET_CLOCK_UNKNOWN;
    if(lower/DAY_MS!=upper/DAY_MS)return CP_V3_BUDGET_DAY_AMBIGUOUS;
    *day=(uint32_t)(lower/DAY_MS);return CP_V3_BUDGET_OK;
}
cp_v3_budget_result_t cp_v3_budget_charge(cp_v3_budget_t *b,uint64_t bytes,uint64_t lower,uint64_t upper) {
    if(!b)return CP_V3_BUDGET_INVALID;
    if(b->latched)return reject(b,CP_V3_BUDGET_LATCHED,false);
    if(!b->opened||!b->configured)return reject(b,CP_V3_BUDGET_NOT_READY,false);
    if(!bytes||bytes>CP_V3_BUDGET_MAX_BYTES)return reject(b,CP_V3_BUDGET_INVALID,false);
    uint32_t day;cp_v3_budget_result_t clock=day_from(lower,upper,&day);
    if(clock!=CP_V3_BUDGET_OK)return reject(b,clock,true);
    if(b->have_observed_day&&day<b->latest_observed_day)return reject(b,CP_V3_BUDGET_DAY_REGRESSION,true);
    b->latest_observed_day=day;b->have_observed_day=true;
    bool new_day=!b->have_record||day>b->record.utc_day;
    if(new_day&&b->credit_bytes){b->discarded_credit_bytes+=b->credit_bytes;b->credit_bytes=0;}
    uint64_t reserved=new_day?0:b->record.reserved_bytes;
    /* A policy reduction never reclaims already persisted reservations. */
    if(reserved>b->limit_bytes)return reject(b,CP_V3_BUDGET_LIMIT,false);
    if(bytes>b->credit_bytes){
        uint64_t need=bytes-b->credit_bytes,available=b->limit_bytes-reserved,cost=b->store.logical_write_bytes;
        if(available<cost||available-cost<need)return reject(b,CP_V3_BUDGET_LIMIT,false);
        if(b->have_record&&b->record.sequence==MAX_SEQUENCE)return reject(b,CP_V3_BUDGET_EXHAUSTED,false);
        uint64_t additional=((need+b->quantum_bytes-1)/b->quantum_bytes)*b->quantum_bytes;
        if(additional>available-cost)additional=available-cost;
        cp_v3_budget_record_t next=b->record;
        next.sequence=b->have_record?b->record.sequence+1:1;next.utc_day=day;next.reserved_bytes=reserved+cost+additional;
        uint8_t record[CP_V3_BUDGET_RECORD_BYTES],check[CP_V3_BUDGET_RECORD_BYTES];
        if(!cp_v3_budget_encode(&next,record))return reject(b,CP_V3_BUDGET_INVALID,false);
        ++b->persist_attempts;b->uncertain_reserved_bytes=next.reserved_bytes;
        if(!b->store.store(b->store.context,record,sizeof record)){b->latched=true;return reject(b,CP_V3_BUDGET_IO,false);}
        size_t n=0;cp_v3_budget_load_t loaded=b->store.load(b->store.context,check,sizeof check,&n);
        if(loaded!=CP_V3_BUDGET_LOAD_PRESENT||n!=sizeof check||memcmp(record,check,sizeof check)){
            b->latched=true;return reject(b,loaded==CP_V3_BUDGET_LOAD_IO?CP_V3_BUDGET_IO:CP_V3_BUDGET_CORRUPT,false);}
        b->record=next;b->have_record=true;b->uncertain_reserved_bytes=0;++b->persist_successes;
        b->reserved_added_bytes+=cost+additional;b->journal_logical_bytes+=cost;b->credit_bytes+=additional;
    }
    b->credit_bytes-=bytes;b->authorized_io_bytes+=bytes;return CP_V3_BUDGET_OK;
}
void cp_v3_budget_snapshot(const cp_v3_budget_t *b,cp_v3_budget_snapshot_t *out) {
    if(!out)return;
    memset(out,0,sizeof *out);if(!b)return;
    *out=(cp_v3_budget_snapshot_t){.utc_day=b->record.utc_day,.limit_bytes=b->limit_bytes,.quantum_bytes=b->quantum_bytes,
        .persisted_reserved_bytes=b->have_record?b->record.reserved_bytes:0,
        .available_credit_bytes=(!b->latched&&b->configured&&b->have_record&&b->record.reserved_bytes<=b->limit_bytes&&
            b->latest_observed_day==b->record.utc_day)?b->credit_bytes:0,
        .authorized_io_bytes_since_open=b->authorized_io_bytes,.journal_logical_bytes_since_open=b->journal_logical_bytes,
        .reserved_added_bytes_since_open=b->reserved_added_bytes,.carry_in_reserved_bytes=b->carry_in_reserved_bytes,
        .discarded_credit_bytes=b->discarded_credit_bytes,.persist_attempts=b->persist_attempts,.persist_successes=b->persist_successes,
        .rejections=b->rejections,.clock_rejections=b->clock_rejections,.uncertain_reserved_bytes=b->uncertain_reserved_bytes,
        .have_day=b->have_record,.configured=b->configured,.latched=b->latched};
}
