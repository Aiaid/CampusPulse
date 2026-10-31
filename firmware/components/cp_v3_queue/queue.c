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
    if(!e||(unsigned)kind>CP_V3_QUEUE_EVENT||!length||length>CP_V3_QUEUE_BODY_MAX||e->body_bytes!=length||
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
           (kind==CP_V3_QUEUE_CONTROL&&(!strcmp(e->stream,"control")||!strcmp(e->stream,"config_ack")||!strcmp(e->stream,"lease")))||
           (kind==CP_V3_QUEUE_WINDOW&&!strcmp(e->stream,"window_statistics")&&e->scope.window_seq)||
           (kind==CP_V3_QUEUE_EVENT&&!strcmp(e->stream,"candidate_events"));
}
static bool hash_matches_fn(cp_v3_sha256_fn fn,void *context,const void *p,size_t n,const char *hex) {
    uint8_t hash[32]; const char chars[]="0123456789abcdef";
    if(!fn(context,p,n,hash)) return false;
    for(unsigned i=0;i<32;i++) if(hex[i*2]!=chars[hash[i]>>4]||hex[i*2+1]!=chars[hash[i]&15]) return false;
    return true;
}
static bool limits_valid(cp_v3_queue_limits_t l) {
    return l.window_slots&&l.status_slots&&l.control_slots&&l.max_body_bytes&&l.max_body_bytes<=CP_V3_QUEUE_BODY_MAX&&
        (unsigned)l.window_slots+l.event_slots+l.status_slots+l.control_slots<=CP_V3_QUEUE_SLOTS;
}
static bool limits_equal(cp_v3_queue_limits_t a,cp_v3_queue_limits_t b) {
    return a.window_slots==b.window_slots&&a.event_slots==b.event_slots&&a.status_slots==b.status_slots&&
        a.control_slots==b.control_slots&&a.max_body_bytes==b.max_body_bytes;
}
static unsigned begin(cp_v3_queue_profile_t profile,cp_v3_queue_limits_t l,cp_v3_queue_kind_t kind) {
    if(profile==CP_V3_QUEUE_FEATURE_TRIAL) {
        if(kind==CP_V3_QUEUE_FEATURE) return 0;
        if(kind==CP_V3_QUEUE_STATUS) return 8;
        if(kind==CP_V3_QUEUE_CONTROL) return 10;
    } else {
        if(kind==CP_V3_QUEUE_WINDOW) return 0;
        if(kind==CP_V3_QUEUE_EVENT&&l.event_slots) return l.window_slots;
        if(kind==CP_V3_QUEUE_STATUS) return (unsigned)l.window_slots+l.event_slots;
        if(kind==CP_V3_QUEUE_CONTROL) return (unsigned)l.window_slots+l.event_slots+l.status_slots;
    }
    return CP_V3_QUEUE_SLOTS;
}
static unsigned end(cp_v3_queue_profile_t profile,cp_v3_queue_limits_t l,cp_v3_queue_kind_t kind) {
    unsigned start=begin(profile,l,kind); if(start==CP_V3_QUEUE_SLOTS) return start;
    if(profile==CP_V3_QUEUE_FEATURE_TRIAL) return start+(kind==CP_V3_QUEUE_FEATURE?8:2);
    return start+(kind==CP_V3_QUEUE_WINDOW?l.window_slots:kind==CP_V3_QUEUE_EVENT?l.event_slots:
        kind==CP_V3_QUEUE_STATUS?l.status_slots:l.control_slots);
}
static size_t encode(cp_v3_queue_t *q,cp_v3_queue_kind_t kind,const cp_v3_expected_t *e,const void *body,size_t n,uint64_t expiry) {
    bool modern=q->config.profile==CP_V3_QUEUE_SMALL_RESULTS;
    codec_t c={q->scratch,0,true}; put(&c,modern?"CPV3Q002":"CPV3Q001",8); integer(&c,kind,4);
    if(modern) {
        integer(&c,q->config.profile,4); integer(&c,q->config.limits.window_slots,1);
        integer(&c,q->config.limits.event_slots,1); integer(&c,q->config.limits.status_slots,1);
        integer(&c,q->config.limits.control_slots,1); integer(&c,q->config.limits.max_body_bytes,2);
    }
    integer(&c,q->next_ordinal,8); if(modern) integer(&c,expiry,8);
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
static bool decode_bytes(const uint8_t *p,size_t length,unsigned index,cp_v3_sha256_fn hash,void *context,cp_v3_queue_slot_t *slot,size_t *body_at) {
    size_t pos=8;
    if(length<HEADER_BYTES+13||length>CP_V3_QUEUE_SLOT_BYTES||memcmp(p+length-8,"COMMIT3!",8)) return false;
    bool modern=!memcmp(p,"CPV3Q002",8);
    if(!modern&&memcmp(p,"CPV3Q001",8)) return false;
    if(modern&&length<HEADER_BYTES+18+13) return false;
    uint64_t kind=number(p,&pos,4);
    uint64_t profile=modern?number(p,&pos,4):CP_V3_QUEUE_FEATURE_TRIAL;
    if(modern) {
        slot->limits.window_slots=(uint8_t)number(p,&pos,1); slot->limits.event_slots=(uint8_t)number(p,&pos,1);
        slot->limits.status_slots=(uint8_t)number(p,&pos,1); slot->limits.control_slots=(uint8_t)number(p,&pos,1);
        slot->limits.max_body_bytes=(uint16_t)number(p,&pos,2);
        if(!limits_valid(slot->limits)) return false;
    }
    if(profile>CP_V3_QUEUE_SMALL_RESULTS||(modern&&profile!=CP_V3_QUEUE_SMALL_RESULTS)||kind>CP_V3_QUEUE_EVENT||
       index<begin(profile,slot->limits,kind)||index>=end(profile,slot->limits,kind)) return false;
    slot->profile=(cp_v3_queue_profile_t)profile; slot->kind=(cp_v3_queue_kind_t)kind;
    slot->ordinal=number(p,&pos,8); slot->source_expires_at_ms=modern?number(p,&pos,8):0;
    if(modern&&(!slot->source_expires_at_ms||slot->source_expires_at_ms>9007199254740991ULL)) return false;
    cp_v3_expected_t *e=&slot->expected; memset(e,0,sizeof *e);
#define FIELD(x) do { memcpy(e->x,p+pos,sizeof e->x); pos+=sizeof e->x; } while(0)
    FIELD(scope.node_id); FIELD(scope.boot_id); FIELD(scope.placement_id); FIELD(scope.policy_id);
    FIELD(scope.policy_sha256); FIELD(scope.dataset); e->scope.assignment_generation=number(p,&pos,8);
    e->scope.window_seq=(uint32_t)number(p,&pos,4); FIELD(batch_id); FIELD(body_sha256); FIELD(stream);
#undef FIELD
    e->seq_first=(uint32_t)number(p,&pos,4); e->seq_last=(uint32_t)number(p,&pos,4);
    e->accepted_count=(uint32_t)number(p,&pos,4); e->body_bytes=(uint32_t)number(p,&pos,4);
    if(pos!=HEADER_BYTES+(modern?18:0)||!slot->ordinal||slot->ordinal==UINT64_MAX||!valid(e,slot->kind,e->body_bytes)||
       (modern&&e->body_bytes>slot->limits.max_body_bytes)||
       length!=pos+e->body_bytes+12||!hash_matches_fn(hash,context,p+pos,e->body_bytes,e->body_sha256)) return false;
    *body_at=pos; pos+=e->body_bytes; size_t crc_at=pos;
    if(crc32(p,crc_at)!=(uint32_t)number(p,&pos,4)||!hash(context,p,length,slot->record_sha256)) return false;
    slot->state=CP_V3_QUEUE_PENDING; return true;
}
static bool decode(cp_v3_queue_t *q,unsigned index,size_t length,cp_v3_queue_slot_t *slot,size_t *body_at) {
    return decode_bytes(q->scratch,length,index,q->sha256,q->sha_context,slot,body_at);
}
bool cp_v3_queue_record_check(const void *bytes,size_t length,unsigned index,cp_v3_sha256_fn hash,void *context,cp_v3_queue_tombstone_t *identity) {
    if(!bytes||!hash||!identity||index>=CP_V3_QUEUE_SLOTS) return false;
    cp_v3_queue_slot_t slot={0}; size_t at=0;
    if(!decode_bytes(bytes,length,index,hash,context,&slot,&at)) return false;
    memset(identity,0,sizeof *identity); identity->ordinal=slot.ordinal;
    identity->source_expires_at_ms=slot.source_expires_at_ms; identity->body_bytes=(uint32_t)slot.expected.body_bytes;
    strcpy(identity->body_sha256,slot.expected.body_sha256); memcpy(identity->record_sha256,slot.record_sha256,32);
    return true;
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
    const cp_v3_queue_profile_config_t config={.profile=CP_V3_QUEUE_FEATURE_TRIAL};
    return cp_v3_queue_open_profile(q,store,node,boot,hash,context,&config);
}
cp_v3_queue_result_t cp_v3_queue_open_profile(cp_v3_queue_t *q,cp_v3_queue_store_t store,const char *node,const char *boot,
    cp_v3_sha256_fn hash,void *context,const cp_v3_queue_profile_config_t *config) {
    if(!q||!store.load||!store.store||!store.reclaim||!hash||!text(node,65)||!text(boot,37)||!uuid(boot)||
       !config||(unsigned)config->profile>CP_V3_QUEUE_SMALL_RESULTS||
       (config->profile==CP_V3_QUEUE_SMALL_RESULTS&&(!config->clock||!config->expire))) return CP_V3_QUEUE_INVALID;
    memset(q,0,sizeof *q); q->store=store; q->sha256=hash; q->sha_context=context;
    q->config=*config;
    if(q->config.profile==CP_V3_QUEUE_SMALL_RESULTS) {
        cp_v3_queue_limits_t l=q->config.limits;
        if(!l.window_slots&&!l.event_slots&&!l.status_slots&&!l.control_slots&&!l.max_body_bytes)
            q->config.limits=(cp_v3_queue_limits_t){4,4,2,2,CP_V3_QUEUE_BODY_MAX};
        if(!limits_valid(q->config.limits)) return CP_V3_QUEUE_INVALID;
    }
    strcpy(q->node_id,node); strcpy(q->boot_id,boot); q->next_ordinal=1;
    for(unsigned i=0;i<CP_V3_QUEUE_SLOTS;i++) {
        cp_v3_queue_slot_t candidate={0};
        size_t length=0,body_at=0; int r=store.load(store.context,i,q->scratch,sizeof q->scratch,&length);
        if(!r) continue;
        if(r<0) { q->io_failures++; return CP_V3_QUEUE_IO; }
        if(r==3||r==4) {
            cp_v3_queue_tombstone_t tombstone;
            if(!cp_v3_queue_tombstone_decode(q->scratch,length,&tombstone)) {
                q->slots[i].state=CP_V3_QUEUE_QUARANTINED; q->corrupt_slots++; continue;
            }
            if(q->next_ordinal<=tombstone.ordinal) q->next_ordinal=tombstone.ordinal+1;
            q->slots[i].ordinal=tombstone.ordinal; q->slots[i].source_expires_at_ms=tombstone.source_expires_at_ms;
            q->slots[i].expected.body_bytes=tombstone.body_bytes; strcpy(q->slots[i].expected.body_sha256,tombstone.body_sha256);
            if(r==4) { q->slots[i].state=CP_V3_QUEUE_QUARANTINED; q->corrupt_slots++; }
            continue;
        }
        if(r!=1||!decode(q,i,length,&candidate,&body_at)) {
            q->slots[i].state=CP_V3_QUEUE_QUARANTINED; q->corrupt_slots++; continue;
        }
        q->slots[i]=candidate;
        if(q->next_ordinal<=q->slots[i].ordinal) q->next_ordinal=q->slots[i].ordinal+1;
        if(q->slots[i].profile!=q->config.profile||
           (q->slots[i].profile==CP_V3_QUEUE_SMALL_RESULTS&&!limits_equal(q->slots[i].limits,q->config.limits))||
           strcmp(q->slots[i].expected.scope.node_id,node)||
           (strcmp(q->slots[i].expected.scope.boot_id,boot)&&!(q->config.profile==CP_V3_QUEUE_SMALL_RESULTS&&
                ((q->config.allow_historical_small&&q->slots[i].kind!=CP_V3_QUEUE_CONTROL)||
                 (q->config.allow_historical_control_reclaim&&q->slots[i].kind==CP_V3_QUEUE_CONTROL&&
                  (!strcmp(q->slots[i].expected.stream,"config_ack")||!strcmp(q->slots[i].expected.stream,"lease"))))))) {
            q->slots[i].state=CP_V3_QUEUE_QUARANTINED; q->retired_slots++;
        } else if(strcmp(q->slots[i].expected.scope.boot_id,boot)) q->historical_slots++;
    }
    /* Duplicate ordinals/batch IDs are ambiguous custody, never silently FIFO. */
    for(unsigned i=0;i<CP_V3_QUEUE_SLOTS;i++) for(unsigned j=i+1;j<CP_V3_QUEUE_SLOTS;j++)
        if(q->slots[i].state!=CP_V3_QUEUE_FREE&&q->slots[j].state!=CP_V3_QUEUE_FREE&&
           q->slots[i].expected.batch_id[0]&&q->slots[j].expected.batch_id[0]&&
           q->slots[i].ordinal&&q->slots[j].ordinal&&(q->slots[i].ordinal==q->slots[j].ordinal||
           !strcmp(q->slots[i].expected.batch_id,q->slots[j].expected.batch_id))) {
            q->slots[i].state=q->slots[j].state=CP_V3_QUEUE_QUARANTINED; q->corrupt_slots++;
        }
    memset(q->scratch,0,sizeof q->scratch); q->ready=true; return CP_V3_QUEUE_OK;
}
cp_v3_queue_result_t cp_v3_queue_push(cp_v3_queue_t *q,cp_v3_queue_kind_t kind,const cp_v3_expected_t *e,
    const void *body,size_t length,unsigned *out) {
    if(!q||q->config.profile!=CP_V3_QUEUE_FEATURE_TRIAL) return CP_V3_QUEUE_INVALID;
    return cp_v3_queue_push_expiring(q,kind,e,body,length,0,out);
}
cp_v3_queue_result_t cp_v3_queue_push_expiring(cp_v3_queue_t *q,cp_v3_queue_kind_t kind,const cp_v3_expected_t *e,
    const void *body,size_t length,uint64_t expiry,unsigned *out) {
    if(!q||!q->ready||!out||!body||!valid(e,kind,length)||q->next_ordinal==UINT64_MAX) return CP_V3_QUEUE_INVALID;
    if(begin(q->config.profile,q->config.limits,kind)==CP_V3_QUEUE_SLOTS||
       (q->config.profile==CP_V3_QUEUE_SMALL_RESULTS&&kind==CP_V3_QUEUE_CONTROL&&strcmp(e->stream,"config_ack")&&strcmp(e->stream,"lease"))||
       (q->config.profile==CP_V3_QUEUE_SMALL_RESULTS&&length>q->config.limits.max_body_bytes)||
       (q->config.profile==CP_V3_QUEUE_SMALL_RESULTS?(!expiry||expiry>9007199254740991ULL):expiry!=0)) return CP_V3_QUEUE_INVALID;
    if(q->config.profile==CP_V3_QUEUE_SMALL_RESULTS) {
        cp_v3_queue_result_t swept=cp_v3_queue_expire(q); if(swept!=CP_V3_QUEUE_OK) return swept;
        uint64_t lower,upper;
        if(!q->config.clock(q->config.retention_context,&lower,&upper)||lower>upper||upper>9007199254740991ULL) return CP_V3_QUEUE_CLOCK_UNKNOWN;
        if(lower>=expiry) return CP_V3_QUEUE_EXPIRED;
        if(upper>=expiry) return CP_V3_QUEUE_CLOCK_UNKNOWN;
    }
    if(strcmp(e->scope.node_id,q->node_id)||strcmp(e->scope.boot_id,q->boot_id)) return CP_V3_QUEUE_RETIRED;
    if(!hash_matches_fn(q->sha256,q->sha_context,body,length,e->body_sha256)) return CP_V3_QUEUE_MISMATCH;
    for(unsigned i=0;i<CP_V3_QUEUE_SLOTS;i++) {
        if(q->slots[i].state==CP_V3_QUEUE_FREE&&q->slots[i].source_expires_at_ms&&
           !strcmp(q->slots[i].expected.body_sha256,e->body_sha256)) return CP_V3_QUEUE_EXPIRED;
    }
    for(unsigned i=0;i<CP_V3_QUEUE_SLOTS;i++) if(q->slots[i].state!=CP_V3_QUEUE_FREE&&
        !strcmp(q->slots[i].expected.batch_id,e->batch_id)) {
        size_t n,at;
        if(q->slots[i].state!=CP_V3_QUEUE_PENDING||!same_record(q,i,&n,&at)) return CP_V3_QUEUE_MISMATCH;
        cp_v3_queue_slot_t *s=&q->slots[i];
        if(s->kind!=kind||s->profile!=q->config.profile||s->source_expires_at_ms!=expiry||
           strcmp(s->expected.body_sha256,e->body_sha256)||s->expected.body_bytes!=length||
           memcmp(q->scratch+at,body,length)) return CP_V3_QUEUE_MISMATCH;
        /* A retry must match every encoded scope byte, not just batch/body hash. */
        uint64_t next=q->next_ordinal; q->next_ordinal=s->ordinal;
        size_t encoded=encode(q,kind,e,body,length,expiry); q->next_ordinal=next; uint8_t hash[32];
        if(!encoded||!q->sha256(q->sha_context,q->scratch,encoded,hash)||memcmp(hash,s->record_sha256,32)) return CP_V3_QUEUE_MISMATCH;
        *out=i; return CP_V3_QUEUE_OK;
    }
    unsigned index; for(index=begin(q->config.profile,q->config.limits,kind);index<end(q->config.profile,q->config.limits,kind);index++) if(q->slots[index].state==CP_V3_QUEUE_FREE) break;
    if(index==end(q->config.profile,q->config.limits,kind)) return CP_V3_QUEUE_FULL;
    size_t encoded=encode(q,kind,e,body,length,expiry); uint8_t frozen_hash[32];
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
    if(!q||!q->ready||!out||(unsigned)kind>CP_V3_QUEUE_EVENT||begin(q->config.profile,q->config.limits,kind)==CP_V3_QUEUE_SLOTS) return CP_V3_QUEUE_INVALID;
    unsigned best=CP_V3_QUEUE_SLOTS; for(unsigned i=begin(q->config.profile,q->config.limits,kind);i<end(q->config.profile,q->config.limits,kind);i++)
        if(q->slots[i].state==CP_V3_QUEUE_PENDING&&(best==CP_V3_QUEUE_SLOTS||q->slots[i].ordinal<q->slots[best].ordinal)) best=i;
    if(best==CP_V3_QUEUE_SLOTS) return CP_V3_QUEUE_NOT_FOUND;
    *out=best; return CP_V3_QUEUE_OK;
}
cp_v3_queue_result_t cp_v3_queue_read(cp_v3_queue_t *q,unsigned index,void *body,size_t cap,size_t *length,cp_v3_expected_t *expected) {
    if(length) *length=0;
    if(!q||!q->ready||index>=CP_V3_QUEUE_SLOTS||!body||!length||!expected) return CP_V3_QUEUE_INVALID;
    if(q->config.profile==CP_V3_QUEUE_SMALL_RESULTS) {
        bool expired=q->slots[index].source_expires_at_ms!=0;
        cp_v3_queue_result_t r=cp_v3_queue_expire(q); if(r!=CP_V3_QUEUE_OK) return r;
        if(expired&&q->slots[index].state==CP_V3_QUEUE_FREE) return CP_V3_QUEUE_EXPIRED;
        uint64_t lower,upper;
        if(!q->config.clock(q->config.retention_context,&lower,&upper)||lower>upper||upper>9007199254740991ULL||
           (q->slots[index].source_expires_at_ms&&upper>=q->slots[index].source_expires_at_ms)) return CP_V3_QUEUE_CLOCK_UNKNOWN;
    }
    if(q->slots[index].state!=CP_V3_QUEUE_PENDING) return CP_V3_QUEUE_NOT_FOUND;
    if(cap<q->slots[index].expected.body_bytes) return CP_V3_QUEUE_INVALID;
    size_t n,at; if(!same_record(q,index,&n,&at)) return CP_V3_QUEUE_IO;
    *expected=q->slots[index].expected; *length=expected->body_bytes; memcpy(body,q->scratch+at,*length); return CP_V3_QUEUE_OK;
}
cp_v3_queue_result_t cp_v3_queue_ack(cp_v3_queue_t *q,unsigned index,const void *ack,size_t length) {
    if(!q||!q->ready||index>=CP_V3_QUEUE_SLOTS||!ack||!length) return CP_V3_QUEUE_INVALID;
    if(q->config.profile==CP_V3_QUEUE_SMALL_RESULTS) {
        bool occupied=q->slots[index].state!=CP_V3_QUEUE_FREE;
        cp_v3_queue_result_t r=cp_v3_queue_expire(q); if(r!=CP_V3_QUEUE_OK) return r;
        if(occupied&&q->slots[index].state==CP_V3_QUEUE_FREE) return CP_V3_QUEUE_EXPIRED;
        uint64_t lower,upper;
        if(!q->config.clock(q->config.retention_context,&lower,&upper)||lower>upper||upper>9007199254740991ULL||
           (q->slots[index].source_expires_at_ms&&upper>=q->slots[index].source_expires_at_ms)) return CP_V3_QUEUE_CLOCK_UNKNOWN;
    }
    if(q->slots[index].state!=CP_V3_QUEUE_PENDING) return CP_V3_QUEUE_NOT_FOUND;
    bool matches=q->config.profile==CP_V3_QUEUE_SMALL_RESULTS?
        cp_v3_statistics_receipt_matches(ack,length,&q->slots[index].expected):cp_v3_receipt_matches(ack,length,&q->slots[index].expected);
    if(q->slots[index].kind==CP_V3_QUEUE_CONTROL||!matches) return CP_V3_QUEUE_MISMATCH;
    size_t n,at; if(!same_record(q,index,&n,&at)) return CP_V3_QUEUE_IO;
    if(!q->store.reclaim(q->store.context,index,q->scratch,n)) {
        q->slots[index].state=CP_V3_QUEUE_QUARANTINED; q->io_failures++; return CP_V3_QUEUE_IO;
    }
    memset(&q->slots[index],0,sizeof q->slots[index]); return CP_V3_QUEUE_OK;
}
cp_v3_queue_result_t cp_v3_queue_ack_control(cp_v3_queue_t *q,unsigned index,const void *ack,size_t length,
    cp_v3_queue_control_match_fn matches,void *context) {
    if(!q||!q->ready||index>=CP_V3_QUEUE_SLOTS||!ack||!length||length>4096||!matches) return CP_V3_QUEUE_INVALID;
    if(q->config.profile==CP_V3_QUEUE_SMALL_RESULTS) {
        bool occupied=q->slots[index].state!=CP_V3_QUEUE_FREE;
        cp_v3_queue_result_t swept=cp_v3_queue_expire(q); if(swept!=CP_V3_QUEUE_OK) return swept;
        if(occupied&&q->slots[index].state==CP_V3_QUEUE_FREE) return CP_V3_QUEUE_EXPIRED;
        uint64_t lower,upper;
        if(!q->config.clock(q->config.retention_context,&lower,&upper)||lower>upper||upper>9007199254740991ULL||
           (q->slots[index].source_expires_at_ms&&upper>=q->slots[index].source_expires_at_ms)) return CP_V3_QUEUE_CLOCK_UNKNOWN;
    }
    if(q->slots[index].state!=CP_V3_QUEUE_PENDING) return CP_V3_QUEUE_NOT_FOUND;
    cp_v3_expected_t *expected=&q->slots[index].expected;
    if(q->slots[index].kind!=CP_V3_QUEUE_CONTROL||
       (strcmp(expected->stream,"config_ack")&&strcmp(expected->stream,"lease"))) return CP_V3_QUEUE_MISMATCH;
    size_t n,at; if(!same_record(q,index,&n,&at)) return CP_V3_QUEUE_IO;
    if(!matches(context,expected,q->scratch+at,expected->body_bytes,ack,length)) return CP_V3_QUEUE_MISMATCH;
    if(!q->store.reclaim(q->store.context,index,q->scratch,n)) {
        q->slots[index].state=CP_V3_QUEUE_QUARANTINED; q->io_failures++; return CP_V3_QUEUE_IO;
    }
    memset(&q->slots[index],0,sizeof q->slots[index]); return CP_V3_QUEUE_OK;
}
unsigned cp_v3_queue_pending(const cp_v3_queue_t *q,cp_v3_queue_kind_t kind) {
    if(!q||!q->ready||(unsigned)kind>CP_V3_QUEUE_EVENT) return 0;
    unsigned n=0; for(unsigned i=begin(q->config.profile,q->config.limits,kind);i<end(q->config.profile,q->config.limits,kind);i++) if(q->slots[i].state==CP_V3_QUEUE_PENDING) n+=q->slots[i].expected.accepted_count;
    return n;
}
size_t cp_v3_queue_pending_bytes(const cp_v3_queue_t *q,cp_v3_queue_kind_t kind) {
    if(!q||!q->ready||(unsigned)kind>CP_V3_QUEUE_EVENT) return 0;
    size_t n=0; for(unsigned i=begin(q->config.profile,q->config.limits,kind);i<end(q->config.profile,q->config.limits,kind);i++) if(q->slots[i].state==CP_V3_QUEUE_PENDING) n+=q->slots[i].expected.body_bytes;
    return n;
}
cp_v3_queue_result_t cp_v3_queue_expire(cp_v3_queue_t *q) {
    if(!q||!q->ready) return CP_V3_QUEUE_INVALID;
    if(q->config.profile!=CP_V3_QUEUE_SMALL_RESULTS) return CP_V3_QUEUE_OK;
    uint64_t now=0,upper=0;
    if(!q->config.clock(q->config.retention_context,&now,&upper)||now>upper||upper>9007199254740991ULL) return CP_V3_QUEUE_CLOCK_UNKNOWN;
    for(unsigned i=0;i<CP_V3_QUEUE_SLOTS;i++) {
        cp_v3_queue_slot_t *s=&q->slots[i];
        if(s->state==CP_V3_QUEUE_FREE||s->profile!=CP_V3_QUEUE_SMALL_RESULTS||
           !limits_equal(s->limits,q->config.limits)||strcmp(s->expected.scope.node_id,q->node_id)||
           !s->source_expires_at_ms||now<s->source_expires_at_ms) continue;
        size_t length=0,at=0;
        if(!same_record(q,i,&length,&at)) {
            /* A backend can finish a previously durable exact expiry intent
             * while loading. Its verified minimal tombstone is sufficient for
             * this expiry sweep, never for an upload ACK or source recreation. */
            cp_v3_queue_tombstone_t completed;
            if(!cp_v3_queue_tombstone_decode(q->scratch,length,&completed)||completed.ordinal!=s->ordinal||
               completed.source_expires_at_ms!=s->source_expires_at_ms||completed.body_bytes!=s->expected.body_bytes||
               strcmp(completed.body_sha256,s->expected.body_sha256)||memcmp(completed.record_sha256,s->record_sha256,32)) return CP_V3_QUEUE_IO;
            q->corrupt_slots--; q->expired_items+=s->expected.accepted_count; q->expired_bytes+=s->expected.body_bytes;
            memset(s,0,sizeof *s); s->ordinal=completed.ordinal; s->source_expires_at_ms=completed.source_expires_at_ms;
            s->expected.body_bytes=completed.body_bytes; strcpy(s->expected.body_sha256,completed.body_sha256); continue;
        }
        cp_v3_queue_tombstone_t tombstone={.ordinal=s->ordinal,.source_expires_at_ms=s->source_expires_at_ms,.body_bytes=(uint32_t)s->expected.body_bytes};
        strcpy(tombstone.body_sha256,s->expected.body_sha256);
        memcpy(tombstone.record_sha256,s->record_sha256,32);
        if(!q->config.expire(q->config.retention_context,i,q->scratch,length,&tombstone)) {
            s->state=CP_V3_QUEUE_QUARANTINED; q->io_failures++; return CP_V3_QUEUE_IO;
        }
        q->expired_items+=s->expected.accepted_count; q->expired_bytes+=s->expected.body_bytes;
        memset(s,0,sizeof *s); s->ordinal=tombstone.ordinal; s->source_expires_at_ms=tombstone.source_expires_at_ms;
        s->expected.body_bytes=tombstone.body_bytes; strcpy(s->expected.body_sha256,tombstone.body_sha256);
    }
    return CP_V3_QUEUE_OK;
}
bool cp_v3_queue_tombstone_encode(const cp_v3_queue_tombstone_t *t,void *out,size_t cap) {
    if(!t||!out||cap<CP_V3_QUEUE_TOMBSTONE_BYTES||!t->ordinal||t->ordinal==UINT64_MAX||
       !t->source_expires_at_ms||t->source_expires_at_ms>9007199254740991ULL||!t->body_bytes||
       t->body_bytes>CP_V3_QUEUE_BODY_MAX||!memchr(t->body_sha256,0,sizeof t->body_sha256)||!digest(t->body_sha256)) return false;
    uint8_t bytes[CP_V3_QUEUE_TOMBSTONE_BYTES]; codec_t c={bytes,0,true};
    put(&c,"CPV3EX01",8); integer(&c,t->ordinal,8); integer(&c,t->source_expires_at_ms,8); integer(&c,t->body_bytes,4);
    for(unsigned i=0;i<32;i++) {
        unsigned hi=t->body_sha256[i*2]<='9'?t->body_sha256[i*2]-'0':t->body_sha256[i*2]-'a'+10;
        unsigned lo=t->body_sha256[i*2+1]<='9'?t->body_sha256[i*2+1]-'0':t->body_sha256[i*2+1]-'a'+10;
        uint8_t v=(uint8_t)(hi*16+lo); put(&c,&v,1);
    }
    put(&c,t->record_sha256,32); integer(&c,crc32(bytes,c.position),4);
    if(c.position!=sizeof bytes) return false;
    memcpy(out,bytes,sizeof bytes); return true;
}
unsigned cp_v3_queue_capacity(const cp_v3_queue_t *q,cp_v3_queue_kind_t kind) {
    if(!q||!q->ready||(unsigned)kind>CP_V3_QUEUE_EVENT) return 0;
    return end(q->config.profile,q->config.limits,kind)-begin(q->config.profile,q->config.limits,kind);
}
size_t cp_v3_queue_encoded_size(const cp_v3_queue_t *q,size_t body_bytes) {
    if(!q||!q->ready||!body_bytes||body_bytes>(q->config.profile==CP_V3_QUEUE_SMALL_RESULTS?q->config.limits.max_body_bytes:CP_V3_QUEUE_BODY_MAX)) return 0;
    return HEADER_BYTES+(q->config.profile==CP_V3_QUEUE_SMALL_RESULTS?18:0)+body_bytes+12;
}
bool cp_v3_queue_tombstone_decode(const void *input,size_t n,cp_v3_queue_tombstone_t *t) {
    if(!input||!t||n!=CP_V3_QUEUE_TOMBSTONE_BYTES||memcmp(input,"CPV3EX01",8)) return false;
    const uint8_t *bytes=input; size_t pos=n-4;
    if(crc32(bytes,n-4)!=(uint32_t)number(bytes,&pos,4)) return false;
    memset(t,0,sizeof *t); pos=8; t->ordinal=number(bytes,&pos,8); t->source_expires_at_ms=number(bytes,&pos,8);
    t->body_bytes=(uint32_t)number(bytes,&pos,4); const char hex[]="0123456789abcdef";
    for(unsigned i=0;i<32;i++) { uint8_t v=bytes[pos++]; t->body_sha256[i*2]=hex[v>>4]; t->body_sha256[i*2+1]=hex[v&15]; }
    memcpy(t->record_sha256,bytes+pos,32);
    return t->ordinal&&t->ordinal!=UINT64_MAX&&t->source_expires_at_ms&&t->source_expires_at_ms<=9007199254740991ULL&&
        t->body_bytes&&t->body_bytes<=CP_V3_QUEUE_BODY_MAX;
}
