#include "identity.h"
#include <string.h>

#define DAY_MS UINT64_C(86400000)
#define UTC_MIN UINT64_C(1704067200000)
#define UTC_MAX UINT64_C(7258118400000)
#define BOOT_OFFSET TE_IDENTITY_HEADER_BYTES
#define ITEM_OFFSET (BOOT_OFFSET + TE_IDENTITY_BOOTS_MAX * TE_IDENTITY_BOOT_BYTES)
#define HASH_OFFSET (ITEM_OFFSET + TE_IDENTITY_IDS_MAX * TE_IDENTITY_ITEM_BYTES)
#define CRC_OFFSET (HASH_OFFSET + 32u)
_Static_assert(TE_IDENTITY_RECORD_BYTES <= TE_IDENTITY_WRITE_ALLOWANCE, "write allowance");
static void put(uint8_t *p, uint64_t value, unsigned width) {
    for (unsigned i=0;i<width;i++) p[i]=(uint8_t)(value>>(i*8));
}
static uint64_t get(const uint8_t *p, unsigned width) {
    uint64_t value=0; for(unsigned i=0;i<width;i++) value|=(uint64_t)p[i]<<(i*8); return value;
}
static uint32_t crc32(const uint8_t *p, size_t length) {
    uint32_t crc=UINT32_MAX;
    while(length--) { crc^=*p++; for(unsigned i=0;i<8;i++) crc=(crc>>1)^((crc&1)?UINT32_C(0xedb88320):0); }
    return crc^UINT32_MAX;
}
static bool zero(const uint8_t *p, size_t n) {
    for(size_t i=0;i<n;i++) {
        if(p[i]) return false;
    }
    return true;
}
static bool node_valid(const char *s) {
    if(!s) return false;
    size_t n=0; for(;n<65&&s[n];n++) {
        char c=s[n]; if(!((c>='a'&&c<='z')||(c>='A'&&c<='Z')||(c>='0'&&c<='9')||c=='_'||c=='-'||c=='.'||c==':')) return false;
    }
    return n&&n<65;
}
static int hex(char c) { return c>='0'&&c<='9'?c-'0':c>='a'&&c<='f'?c-'a'+10:-1; }
static bool uuid_bytes(const char *s,uint8_t out[16]) {
    if(!s) return false;
    unsigned n=0; int high=-1;
    for(unsigned i=0;i<36;i++) {
        if(i==8||i==13||i==18||i==23) { if(s[i]!='-') return false; continue; }
        int digit=hex(s[i]); if(digit<0) return false;
        if(high<0) high=digit; else { out[n++]=(uint8_t)((high<<4)|digit); high=-1; }
    }
    return !s[36]&&(out[6]>>4)==4&&(out[8]>>6)==2;
}
static void uuid_text(const uint8_t bytes[16],char out[37]) {
    static const char digits[]="0123456789abcdef"; unsigned n=0;
    for(unsigned i=0;i<16;i++) {
        if(i==4||i==6||i==8||i==10) out[n++]='-';
        out[n++]=digits[bytes[i]>>4];out[n++]=digits[bytes[i]&15];
    }
    out[n]=0;
}
static bool uuid_binary(const uint8_t bytes[16]) { return (bytes[6]>>4)==4&&(bytes[8]>>6)==2; }
static bool bounds(uint64_t lo,uint64_t hi) { return lo>=UTC_MIN&&hi<UTC_MAX&&lo<=hi&&lo/DAY_MS==hi/DAY_MS; }
static te_identity_result_t fail(te_identity_t *l,te_identity_result_t result) {
    if(l) { l->state=TE_IDENTITY_FAILED;l->last_result=result; } return result;
}
static te_identity_result_t leave(te_identity_t *l,te_identity_result_t r) {
    if(r!=TE_IDENTITY_OK) fail(l,r); else l->last_result=r;
    l->locked=false;l->config.unlock(l->config.lock_context);return r;
}
static te_identity_result_t enter(te_identity_t *l) {
    if(!l) return TE_IDENTITY_INVALID;
    if(l->state==TE_IDENTITY_FAILED) return TE_IDENTITY_LATCHED;
    if(l->state!=TE_IDENTITY_OPEN&&l->state!=TE_IDENTITY_ACTIVE) return fail(l,TE_IDENTITY_STATE);
    if(l->locked) return fail(l,TE_IDENTITY_BUSY);
    if(!l->config.try_lock(l->config.lock_context)) return fail(l,TE_IDENTITY_BUSY);
    l->locked=true;return TE_IDENTITY_OK;
}
static bool seal(te_identity_t *l,uint8_t *p) {
    if(!l->config.sha256(l->config.hash_context,p,HASH_OFFSET,p+HASH_OFFSET)||zero(p+HASH_OFFSET,32)) return false;
    put(p+CRC_OFFSET,crc32(p,CRC_OFFSET),4);memcpy(p+CRC_OFFSET+4,"ID!1",4);return true;
}
static bool decode(te_identity_t *l,const uint8_t *p) {
    unsigned boots=(unsigned)get(p+20,2),count=(unsigned)get(p+22,2);
    uint8_t digest[32];
    if(memcmp(p,"TEIDLG01",8)||get(p+8,2)!=1||get(p+10,2)!=TE_IDENTITY_HEADER_BYTES||
       get(p+12,4)!=TE_IDENTITY_RECORD_BYTES||!boots||boots>TE_IDENTITY_BOOTS_MAX||count>TE_IDENTITY_IDS_MAX||
       get(p+16,4)!=boots+count||!memchr(p+24,0,65)||!node_valid((const char *)p+24)||
       !zero(p+24+strlen((const char *)p+24),72-strlen((const char *)p+24))||
       !bounds(get(p+96,8),get(p+104,8))||!bounds(get(p+112,8),get(p+120,8))||
       get(p+112,8)<get(p+96,8)||memcmp(p+CRC_OFFSET+4,"ID!1",4)||get(p+CRC_OFFSET,4)!=crc32(p,CRC_OFFSET)||
       !l->config.sha256(l->config.hash_context,p,HASH_OFFSET,digest)||zero(digest,32)||memcmp(digest,p+HASH_OFFSET,32)) return false;
    for(unsigned i=0;i<TE_IDENTITY_BOOTS_MAX;i++) {
        const uint8_t *boot=p+BOOT_OFFSET+i*16;
        if(i>=boots) { if(!zero(boot,16)) return false; continue; }
        if(!uuid_binary(boot)) return false;
        for(unsigned j=0;j<i;j++) if(!memcmp(boot,p+BOOT_OFFSET+j*16,16)) return false;
    }
    unsigned previous_boot=0;uint32_t previous_seq=0;
    for(unsigned i=0;i<TE_IDENTITY_IDS_MAX;i++) {
        const uint8_t *item=p+ITEM_OFFSET+i*24;
        if(i>=count) { if(!zero(item,24)) return false; continue; }
        unsigned boot=(unsigned)get(item,2);uint32_t seq=(uint32_t)get(item+4,4);
        if(boot>=boots||get(item+2,2)||!seq||boot<previous_boot||(boot==previous_boot&&seq<=previous_seq)||!uuid_binary(item+8)) return false;
        for(unsigned j=0;j<boots;j++) if(!memcmp(item+8,p+BOOT_OFFSET+j*16,16)) return false;
        for(unsigned j=0;j<i;j++) if(!memcmp(item+8,p+ITEM_OFFSET+j*24+8,16)) return false;
        previous_boot=boot;previous_seq=seq;
    }
    return true;
}
static bool reused(const uint8_t *p,const uint8_t uuid[16]) {
    for(unsigned i=0;i<get(p+20,2);i++) if(!memcmp(uuid,p+BOOT_OFFSET+i*16,16)) return true;
    for(unsigned i=0;i<get(p+22,2);i++) if(!memcmp(uuid,p+ITEM_OFFSET+i*24+8,16)) return true;
    return false;
}
static te_identity_result_t budget_owner(te_identity_t *l) {
    cp_v3_budget_t *budget=l->config.storage_budget;
    static const char prefix[]="campuspulse/3\0t-energy-budget/1\0storage\0";
    uint8_t material[sizeof prefix+64],owner[32];size_t n=sizeof prefix-1;
    memcpy(material,prefix,n);memcpy(material+n,l->node,strlen(l->node));n+=strlen(l->node);
    if(!l->config.sha256(l->config.hash_context,material,n,owner)||zero(owner,32)) return TE_IDENTITY_OWNER;
    if(!budget||!budget->opened||!budget->configured||budget->latched) return TE_IDENTITY_BUDGET;
    if(memcmp(owner,budget->record.owner_key,32)) return TE_IDENTITY_OWNER;
    return TE_IDENTITY_OK;
}
static te_identity_result_t now(te_identity_t *l,uint64_t *lo,uint64_t *hi,uint64_t *mono) {
    if(!l->config.clock(l->config.clock_context,lo,hi,mono)||!bounds(*lo,*hi)||
       (l->have_clock&&(*lo<l->last_lower||*mono<l->last_monotonic))||
       (l->have_record&&*lo<get(l->current+112,8))) return TE_IDENTITY_CLOCK;
    if(l->state==TE_IDENTITY_ACTIVE&&(*mono-l->boot_monotonic>=TE_IDENTITY_TRIAL_MS||
       *hi-get(l->current+96,8)>=TE_IDENTITY_TRIAL_MS)) return TE_IDENTITY_TRIAL_ENDED;
    l->last_lower=*lo;l->last_monotonic=*mono;l->have_clock=true;return TE_IDENTITY_OK;
}
static te_identity_result_t audit(te_identity_t *l) {
    size_t n=0;te_identity_load_t loaded=l->config.backend.load(l->config.backend.context,l->scratch,sizeof l->scratch,&n);
    if(loaded==TE_IDENTITY_LOAD_IO) return TE_IDENTITY_IO;
    if(!l->have_record) return loaded==TE_IDENTITY_ABSENT&&!n?TE_IDENTITY_OK:TE_IDENTITY_CHANGED;
    if(loaded!=TE_IDENTITY_PRESENT||n!=sizeof l->scratch||memcmp(l->current,l->scratch,n)) return TE_IDENTITY_CHANGED;
    return TE_IDENTITY_OK;
}
static te_identity_result_t space(te_identity_t *l) {
    uint32_t entries=0;
    if(!l->config.backend.available_entries(l->config.backend.context,&entries)||entries<TE_IDENTITY_REQUIRED_ENTRIES) return TE_IDENTITY_SPACE;
    return TE_IDENTITY_OK;
}
static te_identity_result_t persist(te_identity_t *l,uint64_t lo,uint64_t hi) {
    te_identity_result_t r=budget_owner(l);if(r!=TE_IDENTITY_OK) return r;
    if(!seal(l,l->scratch)) return TE_IDENTITY_CORRUPT;
    if((r=space(l))!=TE_IDENTITY_OK) return r;
    l->last_budget_result=cp_v3_budget_charge(l->config.storage_budget,TE_IDENTITY_WRITE_ALLOWANCE,lo,hi);
    if(l->last_budget_result!=CP_V3_BUDGET_OK) return TE_IDENTITY_BUDGET;
    /* Budget's own checkpoint may consume entries; remeasure under same lock. */
    if((r=space(l))!=TE_IDENTITY_OK) return r;
    if(!l->config.backend.commit(l->config.backend.context,l->scratch,sizeof l->scratch)) return TE_IDENTITY_IO;
    size_t n=0;te_identity_load_t loaded=l->config.backend.load(l->config.backend.context,l->current,sizeof l->current,&n);
    if(loaded==TE_IDENTITY_LOAD_IO) return TE_IDENTITY_IO;
    if(loaded!=TE_IDENTITY_PRESENT||n!=sizeof l->current||memcmp(l->current,l->scratch,n)||!decode(l,l->current)) return TE_IDENTITY_CORRUPT;
    l->have_record=true;return TE_IDENTITY_OK;
}
te_identity_result_t te_identity_open(te_identity_t *l,const char *node,const te_identity_config_t *cfg) {
    if(!l||!cfg||!node_valid(node)||!cfg->backend.load||!cfg->backend.commit||!cfg->backend.available_entries||
       !cfg->try_lock||!cfg->unlock||!cfg->storage_budget||!cfg->sha256||!cfg->clock||!cfg->entropy) return fail(l,TE_IDENTITY_INVALID);
    if(l->state!=TE_IDENTITY_NEW) return fail(l,TE_IDENTITY_STATE);
    l->config=*cfg;strcpy(l->node,node);l->state=TE_IDENTITY_OPEN;
    te_identity_result_t r=enter(l);if(r!=TE_IDENTITY_OK) return r;
    if((r=budget_owner(l))!=TE_IDENTITY_OK) return leave(l,r);
    size_t n=0;te_identity_load_t loaded=cfg->backend.load(cfg->backend.context,l->current,sizeof l->current,&n);
    if(loaded==TE_IDENTITY_LOAD_IO) return leave(l,TE_IDENTITY_IO);
    if(loaded==TE_IDENTITY_ABSENT&&!n) memset(l->current,0,sizeof l->current);
    else {
        if(loaded!=TE_IDENTITY_PRESENT||n!=sizeof l->current||!decode(l,l->current)) return leave(l,TE_IDENTITY_CORRUPT);
        if(strcmp((const char *)l->current+24,node)) return leave(l,TE_IDENTITY_OWNER);
        l->have_record=true;
    }
    uint64_t lo,hi,mono;if((r=now(l,&lo,&hi,&mono))!=TE_IDENTITY_OK) return leave(l,r);
    if((r=space(l))!=TE_IDENTITY_OK) return leave(l,r);
    return leave(l,TE_IDENTITY_OK);
}
te_identity_result_t te_identity_begin_boot(te_identity_t *l,char out[37]) {
    if(out) memset(out,0,37);
    te_identity_result_t r=enter(l);if(r!=TE_IDENTITY_OK) return r;
    if(!out||l->state!=TE_IDENTITY_OPEN) return leave(l,TE_IDENTITY_STATE);
    if((r=audit(l))!=TE_IDENTITY_OK) return leave(l,r);
    unsigned boots=(unsigned)get(l->current+20,2),count=(unsigned)get(l->current+22,2);
    if(boots==TE_IDENTITY_BOOTS_MAX||count==TE_IDENTITY_IDS_MAX) return leave(l,TE_IDENTITY_EXHAUSTED);
    uint64_t lo,hi,mono;if((r=now(l,&lo,&hi,&mono))!=TE_IDENTITY_OK) return leave(l,r);
    uint8_t uuid[16];if(!l->config.entropy(l->config.entropy_context,uuid)||zero(uuid,16)) return leave(l,TE_IDENTITY_ENTROPY);
    uuid[6]=(uint8_t)((uuid[6]&15)|0x40);uuid[8]=(uint8_t)((uuid[8]&63)|0x80);
    if(reused(l->current,uuid)) return leave(l,TE_IDENTITY_REUSED);
    memcpy(l->scratch,l->current,sizeof l->scratch);
    if(!l->have_record) {
        memcpy(l->scratch,"TEIDLG01",8);put(l->scratch+8,1,2);put(l->scratch+10,TE_IDENTITY_HEADER_BYTES,2);
        put(l->scratch+12,TE_IDENTITY_RECORD_BYTES,4);strcpy((char *)l->scratch+24,l->node);
    }
    put(l->scratch+16,boots+count+1,4);put(l->scratch+20,boots+1,2);
    memcpy(l->scratch+BOOT_OFFSET+boots*16,uuid,16);
    put(l->scratch+96,lo,8);put(l->scratch+104,hi,8);put(l->scratch+112,lo,8);put(l->scratch+120,hi,8);
    if((r=persist(l,lo,hi))!=TE_IDENTITY_OK) return leave(l,r);
    uuid_text(uuid,l->boot);memcpy(out,l->boot,37);l->boot_monotonic=mono;l->last_sequence=0;l->state=TE_IDENTITY_ACTIVE;
    return leave(l,TE_IDENTITY_OK);
}
te_identity_result_t te_identity_reserve(te_identity_t *l,const char *node,const char *boot,const char *uuid,uint32_t sequence) {
    te_identity_result_t r=enter(l);if(r!=TE_IDENTITY_OK) return r;
    uint8_t candidate[16],boot_bytes[16];
    if(l->state!=TE_IDENTITY_ACTIVE||!node_valid(node)||!uuid_bytes(boot,boot_bytes)||!uuid_bytes(uuid,candidate)) return leave(l,TE_IDENTITY_INVALID);
    if(strcmp(node,l->node)||strcmp(boot,l->boot)) return leave(l,TE_IDENTITY_OWNER);
    if(!sequence||sequence<=l->last_sequence) return leave(l,TE_IDENTITY_SEQUENCE);
    if((r=audit(l))!=TE_IDENTITY_OK) return leave(l,r);
    unsigned count=(unsigned)get(l->current+22,2),boots=(unsigned)get(l->current+20,2);
    if(count==TE_IDENTITY_IDS_MAX) return leave(l,TE_IDENTITY_EXHAUSTED);
    if(reused(l->current,candidate)) return leave(l,TE_IDENTITY_REUSED);
    uint64_t lo,hi,mono;if((r=now(l,&lo,&hi,&mono))!=TE_IDENTITY_OK) return leave(l,r);
    memcpy(l->scratch,l->current,sizeof l->scratch);
    uint8_t *item=l->scratch+ITEM_OFFSET+count*24;
    put(item,boots-1,2);put(item+4,sequence,4);memcpy(item+8,candidate,16);
    put(l->scratch+16,boots+count+1,4);put(l->scratch+22,count+1,2);put(l->scratch+112,lo,8);put(l->scratch+120,hi,8);
    if((r=persist(l,lo,hi))!=TE_IDENTITY_OK) return leave(l,r);
    l->last_sequence=sequence;return leave(l,TE_IDENTITY_OK);
}
bool te_identity_reserve_callback(void *ctx,const char *node,const char *boot,const char *uuid,uint32_t sequence) {
    return te_identity_reserve(ctx,node,boot,uuid,sequence)==TE_IDENTITY_OK;
}
te_identity_result_t te_identity_generate(te_identity_t *l,uint32_t sequence,char out[37]) {
    if(out) memset(out,0,37);
    if(!l||!out) return fail(l,TE_IDENTITY_INVALID);
    if(l->state==TE_IDENTITY_FAILED) return TE_IDENTITY_LATCHED;
    if(l->state!=TE_IDENTITY_ACTIVE) return fail(l,TE_IDENTITY_STATE);
    uint8_t uuid[16];char candidate[37];
    if(!l->config.entropy(l->config.entropy_context,uuid)||zero(uuid,16)) return fail(l,TE_IDENTITY_ENTROPY);
    uuid[6]=(uint8_t)((uuid[6]&15)|0x40);uuid[8]=(uint8_t)((uuid[8]&63)|0x80);uuid_text(uuid,candidate);
    te_identity_result_t r=te_identity_reserve(l,l->node,l->boot,candidate,sequence);
    if(r==TE_IDENTITY_OK) memcpy(out,candidate,37);
    return r;
}
