#include "nvs_store.h"
#include "nvs.h"
#include <string.h>
#define NS "cpv3stats1"
static void key(char kind,unsigned i,char out[4]) { out[0]=kind; out[1]=(char)('0'+i/10); out[2]=(char)('0'+i%10); out[3]=0; }
/* 0 absent, 1 valid blob, 2 wrong type/size, -1 I/O. */
static int get(nvs_handle_t h,const char *k,void *out,size_t cap,size_t *len) {
    nvs_type_t type; esp_err_t e=nvs_find_key(h,k,&type); *len=0;
    if(e==ESP_ERR_NVS_NOT_FOUND) return 0;
    if(e!=ESP_OK) return -1;
    if(type!=NVS_TYPE_BLOB) return 2;
    size_t n=0; e=nvs_get_blob(h,k,NULL,&n);
    if(e==ESP_ERR_NVS_TYPE_MISMATCH || (e==ESP_OK && (!n || n>cap))) return 2;
    if(e!=ESP_OK) return -1;
    size_t want=n; e=nvs_get_blob(h,k,out,&n);
    if(e!=ESP_OK || n!=want) return -1;
    *len=n; return 1;
}
static int load(void *ctx,unsigned slot,void *out,size_t cap,size_t *len) {
    te_nvs_store_t *s=ctx; nvs_handle_t h; char k[4]; uint8_t tomb[CP_V3_QUEUE_TOMBSTONE_BYTES]; size_t n=0;
    if(!s || slot>=CP_V3_QUEUE_SLOTS || !out || !len) return -1;
    *len=0; if(s->uncertain&(1u<<slot)) return 2;
    esp_err_t e=nvs_open(NS,NVS_READONLY,&h);
    if(e==ESP_ERR_NVS_NOT_FOUND) return 0;
    if(e!=ESP_OK) return -1;
    key('t',slot,k); int t=get(h,k,tomb,sizeof tomb,&n);
    if(t<0) { nvs_close(h); return -1; }
    if(t==2) { nvs_close(h); return 2; }
    if(t==1) {
        cp_v3_queue_tombstone_t decoded;
        if(n!=sizeof tomb || !cp_v3_queue_tombstone_decode(tomb,n,&decoded) || cap<n) { nvs_close(h); return 2; }
        if(!s->hash) { memcpy(out,tomb,n); *len=n; nvs_close(h); return 4; }
        key('q',slot,k); size_t qlen=0;
        int qr=get(h,k,out,cap<TE_NVS_RECORD_MAX?cap:TE_NVS_RECORD_MAX,&qlen); nvs_close(h);
        if(qr<0) return -1;
        if(qr==0) { memcpy(out,tomb,n); *len=n; return 3; }
        cp_v3_queue_tombstone_t identity;
        if(qr==1 && cp_v3_queue_record_check(out,qlen,slot,s->hash,s->hash_context,&identity) && identity.ordinal>decoded.ordinal) {
            *len=qlen; return 1;
        }
        memcpy(out,tomb,n); *len=n; return 4;
    }
    key('q',slot,k); int r=get(h,k,out,cap<TE_NVS_RECORD_MAX?cap:TE_NVS_RECORD_MAX,len); nvs_close(h); return r;
}
static bool has_space(size_t len) {
    nvs_stats_t stats;
    return nvs_get_stats(NULL,&stats)==ESP_OK && stats.available_entries>=TE_NVS_FREE_ENTRY_FLOOR+(len+31)/32+4;
}
static bool store(void *ctx,unsigned slot,const void *bytes,size_t len) {
    te_nvs_store_t *s=ctx; size_t got=0; nvs_handle_t h; char k[4];
    if(!s || !bytes || !len || len>TE_NVS_RECORD_MAX || slot>=CP_V3_QUEUE_SLOTS) return false;
    int before=load(s,slot,s->compare,sizeof s->compare,&got);
    if(before!=0 && before!=3) return false;
    if(before==3) {
        cp_v3_queue_tombstone_t old, next;
        if(!s->hash || !cp_v3_queue_tombstone_decode(s->compare,got,&old) ||
           !cp_v3_queue_record_check(bytes,len,slot,s->hash,s->hash_context,&next) || next.ordinal<=old.ordinal) return false;
    }
    unsigned occupied=0;
    for(unsigned i=0;i<CP_V3_QUEUE_SLOTS;i++) {
        int r=load(s,i,s->compare,sizeof s->compare,&got);
        if(r<0) return false;
        if(r) occupied++;
    }
    if(occupied-(before==3?1u:0u)>=TE_NVS_MAX_LIVE || !has_space(len)) return false;
    s->uncertain|=(uint16_t)(1u<<slot);
    if(nvs_open(NS,NVS_READWRITE,&h)!=ESP_OK) return false;
    key('q',slot,k); esp_err_t e=nvs_set_blob(h,k,bytes,len);
    if(e==ESP_OK) e=nvs_commit(h);
    if(e==ESP_OK && before==3) {
        key('q',slot,k); size_t verify_len=0;
        int r=get(h,k,s->compare,sizeof s->compare,&verify_len); cp_v3_queue_tombstone_t identity;
        if(r!=1 || verify_len!=len || memcmp(bytes,s->compare,len) ||
           !cp_v3_queue_record_check(s->compare,verify_len,slot,s->hash,s->hash_context,&identity)) e=ESP_FAIL;
        if(e==ESP_OK) { key('t',slot,k); e=nvs_erase_key(h,k); if(e==ESP_OK) e=nvs_commit(h); }
    }
    nvs_close(h); if(e!=ESP_OK) return false;
    s->uncertain&=(uint16_t)~(1u<<slot);
    int r=load(s,slot,s->compare,sizeof s->compare,&got);
    if(r!=1 || got!=len || memcmp(bytes,s->compare,len)) { s->uncertain|=(uint16_t)(1u<<slot); return false; }
    return true;
}
static bool reclaim(void *ctx,unsigned slot,const void *bytes,size_t len) {
    te_nvs_store_t *s=ctx; size_t got=0; nvs_handle_t h; char k[4];
    if(!s || !bytes || !len || len>TE_NVS_RECORD_MAX || slot>=CP_V3_QUEUE_SLOTS ||
       load(s,slot,s->compare,sizeof s->compare,&got)!=1 || got!=len || memcmp(bytes,s->compare,len)) return false;
    s->uncertain|=(uint16_t)(1u<<slot);
    if(nvs_open(NS,NVS_READWRITE,&h)!=ESP_OK) return false;
    /* If a previous transition committed q but failed to retire t, remove t
     * while the verified newer q still exists; never erase q first. */
    key('t',slot,k); nvs_type_t type; esp_err_t e=nvs_find_key(h,k,&type);
    if(e==ESP_OK) { e=nvs_erase_key(h,k); if(e==ESP_OK) e=nvs_commit(h); }
    else if(e==ESP_ERR_NVS_NOT_FOUND) e=ESP_OK;
    if(e==ESP_OK) { key('q',slot,k); e=nvs_erase_key(h,k); }
    if(e==ESP_OK) e=nvs_commit(h);
    nvs_close(h); if(e!=ESP_OK) return false;
    s->uncertain&=(uint16_t)~(1u<<slot);
    if(load(s,slot,s->compare,sizeof s->compare,&got)!=0) { s->uncertain|=(uint16_t)(1u<<slot); return false; }
    return true;
}
bool te_nvs_store_expire(void *ctx,unsigned slot,const void *bytes,size_t len,const cp_v3_queue_tombstone_t *t) {
    te_nvs_store_t *s=ctx; size_t got=0; nvs_handle_t h; char k[4]; uint8_t encoded[CP_V3_QUEUE_TOMBSTONE_BYTES];
    cp_v3_queue_tombstone_t identity;
    if(!s || !s->hash || !bytes || !len || len>TE_NVS_RECORD_MAX || slot>=CP_V3_QUEUE_SLOTS || !t ||
       !cp_v3_queue_tombstone_encode(t,encoded,sizeof encoded) ||
       !cp_v3_queue_record_check(bytes,len,slot,s->hash,s->hash_context,&identity) ||
       identity.ordinal!=t->ordinal || identity.source_expires_at_ms!=t->source_expires_at_ms ||
       identity.body_bytes!=t->body_bytes || strcmp(identity.body_sha256,t->body_sha256) ||
       memcmp(identity.record_sha256,t->record_sha256,32) ||
       load(s,slot,s->compare,sizeof s->compare,&got)!=1 || got!=len || memcmp(bytes,s->compare,len) || !has_space(sizeof encoded)) return false;
    s->uncertain|=(uint16_t)(1u<<slot);
    if(nvs_open(NS,NVS_READWRITE,&h)!=ESP_OK) return false;
    key('t',slot,k); uint8_t previous[CP_V3_QUEUE_TOMBSTONE_BYTES]; size_t previous_len=0;
    int prior=get(h,k,previous,sizeof previous,&previous_len); esp_err_t e=ESP_OK;
    if(prior==1) {
        cp_v3_queue_tombstone_t old, current; size_t qlen=0;
        if(!cp_v3_queue_tombstone_decode(previous,previous_len,&old)) e=ESP_FAIL;
        if(e==ESP_OK) {
            key('q',slot,k); int qr=get(h,k,s->compare,sizeof s->compare,&qlen);
            if(qr!=1 || qlen!=len || memcmp(s->compare,bytes,len) ||
               !cp_v3_queue_record_check(s->compare,qlen,slot,s->hash,s->hash_context,&current) ||
               current.ordinal<=old.ordinal) e=ESP_FAIL;
        }
        if(e==ESP_OK) { key('t',slot,k); e=nvs_erase_key(h,k); if(e==ESP_OK) e=nvs_commit(h); }
        if(e==ESP_OK) { nvs_type_t type; e=nvs_find_key(h,k,&type)==ESP_ERR_NVS_NOT_FOUND?ESP_OK:ESP_FAIL; }
    } else if(prior!=0) e=ESP_FAIL;
    if(e!=ESP_OK) { nvs_close(h); return false; }
    key('t',slot,k);
    e=nvs_set_blob(h,k,encoded,sizeof encoded);
    if(e==ESP_OK) e=nvs_commit(h);
    if(e==ESP_OK) { uint8_t check[CP_V3_QUEUE_TOMBSTONE_BYTES]; size_t n=sizeof check;
        e=nvs_get_blob(h,k,check,&n); if(e==ESP_OK && (n!=sizeof check || memcmp(encoded,check,n))) e=ESP_FAIL; }
    if(e==ESP_OK) { key('q',slot,k); e=nvs_erase_key(h,k); if(e==ESP_OK) e=nvs_commit(h); }
    nvs_close(h); if(e!=ESP_OK) return false;
    s->uncertain&=(uint16_t)~(1u<<slot);
    int r=load(s,slot,s->compare,sizeof s->compare,&got);
    if(r!=3 || got!=sizeof encoded || memcmp(s->compare,encoded,got)) { s->uncertain|=(uint16_t)(1u<<slot); return false; }
    return true;
}
bool te_nvs_store_set_hash(te_nvs_store_t *s,cp_v3_sha256_fn hash,void *context) {
    if(!s || !hash) return false;
    s->hash=hash; s->hash_context=context; return true;
}
bool te_nvs_store_prepare(te_nvs_store_t *s,cp_v3_queue_store_t *out) {
    if(!s || !out) return false;
    memset(s,0,sizeof *s); *out=(cp_v3_queue_store_t){s,load,store,reclaim}; return true;
}
