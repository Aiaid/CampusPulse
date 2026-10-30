#include "cp_v3_queue.h"
#include <string.h>
#include <limits.h>

/* Explicit little-endian encoding; no compiler struct layout/padding on disk. */
typedef struct { uint8_t *bytes; size_t position; bool ok; } codec_t;
static void put(codec_t *c, const void *p, size_t n) {
    if (!c->ok || n > CP_V3_QUEUE_SLOT_BYTES - c->position) { c->ok=false; return; }
    memcpy(c->bytes+c->position,p,n); c->position+=n;
}
static void integer(codec_t *c, uint64_t n, unsigned width) {
    for (unsigned i=0;i<width;i++) { uint8_t v=(uint8_t)(n>>(8*i)); put(c,&v,1); }
}
static void string(codec_t *c,const char *s,size_t width) {
    size_t length=strlen(s); put(c,s,length);
    for(size_t i=length;i<width;i++) { uint8_t zero=0; put(c,&zero,1); }
}
static uint64_t number(const uint8_t *bytes, size_t *pos, unsigned width) {
    uint64_t n=0; for (unsigned i=0;i<width;i++) n|=(uint64_t)bytes[(*pos)++]<<(8*i); return n;
}
static uint32_t crc32(const void *p, size_t length) {
    const uint8_t *bytes=p; uint32_t crc=UINT32_MAX;
    while(length--) { crc^=*bytes++; for(unsigned i=0;i<8;i++) crc=(crc>>1)^((crc&1)?0xedb88320u:0); }
    return crc^UINT32_MAX;
}
static bool text(const char *s,size_t cap) { return s && memchr(s,0,cap) && s[0]; }
static bool digest(const char *s) {
    if (!s || strlen(s)!=64) return false;
    for(unsigned i=0;i<64;i++) if(!((s[i]>='0'&&s[i]<='9')||(s[i]>='a'&&s[i]<='f'))) return false;
    return true;
}
static bool uuid(const char *s) {
    if(!s||strlen(s)!=36||s[14]!='4'||!strchr("89ab",s[19])) return false;
    for(unsigned i=0;i<36;i++) {
        if(i==8||i==13||i==18||i==23) { if(s[i]!='-') return false; }
        else if(!((s[i]>='0'&&s[i]<='9')||(s[i]>='a'&&s[i]<='f'))) return false;
    } return true;
}
static bool valid(const cp_v3_expected_t *e,cp_v3_queue_kind_t kind,size_t length) {
    if(!e||(unsigned)kind>CP_V3_QUEUE_CONTROL||!length||length>CP_V3_QUEUE_BODY_MAX||e->body_bytes!=length||
       !text(e->scope.node_id,sizeof e->scope.node_id)||!text(e->scope.boot_id,sizeof e->scope.boot_id)||
       !text(e->scope.placement_id,sizeof e->scope.placement_id)||!text(e->scope.policy_id,sizeof e->scope.policy_id)||
       !text(e->scope.policy_sha256,sizeof e->scope.policy_sha256)||!text(e->scope.dataset,sizeof e->scope.dataset)||
       !text(e->batch_id,sizeof e->batch_id)||!text(e->body_sha256,sizeof e->body_sha256)||
       !text(e->stream,sizeof e->stream)||!uuid(e->scope.boot_id)||!uuid(e->batch_id)||
       !digest(e->scope.policy_sha256)||!digest(e->body_sha256)||!e->scope.assignment_generation||
       e->scope.assignment_generation>9007199254740991ULL||!e->seq_first||e->seq_last<e->seq_first||
       e->accepted_count!=1||e->seq_first!=e->seq_last) return false;
    return (kind==CP_V3_QUEUE_FEATURE&&!strcmp(e->stream,"feature_summaries")&&e->scope.window_seq)||
           (kind==CP_V3_QUEUE_STATUS&&!strcmp(e->stream,"node_status")&&e->accepted_count==1)||
           (kind==CP_V3_QUEUE_CONTROL&&!strcmp(e->stream,"control"));
}
static bool hash_matches(cp_v3_queue_t *q,const void *p,size_t n,const char *hex) {
    uint8_t hash[32]; const char chars[]="0123456789abcdef";
    if(!q->sha256(q->sha_context,p,n,hash)) return false;
    for(unsigned i=0;i<32;i++) if(hex[i*2]!=chars[hash[i]>>4]||hex[i*2+1]!=chars[hash[i]&15]) return false;
    return true;
}
static unsigned begin(cp_v3_queue_kind_t kind) { return kind==CP_V3_QUEUE_FEATURE?0:kind==CP_V3_QUEUE_STATUS?8:10; }
static unsigned end(cp_v3_queue_kind_t kind) { return kind==CP_V3_QUEUE_FEATURE?8:kind==CP_V3_QUEUE_STATUS?10:12; }
static size_t encode(cp_v3_queue_t *q,cp_v3_queue_kind_t kind,const cp_v3_expected_t *e,const void *body,size_t n) {
    codec_t c={q->scratch,0,true}; put(&c,"CPV3Q001",8); integer(&c,kind,4); integer(&c,q->next_ordinal,8);
#define FIELD(x) string(&c,e->x,sizeof e->x)
    FIELD(scope.node_id); FIELD(scope.boot_id); FIELD(scope.placement_id); FIELD(scope.policy_id);
    FIELD(scope.policy_sha256); FIELD(scope.dataset); integer(&c,e->scope.assignment_generation,8);
    integer(&c,e->scope.window_seq,4); FIELD(batch_id); FIELD(body_sha256); FIELD(stream);
#undef FIELD
    integer(&c,e->seq_first,4); integer(&c,e->seq_last,4); integer(&c,e->accepted_count,4); integer(&c,n,4);
    put(&c,body,n); uint32_t crc=crc32(c.bytes,c.position); integer(&c,crc,4); put(&c,"COMMIT3!",8);
    return c.ok?c.position:0;
}
/* Fixed header is 488 bytes, then body, CRC32 and a final commit marker. */
#define HEADER_BYTES 488u
static bool decode(cp_v3_queue_t *q,unsigned index,size_t length,cp_v3_queue_slot_t *slot,size_t *body_at) {
    const uint8_t *p=q->scratch; size_t pos=8;
    if(length<HEADER_BYTES+13||length>sizeof q->scratch||memcmp(p,"CPV3Q001",8)||memcmp(p+length-8,"COMMIT3!",8)) return false;
    uint64_t kind=number(p,&pos,4); if(kind>CP_V3_QUEUE_CONTROL||index<begin(kind)||index>=end(kind)) return false;
    slot->kind=(cp_v3_queue_kind_t)kind; slot->ordinal=number(p,&pos,8);
    cp_v3_expected_t *e=&slot->expected; memset(e,0,sizeof *e);
#define FIELD(x) do { memcpy(e->x,p+pos,sizeof e->x); pos+=sizeof e->x; } while(0)
    FIELD(scope.node_id); FIELD(scope.boot_id); FIELD(scope.placement_id); FIELD(scope.policy_id);
    FIELD(scope.policy_sha256); FIELD(scope.dataset); e->scope.assignment_generation=number(p,&pos,8);
    e->scope.window_seq=(uint32_t)number(p,&pos,4); FIELD(batch_id); FIELD(body_sha256); FIELD(stream);
#undef FIELD
    e->seq_first=(uint32_t)number(p,&pos,4); e->seq_last=(uint32_t)number(p,&pos,4);
    e->accepted_count=(uint32_t)number(p,&pos,4); e->body_bytes=(uint32_t)number(p,&pos,4);
    if(pos!=HEADER_BYTES||!slot->ordinal||slot->ordinal==UINT64_MAX||!valid(e,slot->kind,e->body_bytes)||
       length!=pos+e->body_bytes+12||!hash_matches(q,p+pos,e->body_bytes,e->body_sha256)) return false;
    *body_at=pos; pos+=e->body_bytes; size_t crc_at=pos;
    if(crc32(p,crc_at)!=(uint32_t)number(p,&pos,4)||!q->sha256(q->sha_context,p,length,slot->record_sha256)) return false;
    slot->state=CP_V3_QUEUE_PENDING; return true;
}
static bool same_record(cp_v3_queue_t *q,unsigned index,size_t *length,size_t *body_at) {
    cp_v3_queue_slot_t actual={0};
    int result=q->store.load(q->store.context,index,q->scratch,sizeof q->scratch,length);
    if(result!=1||!decode(q,index,*length,&actual,body_at)||
       memcmp(actual.record_sha256,q->slots[index].record_sha256,32)) {
        q->slots[index].state=CP_V3_QUEUE_QUARANTINED; q->corrupt_slots++; if(result<0) q->io_failures++; return false;
    } return true;
}
cp_v3_queue_result_t cp_v3_queue_open(cp_v3_queue_t *q,cp_v3_queue_store_t store,const char *node,const char *boot,
    cp_v3_sha256_fn hash,void *context) {
    if(!q||!store.load||!store.store||!store.reclaim||!hash||!text(node,65)||!text(boot,37)||!uuid(boot)) return CP_V3_QUEUE_INVALID;
    memset(q,0,sizeof *q); q->store=store; q->sha256=hash; q->sha_context=context;
    strcpy(q->node_id,node); strcpy(q->boot_id,boot); q->next_ordinal=1;
    for(unsigned i=0;i<CP_V3_QUEUE_SLOTS;i++) {
        cp_v3_queue_slot_t candidate={0};
        size_t length=0,body_at=0; int r=store.load(store.context,i,q->scratch,sizeof q->scratch,&length);
        if(!r) continue;
        if(r<0) { q->io_failures++; return CP_V3_QUEUE_IO; }
        if(r!=1||!decode(q,i,length,&candidate,&body_at)) {
            q->slots[i].state=CP_V3_QUEUE_QUARANTINED; q->corrupt_slots++; continue;
        }
        q->slots[i]=candidate;
        if(q->next_ordinal<=q->slots[i].ordinal) q->next_ordinal=q->slots[i].ordinal+1;
        if(strcmp(q->slots[i].expected.scope.node_id,node)||strcmp(q->slots[i].expected.scope.boot_id,boot)) {
            q->slots[i].state=CP_V3_QUEUE_QUARANTINED; q->retired_slots++;
        }
    }
    /* Duplicate ordinals/batch IDs are ambiguous custody, never silently FIFO. */
    for(unsigned i=0;i<CP_V3_QUEUE_SLOTS;i++) for(unsigned j=i+1;j<CP_V3_QUEUE_SLOTS;j++)
        if(q->slots[i].ordinal&&q->slots[j].ordinal&&(q->slots[i].ordinal==q->slots[j].ordinal||
           !strcmp(q->slots[i].expected.batch_id,q->slots[j].expected.batch_id))) {
            q->slots[i].state=q->slots[j].state=CP_V3_QUEUE_QUARANTINED; q->corrupt_slots++;
        }
    memset(q->scratch,0,sizeof q->scratch); q->ready=true; return CP_V3_QUEUE_OK;
}
cp_v3_queue_result_t cp_v3_queue_push(cp_v3_queue_t *q,cp_v3_queue_kind_t kind,const cp_v3_expected_t *e,
    const void *body,size_t length,unsigned *out) {
    if(!q||!q->ready||!out||!body||!valid(e,kind,length)||q->next_ordinal==UINT64_MAX) return CP_V3_QUEUE_INVALID;
    if(strcmp(e->scope.node_id,q->node_id)||strcmp(e->scope.boot_id,q->boot_id)) return CP_V3_QUEUE_RETIRED;
    if(!hash_matches(q,body,length,e->body_sha256)) return CP_V3_QUEUE_MISMATCH;
    for(unsigned i=0;i<CP_V3_QUEUE_SLOTS;i++) if(q->slots[i].state!=CP_V3_QUEUE_FREE&&
        !strcmp(q->slots[i].expected.batch_id,e->batch_id)) {
        size_t n,at;
        if(q->slots[i].state!=CP_V3_QUEUE_PENDING||!same_record(q,i,&n,&at)) return CP_V3_QUEUE_MISMATCH;
        cp_v3_queue_slot_t *s=&q->slots[i];
        if(s->kind!=kind||strcmp(s->expected.body_sha256,e->body_sha256)||s->expected.body_bytes!=length||
           memcmp(q->scratch+at,body,length)) return CP_V3_QUEUE_MISMATCH;
        /* A retry must match every encoded scope byte, not just batch/body hash. */
        uint64_t next=q->next_ordinal; q->next_ordinal=s->ordinal;
        size_t encoded=encode(q,kind,e,body,length); q->next_ordinal=next; uint8_t hash[32];
        if(!encoded||!q->sha256(q->sha_context,q->scratch,encoded,hash)||memcmp(hash,s->record_sha256,32)) return CP_V3_QUEUE_MISMATCH;
        *out=i; return CP_V3_QUEUE_OK;
    }
    unsigned index; for(index=begin(kind);index<end(kind);index++) if(q->slots[index].state==CP_V3_QUEUE_FREE) break;
    if(index==end(kind)) return CP_V3_QUEUE_FULL;
    size_t encoded=encode(q,kind,e,body,length); uint8_t frozen_hash[32];
    if(!encoded||!q->sha256(q->sha_context,q->scratch,encoded,frozen_hash)) return CP_V3_QUEUE_INVALID;
    cp_v3_queue_slot_t candidate={0}; size_t at=0;
    if(!decode(q,index,encoded,&candidate,&at)) return CP_V3_QUEUE_INVALID;
    q->slots[index]=candidate; q->slots[index].state=CP_V3_QUEUE_QUARANTINED;
    /* An uncertain store may leave a complete record. Never reuse its ordinal
     * for another slot before reopening, even when store reports failure. */
    q->next_ordinal++;
    if(!q->store.store(q->store.context,index,q->scratch,encoded)) {
        q->slots[index].state=CP_V3_QUEUE_QUARANTINED; q->io_failures++; return CP_V3_QUEUE_IO;
    }
    size_t got=0; int loaded=q->store.load(q->store.context,index,q->scratch,sizeof q->scratch,&got);
    if(loaded!=1||!decode(q,index,got,&candidate,&at)||memcmp(frozen_hash,candidate.record_sha256,32)) {
        q->slots[index].state=CP_V3_QUEUE_QUARANTINED; q->io_failures++; return CP_V3_QUEUE_IO;
    }
    q->slots[index]=candidate;
    *out=index; return CP_V3_QUEUE_OK;
}
cp_v3_queue_result_t cp_v3_queue_oldest(const cp_v3_queue_t *q,cp_v3_queue_kind_t kind,unsigned *out) {
    if(!q||!q->ready||!out||(unsigned)kind>CP_V3_QUEUE_CONTROL) return CP_V3_QUEUE_INVALID;
    unsigned best=CP_V3_QUEUE_SLOTS; for(unsigned i=begin(kind);i<end(kind);i++)
        if(q->slots[i].state==CP_V3_QUEUE_PENDING&&(best==CP_V3_QUEUE_SLOTS||q->slots[i].ordinal<q->slots[best].ordinal)) best=i;
    if(best==CP_V3_QUEUE_SLOTS) return CP_V3_QUEUE_NOT_FOUND;
    *out=best; return CP_V3_QUEUE_OK;
}
cp_v3_queue_result_t cp_v3_queue_read(cp_v3_queue_t *q,unsigned index,void *body,size_t cap,size_t *length,cp_v3_expected_t *expected) {
    if(length) *length=0;
    if(!q||!q->ready||index>=CP_V3_QUEUE_SLOTS||!body||!length||!expected) return CP_V3_QUEUE_INVALID;
    if(q->slots[index].state!=CP_V3_QUEUE_PENDING) return CP_V3_QUEUE_NOT_FOUND;
    if(cap<q->slots[index].expected.body_bytes) return CP_V3_QUEUE_INVALID;
    size_t n,at; if(!same_record(q,index,&n,&at)) return CP_V3_QUEUE_IO;
    *expected=q->slots[index].expected; *length=expected->body_bytes; memcpy(body,q->scratch+at,*length); return CP_V3_QUEUE_OK;
}
cp_v3_queue_result_t cp_v3_queue_ack(cp_v3_queue_t *q,unsigned index,const void *ack,size_t length) {
    if(!q||!q->ready||index>=CP_V3_QUEUE_SLOTS||!ack||!length) return CP_V3_QUEUE_INVALID;
    if(q->slots[index].state!=CP_V3_QUEUE_PENDING) return CP_V3_QUEUE_NOT_FOUND;
    if(q->slots[index].kind==CP_V3_QUEUE_CONTROL||!cp_v3_receipt_matches(ack,length,&q->slots[index].expected)) return CP_V3_QUEUE_MISMATCH;
    size_t n,at; if(!same_record(q,index,&n,&at)) return CP_V3_QUEUE_IO;
    if(!q->store.reclaim(q->store.context,index,q->scratch,n)) {
        q->slots[index].state=CP_V3_QUEUE_QUARANTINED; q->io_failures++; return CP_V3_QUEUE_IO;
    }
    memset(&q->slots[index],0,sizeof q->slots[index]); return CP_V3_QUEUE_OK;
}
unsigned cp_v3_queue_pending(const cp_v3_queue_t *q,cp_v3_queue_kind_t kind) {
    if(!q||!q->ready||(unsigned)kind>CP_V3_QUEUE_CONTROL) return 0;
    unsigned n=0; for(unsigned i=begin(kind);i<end(kind);i++) if(q->slots[i].state==CP_V3_QUEUE_PENDING) n+=q->slots[i].expected.accepted_count;
    return n;
}
size_t cp_v3_queue_pending_bytes(const cp_v3_queue_t *q,cp_v3_queue_kind_t kind) {
    if(!q||!q->ready||(unsigned)kind>CP_V3_QUEUE_CONTROL) return 0;
    size_t n=0; for(unsigned i=begin(kind);i<end(kind);i++) if(q->slots[i].state==CP_V3_QUEUE_PENDING) n+=q->slots[i].expected.body_bytes;
    return n;
}
