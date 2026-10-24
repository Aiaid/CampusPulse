#include "cp_provision_security2.h"
#include "protocomm_security2.h"
#include <stdlib.h>
#include <string.h>
#include <stdatomic.h>
#include "mbedtls/sha512.h"
#include "mbedtls/bignum.h"
#include "sdkconfig.h"
#if !CONFIG_ESP_PROTOCOMM_SUPPORT_SECURITY_VERSION_2 || CONFIG_ESP_PROTOCOMM_SUPPORT_SECURITY_VERSION_1 || CONFIG_ESP_PROTOCOMM_SUPPORT_SECURITY_VERSION_0
#error "Short PIN provisioning requires Security 2 only; no insecure downgrade"
#endif
#if CONFIG_LOG_MAXIMUM_LEVEL > 3
#error "Pinned IDF SRP DEBUG logs expose secrets; provisioning builds must cap logging at INFO"
#endif
/* The RFC 3526 3072-bit prime used by RFC 5054 / ESP-IDF ESP_NG_3072.
 * A protocol group parameter, not a copied cryptographic implementation. */
static const char prime_hex[] =
    "FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DD"
    "EF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED"
    "EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3DC2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F"
    "83655D23DCA3AD961C62F356208552BB9ED529077096966D670C354E4ABC9804F1746C08CA18217C32905E462E36CE3B"
    "E39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF6955817183995497CEA956AE515D2261898FA0510"
    "15728E5A8AAAC42DAD33170D04507A33A85521ABDF1CBA64ECFB850458DBEF0A8AEA71575D060C7DB3970F85A6E1E4C7"
    "ABF5AE8CDB0933D71E8C94E04A25619DCEE3D2261AD2EE6BF12FFA06D98A0864D87602733EC86A64521F2B18177B200C"
    "BBE117577A615D6C770988C0BAD946E208E24FA074E5AB3143DB5BFCE0FD108E4B82D120A93AD2CAFFFFFFFFFFFFFFFF";
static unsigned nibble(char c) { return c<='9'?(unsigned)(c-'0'):(unsigned)(c-'A'+10); }
bool cp_provision_sec2_verifier(const char pin[9],const uint8_t salt[16],uint8_t verifier[384]) {
    if(!pin||strlen(pin)!=8||!salt||!verifier)return false;
    for(unsigned i=0;i<8;i++)if(pin[i]<'0'||pin[i]>'9')return false;
    uint8_t identity[sizeof(CP_PROVISION_USERNAME)-1+1+8],inner[64]={0},outer[80]={0},xbytes[64]={0};
    memcpy(identity,CP_PROVISION_USERNAME,sizeof(CP_PROVISION_USERNAME)-1);identity[sizeof(CP_PROVISION_USERNAME)-1]=':';memcpy(identity+sizeof(CP_PROVISION_USERNAME),pin,8);
    int err=mbedtls_sha512(identity,sizeof identity,inner,0);
    memcpy(outer,salt,16);memcpy(outer+16,inner,64);
    if(!err)err=mbedtls_sha512(outer,sizeof outer,xbytes,0);
    mbedtls_mpi n,g,x,v;mbedtls_mpi_init(&n);mbedtls_mpi_init(&g);mbedtls_mpi_init(&x);mbedtls_mpi_init(&v);
    if(!err)err=mbedtls_mpi_read_string(&n,16,prime_hex);
    if(!err)err=mbedtls_mpi_lset(&g,5);
    if(!err)err=mbedtls_mpi_read_binary(&x,xbytes,sizeof xbytes);
    if(!err)err=mbedtls_mpi_exp_mod(&v,&g,&x,&n,NULL);
    if(!err)err=mbedtls_mpi_write_binary(&v,verifier,384);
    mbedtls_mpi_free(&n);mbedtls_mpi_free(&g);mbedtls_mpi_free(&x);mbedtls_mpi_free(&v);
    volatile uint8_t *p=identity;for(size_t i=0;i<sizeof identity;i++)p[i]=0;
    p=inner;for(size_t i=0;i<sizeof inner;i++)p[i]=0;p=outer;for(size_t i=0;i<sizeof outer;i++)p[i]=0;p=xbytes;for(size_t i=0;i<sizeof xbytes;i++)p[i]=0;
    if(err)memset(verifier,0,384);
    return err==0;
}
typedef struct { const uint8_t *p; size_t n; } slice_t;
typedef struct { slice_t bytes[23]; uint32_t ints[23], seen; } fields_t;
static bool varint(slice_t *s, uint32_t *out) {
    uint32_t n=0;
    for(unsigned i=0;i<5;i++) {
        if(!s->n) return false;
        uint8_t b=*s->p++;s->n--;
        if(i==4 && (b&0xf0)) return false;
        n|=(uint32_t)(b&127)<<(7*i);
        if(!(b&128)) { if(i && !b)return false;*out=n;return true; }
    }
    return false;
}
static bool fields(slice_t s, fields_t *f, uint32_t allowed_int, uint32_t allowed_bytes) {
    memset(f,0,sizeof *f);
    while(s.n) {
        uint32_t tag;if(!varint(&s,&tag))return false;
        unsigned id=tag>>3,type=tag&7;if(!id||id>=23||(f->seen&(1u<<id)))return false;
        f->seen|=1u<<id;
        if(type==0 && (allowed_int&(1u<<id))) { if(!varint(&s,&f->ints[id]))return false; }
        else if(type==2 && (allowed_bytes&(1u<<id))) { uint32_t n;if(!varint(&s,&n)||n>s.n)return false;f->bytes[id]=(slice_t){s.p,n};s.p+=n;s.n-=n; }
        else return false;
    }
    return true;
}
bool cp_provision_sec2_frame(const uint8_t *data,size_t length,unsigned *command) {
    if(!data||!length||length>512||!command)return false;
    fields_t outer,sec,body;
    if(!fields((slice_t){data,length},&outer,1u<<2,1u<<12)||outer.seen!=((1u<<2)|(1u<<12))||outer.ints[2]!=2)return false;
    if(!fields(outer.bytes[12],&sec,1u<<1,(1u<<20)|(1u<<22)))return false;
    unsigned type=sec.ints[1];
    if(type==0 && (sec.seen&~(1u<<1))==(1u<<20)) {
        if(!fields(sec.bytes[20],&body,0,(1u<<1)|(1u<<2))||body.seen!=((1u<<1)|(1u<<2)))return false;
        if(body.bytes[1].n!=sizeof(CP_PROVISION_USERNAME)-1||memcmp(body.bytes[1].p,CP_PROVISION_USERNAME,sizeof(CP_PROVISION_USERNAME)-1)||body.bytes[2].n!=384)return false;
        unsigned any=0;int cmp=0;
        for(unsigned i=0;i<384;i++) { unsigned a=body.bytes[2].p[i],n=(nibble(prime_hex[2*i])<<4)|nibble(prime_hex[2*i+1]);any|=a;if(!cmp&&a!=n)cmp=a<n?-1:1; }
        if(!any||cmp>=0)return false;
    } else if(type==2 && sec.seen==((1u<<1)|(1u<<22))) {
        if(!fields(sec.bytes[22],&body,0,1u<<1)||body.seen!=(1u<<1)||body.bytes[1].n!=64)return false;
    } else return false;
    *command=type;return true;
}
typedef struct {
    protocomm_security_handle_t sdk;
    atomic_flag busy;
    bool connected,poisoned;
    uint32_t id;
    unsigned phase;
} guarded_t;
static cp_provision_security_hooks_t gate;
static bool enter(guarded_t *g) {
    if(!g||g->poisoned||atomic_flag_test_and_set(&g->busy))return false;
    if(!gate.enter()){atomic_flag_clear(&g->busy);return false;}return true;
}
static void leave(guarded_t *g){gate.leave();atomic_flag_clear(&g->busy);}
static void free_output(uint8_t **p,ssize_t *n){if(p&&*p){volatile uint8_t *v=*p;for(ssize_t i=0;n&&i<*n;i++)v[i]=0;free(*p);*p=NULL;}if(n)*n=0;}
static esp_err_t init(protocomm_security_handle_t *handle) {
    if(!handle)return ESP_ERR_INVALID_ARG;
    guarded_t *g=calloc(1,sizeof *g);if(!g)return ESP_ERR_NO_MEM;
    atomic_flag_clear(&g->busy);esp_err_t err=protocomm_security2.init(&g->sdk);if(err!=ESP_OK){free(g);return err;}*handle=g;return ESP_OK;
}
static esp_err_t cleanup(protocomm_security_handle_t handle) {
    guarded_t *g=handle;if(!g)return ESP_OK;
    /* SDK cmd0 failures can free srp_hd without clearing its private pointer.
     * Quarantine that one context until reboot; never double-free or reuse it. */
    if(!g->poisoned)protocomm_security2.cleanup(g->sdk);
    free(g);return ESP_OK;
}
static esp_err_t new_session(protocomm_security_handle_t handle,uint32_t id) {
    guarded_t *g=handle;
    if(!g||g->poisoned||atomic_flag_test_and_set(&g->busy))return ESP_ERR_INVALID_STATE;
    esp_err_t err=ESP_ERR_INVALID_STATE;
    if(!g->connected){err=protocomm_security2.new_transport_session(g->sdk,id);if(err==ESP_OK){g->connected=true;g->id=id;g->phase=0;}}
    atomic_flag_clear(&g->busy);return err;
}
static esp_err_t close_session(protocomm_security_handle_t handle,uint32_t id) {
    guarded_t *g=handle;if(!g||g->poisoned||atomic_flag_test_and_set(&g->busy))return ESP_ERR_INVALID_STATE;
    esp_err_t err=ESP_OK;
    if(g->connected&&g->id==id){err=protocomm_security2.close_transport_session(g->sdk,g->id);g->connected=false;g->phase=0;}
    atomic_flag_clear(&g->busy);return err;
}
static esp_err_t request(protocomm_security_handle_t handle,const void *params,uint32_t id,const uint8_t *in,ssize_t len,uint8_t **out,ssize_t *outlen,void *priv) {
    if(!out||!outlen)return ESP_ERR_INVALID_ARG;
    *out=NULL;*outlen=0;guarded_t *g=handle;
    if(!enter(g))return ESP_ERR_INVALID_STATE;
    unsigned command=99;esp_err_t err=ESP_ERR_INVALID_ARG;
    if(!g->connected||g->id!=id||len<=0||!cp_provision_sec2_frame(in,(size_t)len,&command)||command!=(g->phase==0?0u:2u)||g->phase>1){gate.failure();leave(g);return err;}
    err=protocomm_security2.security_req_handler(g->sdk,params,id,in,len,out,outlen,priv);
    if(err!=ESP_OK){
        free_output(out,outlen);gate.failure();
        if(command==0){g->poisoned=true;gate.fatal();}
        else {protocomm_security2.close_transport_session(g->sdk,id);g->connected=false;g->phase=0;}
    }else if(*outlen<=0||*outlen>512){free_output(out,outlen);g->poisoned=true;gate.fatal();err=ESP_ERR_INVALID_SIZE;}
    else g->phase++;
    leave(g);return err;
}
static esp_err_t crypt(bool encrypt,protocomm_security_handle_t handle,uint32_t id,const uint8_t *in,ssize_t len,uint8_t **out,ssize_t *outlen) {
    if(!out||!outlen)return ESP_ERR_INVALID_ARG;
    *out=NULL;*outlen=0;guarded_t *g=handle;
    if(!enter(g))return ESP_ERR_INVALID_STATE;
    if(!in||len<(encrypt?1:17)||len>(encrypt?496:512)||!g->connected||g->id!=id||g->phase!=2){gate.failure();leave(g);return ESP_ERR_INVALID_SIZE;}
    esp_err_t err=encrypt?protocomm_security2.encrypt(g->sdk,id,in,len,out,outlen):protocomm_security2.decrypt(g->sdk,id,in,len,out,outlen);
    if(err!=ESP_OK){free_output(out,outlen);gate.failure();protocomm_security2.close_transport_session(g->sdk,id);g->connected=false;g->phase=0;}
    leave(g);return err;
}
static esp_err_t encrypt(protocomm_security_handle_t h,uint32_t id,const uint8_t *in,ssize_t n,uint8_t **out,ssize_t *outn){return crypt(true,h,id,in,n,out,outn);}
static esp_err_t decrypt(protocomm_security_handle_t h,uint32_t id,const uint8_t *in,ssize_t n,uint8_t **out,ssize_t *outn){return crypt(false,h,id,in,n,out,outn);}
static const protocomm_security_t security={.ver=2,.patch_ver=1,.init=init,.cleanup=cleanup,.new_transport_session=new_session,.close_transport_session=close_session,.security_req_handler=request,.encrypt=encrypt,.decrypt=decrypt};
const protocomm_security_t *cp_provision_security2(const cp_provision_security_hooks_t *hooks){gate=*hooks;return &security;}
