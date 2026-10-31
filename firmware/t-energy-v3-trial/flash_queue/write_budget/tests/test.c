#include "write_budget.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
typedef struct { uint8_t record[TE_BUDGET_RECORD_SIZE]; bool present; int failure, saves; } memory_t;
static int load(void *v,uint8_t *out) { memory_t *m=v; if(m->failure==1) return -1; if(!m->present) return 0; memcpy(out,m->record,sizeof m->record); return 1; }
static bool save(void *v,const uint8_t *b) { memory_t *m=v; m->saves++; if(m->failure==2) return false; if(m->failure==3) { memcpy(m->record,b,sizeof m->record); m->present=true; return false; } if(m->failure==4) { memcpy(m->record,b,13); m->present=true; return false; } memcpy(m->record,b,sizeof m->record); m->present=true; return true; }
int main(void) {
    memory_t m={0}; te_budget_store_t s={&m,load,save}; te_budget_t q;
    assert(te_budget_open(&q,s,3)==TE_BUDGET_ABSENT); assert(te_budget_provision(&q,s,3,false,86401)==TE_BUDGET_TIME);
    assert(te_budget_provision(&q,s,3,true,86401)==TE_BUDGET_OK); assert(te_budget_provision(&q,s,3,true,86401)==TE_BUDGET_INVALID);
    assert(te_budget_open(&q,s,3)==TE_BUDGET_OK); assert(te_budget_reserve(&q,false,86402,1)==TE_BUDGET_TIME);
    assert(te_budget_reserve(&q,true,86400,1)==TE_BUDGET_TIME); assert(te_budget_reserve(&q,true,86402,2)==TE_BUDGET_OK);
    assert(te_budget_open(&q,s,3)==TE_BUDGET_OK && q.used==2); assert(te_budget_reserve(&q,true,86403,2)==TE_BUDGET_EXHAUSTED);
    assert(te_budget_open(&q,s,3)==TE_BUDGET_OK && q.last_utc==86403); assert(te_budget_reserve(&q,true,86402,1)==TE_BUDGET_TIME);
    assert(te_budget_reserve(&q,true,172800,3)==TE_BUDGET_OK); assert(te_budget_open(&q,s,4)==TE_BUDGET_CORRUPT);
    assert(te_budget_open(&q,s,3)==TE_BUDGET_OK && q.used==3); assert(te_budget_reserve(&q,true,172801,1)==TE_BUDGET_EXHAUSTED);
    m.failure=2; assert(te_budget_reserve(&q,true,259200,1)==TE_BUDGET_IO); assert(te_budget_reserve(&q,true,259200,1)==TE_BUDGET_INVALID);
    m.failure=0; assert(te_budget_open(&q,s,3)==TE_BUDGET_OK && q.used==3 && q.last_utc==172801);
    m.failure=3; assert(te_budget_reserve(&q,true,259200,1)==TE_BUDGET_IO); m.failure=0;
    assert(te_budget_open(&q,s,3)==TE_BUDGET_OK && q.used==1 && q.last_utc==259200);
    m.failure=4; assert(te_budget_reserve(&q,true,259201,1)==TE_BUDGET_IO); m.failure=0;
    assert(te_budget_open(&q,s,3)==TE_BUDGET_CORRUPT); m.failure=1; assert(te_budget_open(&q,s,3)==TE_BUDGET_IO);
    puts("write budget tests passed");
}
