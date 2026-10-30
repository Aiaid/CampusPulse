#include "cp_provision_guard.h"
#include "mbedtls/md.h"
#include "mbedtls/sha256.h"
#include <string.h>

static void wipe(void *p, size_t n) { volatile unsigned char *v = p; while (n--) *v++ = 0; }
static bool lower_hex(char ch) { return (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f'); }
bool cp_provision_uuid_v4(const char *value) {
    if (!value || strlen(value) != 36) return false;
    for (unsigned i = 0; i < 36; i++) {
        if (i == 8 || i == 13 || i == 18 || i == 23) { if (value[i] != '-') return false; }
        else if (!lower_hex(value[i])) return false;
    }
    return value[14] == '4' && (value[19] == '8' || value[19] == '9' || value[19] == 'a' || value[19] == 'b');
}
static bool derive(const char *proof, const char *domain, const uint8_t *context, size_t length, uint8_t out[32]) {
    uint8_t message[128] = {0};
    const size_t domain_len = strlen(domain);
    if (domain_len + 1 + length > sizeof(message)) return false;
    memcpy(message, domain, domain_len); memcpy(message + domain_len + 1, context, length);
    int err = mbedtls_md_hmac(mbedtls_md_info_from_type(MBEDTLS_MD_SHA256),
                             (const unsigned char *)proof, 32, message,
                             domain_len + 1 + length, out);
    wipe(message, sizeof(message)); if (err) wipe(out,32); return err == 0;
}
bool cp_provision_session_nonce(const char *proof,const uint8_t *context,size_t length,char nonce[33]) {
    if(!proof||strlen(proof)!=32||!context||length<16||length>64||!nonce)return false;
    for(unsigned i=0;i<32;i++)if(!lower_hex(proof[i]))return false;
    uint8_t digest[32]={0};bool ok=derive(proof,"campuspulse/setup/nonce/v2",context,length,digest);
    if(ok){static const char hex[]="0123456789abcdef";for(unsigned i=0;i<16;i++){nonce[2*i]=hex[digest[i]>>4];nonce[2*i+1]=hex[digest[i]&15];}nonce[32]=0;}
    wipe(digest,sizeof digest);if(!ok)wipe(nonce,33);return ok;
}
bool cp_provision_settings_digest(const cp_settings_t *s, uint8_t out[32]) {
    if (!s || !out) return false;
    mbedtls_sha256_context ctx; mbedtls_sha256_init(&ctx);
    uint8_t version[] = { (uint8_t)(s->version >> 24), (uint8_t)(s->version >> 16), (uint8_t)(s->version >> 8), (uint8_t)s->version };
    int err = mbedtls_sha256_starts(&ctx, 0);
    if (!err) err = mbedtls_sha256_update(&ctx, version, sizeof(version));
    const char *fields[] = { s->node_id, s->ssid, s->password, s->device_token, s->api_origin, s->eap_username, s->eap_identity, s->eap_password, s->mqtt_uri,s->mqtt_username,s->mqtt_password,s->mqtt_namespace };
    const size_t caps[] = { sizeof(s->node_id), sizeof(s->ssid), sizeof(s->password), sizeof(s->device_token), sizeof(s->api_origin), sizeof(s->eap_username), sizeof(s->eap_identity), sizeof(s->eap_password), sizeof(s->mqtt_uri),sizeof(s->mqtt_username),sizeof(s->mqtt_password),sizeof(s->mqtt_namespace) };
    for (unsigned i = 0; !err && i < sizeof(fields)/sizeof(fields[0]); i++) {
        size_t n = strnlen(fields[i], caps[i]); if (n == caps[i]) { err = -1; break; }
        uint8_t length[] = { (uint8_t)(n >> 8), (uint8_t)n };
        err = mbedtls_sha256_update(&ctx, length, sizeof(length));
        if (!err) err = mbedtls_sha256_update(&ctx, (const unsigned char *)fields[i], n);
    }
    uint8_t security[]={s->wifi_security>>24,s->wifi_security>>16,s->wifi_security>>8,s->wifi_security};
    if (!err) err=mbedtls_sha256_update(&ctx,security,sizeof security);
    if (!err) err = mbedtls_sha256_finish(&ctx, out);
    mbedtls_sha256_free(&ctx); if (err) wipe(out, 32); return err == 0;
}
bool cp_provision_digest_equal(const uint8_t a[32], const uint8_t b[32]) {
    unsigned diff = 0; for (unsigned i = 0; i < 32; i++) diff |= a[i] ^ b[i]; return diff == 0;
}

bool cp_provision_candidate_digest(const cp_settings_t *settings,bool reuse_saved,uint32_t generation,uint8_t out[32]) {
    uint8_t message[41]={2};message[1]=reuse_saved?1:0;
    message[2]=(uint8_t)(generation>>24);message[3]=(uint8_t)(generation>>16);message[4]=(uint8_t)(generation>>8);message[5]=(uint8_t)generation;
    bool ok=(!reuse_saved||generation>0)&&cp_provision_settings_digest(settings,message+9);
    if(ok){mbedtls_sha256_context ctx;mbedtls_sha256_init(&ctx);int e=mbedtls_sha256_starts(&ctx,0);
        if(!e)e=mbedtls_sha256_update(&ctx,message,sizeof message);
        if(!e)e=mbedtls_sha256_finish(&ctx,out);
        mbedtls_sha256_free(&ctx);ok=e==0;}
    wipe(message,sizeof message);if(!ok)wipe(out,32);return ok;
}
