#include "write_budget.h"
#include <string.h>
#define MAGIC 0x31424754u
#define DAY 86400u
static uint32_t rd(const uint8_t *p) { return (uint32_t)p[0]|(uint32_t)p[1]<<8|(uint32_t)p[2]<<16|(uint32_t)p[3]<<24; }
static void wr(uint8_t *p,uint32_t n) { for(unsigned i=0;i<4;i++) p[i]=(uint8_t)(n>>(8*i)); }
static uint32_t crc(const uint8_t *p,size_t n) { uint32_t c=~0u; while(n--) { c^=*p++; for(unsigned i=0;i<8;i++) c=(c>>1)^(0xedb88320u & (0u-(c&1u))); } return ~c; }
static void encode(uint8_t b[TE_BUDGET_RECORD_SIZE],uint64_t utc,uint32_t used,uint32_t limit) {
    memset(b,0,TE_BUDGET_RECORD_SIZE); wr(b,MAGIC); wr(b+4,1); wr(b+8,(uint32_t)utc); wr(b+12,(uint32_t)(utc>>32));
    wr(b+16,used); wr(b+20,limit); wr(b+24,~MAGIC); wr(b+28,crc(b,28));
}
static bool valid_store(te_budget_store_t s) { return s.load && s.save; }
static te_budget_result_t save(te_budget_t *q,uint64_t utc,uint32_t used) {
    uint8_t record[TE_BUDGET_RECORD_SIZE]; encode(record,utc,used,q->limit);
    if(!q->store.save(q->store.context,record)) { q->blocked=true; return TE_BUDGET_IO; }
    q->last_utc=utc; q->used=used; return TE_BUDGET_OK;
}
te_budget_result_t te_budget_provision(te_budget_t *q,te_budget_store_t s,uint32_t limit,bool known,uint64_t utc) {
    if(!q || !valid_store(s) || !limit) return TE_BUDGET_INVALID;
    if(!known || !utc) return TE_BUDGET_TIME;
    memset(q,0,sizeof *q); q->store=s; q->limit=limit;
    uint8_t old[TE_BUDGET_RECORD_SIZE]; int r=s.load(s.context,old);
    if(r<0) { q->blocked=true; return TE_BUDGET_IO; }
    if(r!=0) { q->blocked=true; return TE_BUDGET_INVALID; }
    te_budget_result_t result=save(q,utc,0); if(result==TE_BUDGET_OK) q->ready=true; return result;
}
te_budget_result_t te_budget_open(te_budget_t *q,te_budget_store_t s,uint32_t limit) {
    if(!q || !valid_store(s) || !limit) return TE_BUDGET_INVALID;
    memset(q,0,sizeof *q); q->store=s; q->limit=limit;
    uint8_t b[TE_BUDGET_RECORD_SIZE]; int r=s.load(s.context,b);
    if(r<0) { q->blocked=true; return TE_BUDGET_IO; }
    if(!r) { q->blocked=true; return TE_BUDGET_ABSENT; }
    if(r!=1 || rd(b)!=MAGIC || rd(b+4)!=1 || rd(b+24)!=~MAGIC || rd(b+28)!=crc(b,28) ||
       rd(b+20)!=limit || rd(b+16)>limit) { q->blocked=true; return TE_BUDGET_CORRUPT; }
    q->last_utc=(uint64_t)rd(b+8)|((uint64_t)rd(b+12)<<32); q->used=rd(b+16);
    if(!q->last_utc) { q->blocked=true; return TE_BUDGET_CORRUPT; }
    q->ready=true; return TE_BUDGET_OK;
}
te_budget_result_t te_budget_reserve(te_budget_t *q,bool known,uint64_t utc,uint32_t units) {
    if(!q || !q->ready || q->blocked || !units || units>q->limit) return TE_BUDGET_INVALID;
    if(!known || !utc || utc<q->last_utc) return TE_BUDGET_TIME;
    uint32_t used=(utc/DAY>q->last_utc/DAY)?0:q->used;
    if(units>q->limit-used) {
        if (utc>q->last_utc) { te_budget_result_t r=save(q,utc,used); if(r!=TE_BUDGET_OK) return r; }
        return TE_BUDGET_EXHAUSTED;
    }
    return save(q,utc,used+units);
}
