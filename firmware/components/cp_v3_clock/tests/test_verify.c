#include "cp_v3_clock.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include <openssl/evp.h>
#include <openssl/ec.h>
#include <openssl/x509.h>
#include "generated.h"

static unsigned verified_calls;
static bool verify(void *ctx,const uint8_t spki[91],const uint8_t raw[64],const void *data,size_t n){
    (void)ctx;verified_calls++;
    const unsigned char *p=spki;EVP_PKEY *key=d2i_PUBKEY(NULL,&p,91);assert(key);
    ECDSA_SIG *sig=ECDSA_SIG_new();assert(sig);
    assert(ECDSA_SIG_set0(sig,BN_bin2bn(raw,32,NULL),BN_bin2bn(raw+32,32,NULL))==1);
    unsigned char der[80],*cursor=der;int len=i2d_ECDSA_SIG(sig,&cursor);assert(len>0&&len<=80);
    EVP_MD_CTX *md=EVP_MD_CTX_new();assert(md);
    bool ok=EVP_DigestVerifyInit(md,NULL,EVP_sha256(),NULL,key)==1&&EVP_DigestVerify(md,der,(size_t)len,data,n)==1;
    EVP_MD_CTX_free(md);EVP_PKEY_free(key);ECDSA_SIG_free(sig);return ok;
}
static bool accept(const char *body,uint64_t start,uint64_t end,cp_v3_time_t *out){
    return cp_v3_clock_verify(body,strlen(body),KEY,"test-key_1",NONCE,start,end,1,verify,NULL,out);
}
static void rejected(const char *body){
    cp_v3_time_t out={.utc_ms=1,.mono_ms=1,.uncertainty_ms=1,.clock_epoch=1};
    assert(!accept(body,1000,2000,&out));
    cp_v3_time_t empty={0};assert(!memcmp(&out,&empty,sizeof out));
}
static void replace_rejected(const char *from,const char *to){
    const char *found=strstr(BODY,from);assert(found);
    char changed[2048];size_t prefix=(size_t)(found-BODY);
    snprintf(changed,sizeof changed,"%.*s%s%s",(int)prefix,BODY,to,found+strlen(from));rejected(changed);
}
int main(void){
    cp_v3_time_t out;assert(accept(BODY,1000,2000,&out));assert(verified_calls==1);
    assert(out.utc_ms==1793577600000ULL&&out.mono_ms==1500&&out.clock_epoch==1&&out.uncertainty_ms==1502);
    assert(accept(BODY,1000,1000,&out)&&out.uncertainty_ms==1001);
    assert(accept(BODY,1000,6990,&out)&&out.uncertainty_ms==3999);
    assert(!accept(BODY,1000,7000,&out));assert(!accept(BODY,2000,1000,&out));
    assert(accept(BODY,UINT64_MAX-500,UINT64_MAX,&out));
    replace_rejected("1793577600000","1793577600001");
    replace_rejected("1793577600000","1793577600000.5");
    replace_rejected("1793577600000","1704067199999");
    replace_rejected("1793577600000","7258118400001");
    replace_rejected("1793577600000","1e999");
    replace_rejected("\"max_error_ms\":1000","\"max_error_ms\":0");
    replace_rejected("\"max_error_ms\":1000","\"max_error_ms\":3001");
    replace_rejected("\"max_error_ms\":1000","\"max_error_ms\":\"1000\"");
    replace_rejected("\"max_error_ms\":1000","\"max_error_ms\":1000,\"max_error_ms\":1000");
    replace_rejected("test-key_1","test-key_2");
    replace_rejected("cp-v3-signed-clock/1","cp-v3-signed-clock/2");
    replace_rejected("https://pulse.anend.net","https://evil.example");
    replace_rejected(NONCE,"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");
    replace_rejected("\"key_id\"","\"extra\"");
    replace_rejected("\"nonce\":","\"extra\":0,\"nonce\":");
    replace_rejected("test-key_1","test-key_1\\u0000suffix");
    replace_rejected("\"sig\":\"","\"sig\":\"=");
    char bad[2048];snprintf(bad,sizeof bad,"%s trailing",BODY);rejected(bad);
    snprintf(bad,sizeof bad,"[%s]",BODY);rejected(bad);
    strcpy(bad,BODY);char *s=strstr(bad,"\"sig\":\"")+7;s[0]=s[0]=='A'?'B':'A';rejected(bad);
    strcpy(bad,BODY);s=strstr(bad,"\"sig\":\"")+7;s[85]='B';rejected(bad);
    assert(!cp_v3_clock_verify(BODY,strlen(BODY),KEY,"test-key_1",NONCE,0,1,0,verify,NULL,&out));
    assert(!cp_v3_clock_verify(BODY,strlen(BODY),KEY,"test-key_1",NONCE,0,1,1,NULL,NULL,&out));
    assert(!cp_v3_clock_verify(BODY,strlen(BODY),OTHER_KEY,"test-key_1",NONCE,0,1,1,verify,NULL,&out));
    assert(!cp_v3_clock_verify(BODY,strlen(BODY)+1,KEY,"test-key_1",NONCE,0,1,1,verify,NULL,&out));
    char unterminated_key[33],unterminated_nonce[65];
    memset(unterminated_key,'a',sizeof unterminated_key);
    memset(unterminated_nonce,'a',sizeof unterminated_nonce);
    assert(!cp_v3_clock_verify(BODY,strlen(BODY),KEY,unterminated_key,NONCE,0,1,1,verify,NULL,&out));
    assert(!cp_v3_clock_verify(BODY,strlen(BODY),KEY,"test-key_1",unterminated_nonce,0,1,1,verify,NULL,&out));
    memset(bad,'[',500);memset(bad+500,']',500);bad[1000]=0;rejected(bad);
    rejected("{\"nested\":{}}");
    rejected("");rejected("null");rejected("{}");
    puts("signed clock: real WebCrypto/OpenSSL ECDSA parity and fail-closed bounds passed");return 0;
}
