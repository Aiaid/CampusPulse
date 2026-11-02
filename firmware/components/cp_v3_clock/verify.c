#include "cp_v3_clock.h"
#include "cp_settings.h"
#include "cJSON.h"
#include <inttypes.h>
#include <stdio.h>
#include <string.h>

static bool key_valid(const char *s) {
    if(!s)return false;
    size_t n=strnlen(s,33);if(!n||n>32)return false;
    for(size_t i=0;i<n;i++)if(!((s[i]>='A'&&s[i]<='Z')||
        (s[i]>='a'&&s[i]<='z')||(s[i]>='0'&&s[i]<='9')||s[i]=='_'||s[i]=='-'))return false;
    return true;
}
static bool nonce_valid(const char *s) {
    if(!s||strnlen(s,65)!=64)return false;
    for(size_t i=0;i<64;i++)if(!((s[i]>='0'&&s[i]<='9')||(s[i]>='a'&&s[i]<='f')))return false;
    return true;
}
static int digit(unsigned char c) {
    if(c>='A'&&c<='Z')return c-'A';
    if(c>='a'&&c<='z')return c-'a'+26;
    if(c>='0'&&c<='9')return c-'0'+52;
    if(c=='-')return 62;
    if(c=='_')return 63;
    return -1;
}
static bool signature_decode(const char *s,uint8_t out[64]) {
    if(!s||strlen(s)!=86)return false;
    uint32_t acc=0;unsigned bits=0;size_t used=0;
    for(size_t i=0;i<86;i++){
        int d=digit((unsigned char)s[i]);if(d<0)return false;
        acc=(acc<<6)|(unsigned)d;bits+=6;
        if(bits>=8){bits-=8;if(used>=64)return false;out[used++]=(uint8_t)(acc>>bits);}
    }
    return used==64&&bits==4&&(acc&15u)==0;
}
static bool text_equals(cJSON *v,const char *s) {
    return cJSON_IsString(v)&&v->valuestring&&!strcmp(v->valuestring,s);
}
static bool integer(cJSON *v,uint64_t low,uint64_t high,uint64_t *out) {
    if(!cJSON_IsNumber(v)||!(v->valuedouble>=(double)low&&v->valuedouble<=(double)high))return false;
    uint64_t n=(uint64_t)v->valuedouble;if((double)n!=v->valuedouble)return false;*out=n;return true;
}
bool cp_v3_clock_verify(const char *response,size_t bytes,const uint8_t pinned_spki[91],
    const char *key_id,const char nonce[65],uint64_t started,uint64_t ended,
    uint32_t epoch,cp_v3_clock_verify_fn verify,void *context,cp_v3_time_t *out) {
    if(!out)return false;
    memset(out,0,sizeof *out);
    if(!response||!bytes||bytes>CP_V3_CLOCK_RESPONSE_MAX||memchr(response,0,bytes)||
       !pinned_spki||!key_valid(key_id)||!nonce_valid(nonce)||!verify||!epoch||
       ended<started||ended-started>CP_V3_CLOCK_RTT_MAX_MS)return false;
    /* Embedded NUL escapes have ambiguous C-string semantics; the wire contract
     * needs no escapes at all, so reject them before parsing. */
    if(memchr(response,'\\',bytes))return false;
    /* Exactly one flat object: reject nested hostile input before cJSON can
     * recurse on the embedded task's bounded stack. Strings need no escapes. */
    bool quoted=false;unsigned depth=0;
    for(size_t i=0;i<bytes;i++){
        char c=response[i];
        if(c=='"'){quoted=!quoted;continue;}
        if(quoted)continue;
        if(c=='['||c==']')return false;
        if(c=='{'&&++depth!=1)return false;
        if(c=='}'){if(depth!=1)return false;depth--;}
    }
    if(quoted||depth)return false;
    char json[CP_V3_CLOCK_RESPONSE_MAX+1];memcpy(json,response,bytes);json[bytes]=0;
    cJSON *root=cJSON_ParseWithLengthOpts(json,bytes+1,NULL,true);
    if(!root)return false;
    static const char *names[]={"schema","audience","key_id","nonce","unix_ms","max_error_ms","sig"};
    unsigned seen=0;bool ok=cJSON_IsObject(root);cJSON *fields[7]={0};
    for(cJSON *item=root->child;ok&&item;item=item->next){
        unsigned i=0;for(;i<7;i++)if(item->string&&!strcmp(item->string,names[i]))break;
        if(i==7||(seen&(1u<<i))){ok=false;break;}seen|=1u<<i;fields[i]=item;
    }
    uint64_t utc=0,error=0;uint8_t signature[64];
    ok=ok&&seen==127&&text_equals(fields[0],"cp-v3-signed-clock/1")&&
       text_equals(fields[1],CP_API_ORIGIN)&&text_equals(fields[2],key_id)&&
       text_equals(fields[3],nonce)&&integer(fields[4],UINT64_C(1704067200000),UINT64_C(7258118400000),&utc)&&
       integer(fields[5],1,3000,&error)&&cJSON_IsString(fields[6])&&signature_decode(fields[6]->valuestring,signature);
    uint64_t rtt=ended-started;
    /* Whole-RTT midpoint interval; add rounded 500ppm timer error and 1ms
     * timestamp quantization. Includes asymmetry and arbitrary bounded delay. */
    uint64_t uncertainty=error+(rtt+1)/2+(rtt*500+999999)/1000000+1;
    ok=ok&&uncertainty<=CP_V3_CLOCK_UNCERTAINTY_MAX_MS;
    if(ok){
        char transcript[256];int n=snprintf(transcript,sizeof transcript,
            "cp-v3-signed-clock/1\n%s\n%s\n%s\n%" PRIu64 "\n%" PRIu64 "\n",
            CP_API_ORIGIN,key_id,nonce,utc,error);
        ok=n>0&&(size_t)n<sizeof transcript&&verify(context,pinned_spki,signature,transcript,(size_t)n);
    }
    cJSON_Delete(root);
    if(ok)*out=(cp_v3_time_t){.utc_ms=utc,.mono_ms=started+rtt/2,
        .clock_epoch=epoch,.uncertainty_ms=(uint32_t)uncertainty};
    return ok;
}
