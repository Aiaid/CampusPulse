#include "board_handoff.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
typedef struct {bool admitted,freeze_fail,mutate;int pops,freezes,stores,releases;bool release_ok;te_handoff_peek_result_t peek_result;te_handoff_store_result_t result;uint8_t first_body[64],first_id[64];size_t first_body_n,first_id_n;} test_t;
static bool admit(void *x){return ((test_t*)x)->admitted;}
static te_handoff_peek_result_t peek(void *x,void *dst,size_t cap,size_t *n){test_t *t=x;++t->pops;if(t->peek_result!=TE_PEEK_ITEM)return t->peek_result;assert(cap>=8);memcpy(dst,"snapshot",8);*n=8;return TE_PEEK_ITEM;}
static bool freeze(void *x,const void *p,size_t n,void *body,size_t bcap,size_t *bn,void *id,size_t icap,size_t *in){test_t*t=x;++t->freezes;assert(n==8&&!memcmp(p,"snapshot",8));assert(bcap>=4&&icap>=5);memcpy(body,"BODY",4);memcpy(id,"ID123",5);*bn=4;*in=5;return !t->freeze_fail;}
/* Deterministic fake hash, test-only; not a cryptographic validation. */
static bool hash(void *x,const void *p,size_t n,uint8_t out[32]){(void)x;memset(out,0,32);const uint8_t *b=p;for(size_t i=0;i<n;i++)out[i%32]^=b[i];return true;}
static te_handoff_store_result_t store(void *x,const void *body,size_t bn,const void *id,size_t in,const uint8_t hash_value[32]) {
    test_t*t=x;++t->stores;assert(hash_value[0]=='B');
    if(t->stores==1){memcpy(t->first_body,body,bn);memcpy(t->first_id,id,in);t->first_body_n=bn;t->first_id_n=in;}
    else assert(bn==t->first_body_n&&in==t->first_id_n&&!memcmp(body,t->first_body,bn)&&!memcmp(id,t->first_id,in));
    if(t->mutate)((uint8_t*)body)[0]^=1;
    return t->result;
}
static bool release_item(void *x,const void *snapshot,size_t n) {
    test_t *t=x;++t->releases;assert(n==8&&!memcmp(snapshot,"snapshot",8));return t->release_ok;
}
int main(void) {
    te_handoff_t *h=calloc(1,sizeof *h);assert(h);test_t t={.peek_result=TE_PEEK_ITEM,.result=TE_STORE_FULL};
    te_handoff_ops_t ops={.admit=admit,.peek=peek,.freeze=freeze,.hash=hash,.store=store,.release=release_item,.context=&t};
    assert(te_handoff_step(h,&ops)==TE_STEP_BACKPRESSURE&&t.pops==0&&!te_handoff_volatile_pending(h));
    t.admitted=true;assert(te_handoff_step(h,&ops)==TE_STEP_PROGRESS&&t.pops==1&&h->state==TE_HANDOFF_STAGED);
    t.freeze_fail=true;assert(te_handoff_step(h,&ops)==TE_STEP_BACKPRESSURE&&h->state==TE_HANDOFF_STAGED&&t.pops==1);
    t.freeze_fail=false;assert(te_handoff_step(h,&ops)==TE_STEP_PROGRESS&&h->state==TE_HANDOFF_FROZEN);
    assert(te_handoff_step(h,&ops)==TE_STEP_BACKPRESSURE&&h->state==TE_HANDOFF_FROZEN);
    t.result=TE_STORE_ERROR;assert(te_handoff_step(h,&ops)==TE_STEP_BACKPRESSURE&&h->state==TE_HANDOFF_FROZEN);
    t.result=TE_STORE_DURABLE;assert(te_handoff_step(h,&ops)==TE_STEP_PROGRESS&&h->state==TE_HANDOFF_DURABLE);
    assert(te_handoff_step(h,&ops)==TE_STEP_BACKPRESSURE&&h->state==TE_HANDOFF_DURABLE&&t.pops==1&&t.stores==3);
    t.release_ok=true;assert(te_handoff_step(h,&ops)==TE_STEP_PROGRESS&&h->state==TE_HANDOFF_EMPTY);
    assert(t.releases==2 && h->released==1 && h->release_failures==1);
    assert(t.pops==1&&t.freezes==2&&t.stores==3&&h->committed==1&&!te_handoff_volatile_pending(h));
    for(size_t i=0;i<sizeof h->body;i++)assert(!h->body[i]);
    t.peek_result=TE_PEEK_ERROR;assert(te_handoff_step(h,&ops)==TE_STEP_FAULT&&h->state==TE_HANDOFF_FAULT);
    assert(h->peek_uncertain&&te_handoff_volatile_pending(h)==1&&te_handoff_step(h,&ops)==TE_STEP_FAULT);
    memset(h,0,sizeof *h);memset(&t,0,sizeof t);t.admitted=true;t.peek_result=TE_PEEK_ITEM;t.result=TE_STORE_DURABLE;t.mutate=true;
    assert(te_handoff_step(h,&ops)==TE_STEP_PROGRESS&&te_handoff_step(h,&ops)==TE_STEP_PROGRESS);
    assert(te_handoff_step(h,&ops)==TE_STEP_FAULT&&h->state==TE_HANDOFF_FAULT&&h->committed==0);
    free(h);puts("board handoff tests passed");
}
