#include "board_handoff.h"
#include <string.h>
static void wipe(void *p,size_t n) { volatile uint8_t *q=p;while(n--)*q++=0; }
static bool increment(uint64_t *v) { if(*v==UINT64_MAX)return false;++*v;return true; }
static te_handoff_step_t fault(te_handoff_t *h) {h->state=TE_HANDOFF_FAULT;return TE_STEP_FAULT;}
unsigned te_handoff_volatile_pending(const te_handoff_t *h) {return h && h->state!=TE_HANDOFF_EMPTY?1u:0u;}
te_handoff_step_t te_handoff_step(te_handoff_t *h,const te_handoff_ops_t *op) {
    if(!h || !op || !op->admit || !op->peek || !op->freeze || !op->hash || !op->store || !op->release)return TE_STEP_FAULT;
    if(h->state==TE_HANDOFF_FAULT)return TE_STEP_FAULT;
    if(h->state==TE_HANDOFF_EMPTY) {
        if(!op->admit(op->context)){if(!increment(&h->backpressure))return fault(h);return TE_STEP_BACKPRESSURE;}
        size_t length=0;te_handoff_peek_result_t r=op->peek(op->context,h->snapshot,sizeof h->snapshot,&length);
        if(r==TE_PEEK_EMPTY){if(length){h->peek_uncertain=true;return fault(h);}return TE_STEP_IDLE;}
        if(r!=TE_PEEK_ITEM || !length || length>sizeof h->snapshot){h->peek_uncertain=true;return fault(h);}
        h->snapshot_len=length;h->state=TE_HANDOFF_STAGED;
        if(!op->hash(op->context,h->snapshot,length,h->snapshot_hash))return fault(h);
        if(!increment(&h->peeked))return fault(h);
        return TE_STEP_PROGRESS;
    }
    if(h->state==TE_HANDOFF_STAGED) {
        uint8_t snapshot_hash[TE_HANDOFF_HASH_BYTES];
        if(!op->hash(op->context,h->snapshot,h->snapshot_len,snapshot_hash) ||
           memcmp(snapshot_hash,h->snapshot_hash,sizeof snapshot_hash))return fault(h);
        size_t body_len=0,identity_len=0;
        bool ok=op->freeze(op->context,h->snapshot,h->snapshot_len,h->body,sizeof h->body,&body_len,
                           h->identity,sizeof h->identity,&identity_len);
        if(!op->hash(op->context,h->snapshot,h->snapshot_len,snapshot_hash) ||
           memcmp(snapshot_hash,h->snapshot_hash,sizeof snapshot_hash))return fault(h);
        if(!ok || !body_len || body_len>sizeof h->body || !identity_len || identity_len>sizeof h->identity) {
            wipe(h->body,sizeof h->body);wipe(h->identity,sizeof h->identity);
            if(!increment(&h->freeze_failures))return fault(h);
            return TE_STEP_BACKPRESSURE;
        }
        if(!op->hash(op->context,h->body,body_len,h->body_hash) ||
           !op->hash(op->context,h->identity,identity_len,h->identity_hash))return fault(h);
        h->body_len=body_len;h->identity_len=identity_len;h->state=TE_HANDOFF_FROZEN;return TE_STEP_PROGRESS;
    }
    if(h->state==TE_HANDOFF_DURABLE) {
        uint8_t hash[TE_HANDOFF_HASH_BYTES];
        if(!op->hash(op->context,h->snapshot,h->snapshot_len,hash) || memcmp(hash,h->snapshot_hash,sizeof hash) ||
           !op->hash(op->context,h->body,h->body_len,hash) || memcmp(hash,h->body_hash,sizeof hash) ||
           !op->hash(op->context,h->identity,h->identity_len,hash) || memcmp(hash,h->identity_hash,sizeof hash))return fault(h);
        if(!op->release(op->context,h->snapshot,h->snapshot_len)) {
            if(!increment(&h->release_failures))return fault(h);
            return TE_STEP_BACKPRESSURE;
        }
        if(!increment(&h->released))return fault(h);
        wipe(h->snapshot,sizeof h->snapshot);wipe(h->body,sizeof h->body);wipe(h->identity,sizeof h->identity);
        wipe(h->snapshot_hash,sizeof h->snapshot_hash);wipe(h->body_hash,sizeof h->body_hash);wipe(h->identity_hash,sizeof h->identity_hash);
        h->snapshot_len=h->body_len=h->identity_len=0;h->state=TE_HANDOFF_EMPTY;return TE_STEP_PROGRESS;
    }
    if(h->state!=TE_HANDOFF_FROZEN)return fault(h);
    uint8_t body_hash[TE_HANDOFF_HASH_BYTES],identity_hash[TE_HANDOFF_HASH_BYTES];
    if(!op->hash(op->context,h->body,h->body_len,body_hash) || !op->hash(op->context,h->identity,h->identity_len,identity_hash) ||
       memcmp(body_hash,h->body_hash,sizeof body_hash) || memcmp(identity_hash,h->identity_hash,sizeof identity_hash))return fault(h);
    te_handoff_store_result_t result=op->store(op->context,h->body,h->body_len,h->identity,h->identity_len,h->body_hash);
    if(!op->hash(op->context,h->body,h->body_len,body_hash) || !op->hash(op->context,h->identity,h->identity_len,identity_hash) ||
       memcmp(body_hash,h->body_hash,sizeof body_hash) || memcmp(identity_hash,h->identity_hash,sizeof identity_hash))return fault(h);
    if(result==TE_STORE_FULL){if(!increment(&h->backpressure))return fault(h);return TE_STEP_BACKPRESSURE;}
    if(result!=TE_STORE_DURABLE){if(!increment(&h->store_failures))return fault(h);return TE_STEP_BACKPRESSURE;}
    if(!increment(&h->committed))return fault(h);
    h->state=TE_HANDOFF_DURABLE;return TE_STEP_PROGRESS;
}
