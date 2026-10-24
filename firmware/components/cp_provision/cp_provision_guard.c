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
bool cp_provision_session_secrets(const char *proof, const uint8_t *context, size_t length, char pin[9], char ap[13], char nonce[33], uint8_t salt[16]) {
    if (!proof || strlen(proof) != 32 || !context || length < 16 || length > 64 || !pin || !ap || !nonce || !salt) return false;
    for (unsigned i = 0; i < 32; i++) if (!lower_hex(proof[i])) return false;
    uint8_t digest[32] = {0}; bool ok = derive(proof,"campuspulse/setup/pin/v2",context,length,digest);
    bool chosen = false;
    /* Rejection sampling removes modulo bias and preserves leading zeros. */
    for (unsigned i=0;ok && !chosen && i<8;i++) {
        const uint8_t *p=digest+4*i;
        uint32_t n=((uint32_t)p[0]<<24)|((uint32_t)p[1]<<16)|((uint32_t)p[2]<<8)|p[3];
        if (n>=4200000000u) continue;
        n%=100000000u; for (int j=7;j>=0;j--) { pin[j]=(char)('0'+n%10); n/=10; } pin[8]=0;chosen=true;
    }
    ok=ok && chosen && derive(proof,"campuspulse/setup/ap-password/v2",context,length,digest);
    if(ok) { static const char alphabet[]="23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
        for(unsigned i=0;i<12;i++) { unsigned bit=i*5,index=bit/8,shift=bit%8; unsigned v=(unsigned)digest[index]<<8|digest[index+1]; ap[i]=alphabet[(v>>(11-shift))&31]; } ap[12]=0; }
    ok=ok && derive(proof,"campuspulse/setup/nonce/v2",context,length,digest);
    if(ok) { static const char hex[]="0123456789abcdef";for(unsigned i=0;i<16;i++){nonce[2*i]=hex[digest[i]>>4];nonce[2*i+1]=hex[digest[i]&15];}nonce[32]=0; }
    ok=ok && derive(proof,"campuspulse/setup/srp-salt/v2",context,length,digest);
    if(ok)memcpy(salt,digest,16);
    wipe(digest,sizeof digest);if(!ok){wipe(pin,9);wipe(ap,13);wipe(nonce,33);wipe(salt,16);}return ok;
}
bool cp_provision_settings_digest(const cp_settings_t *s, uint8_t out[32]) {
    if (!s || !out) return false;
    mbedtls_sha256_context ctx; mbedtls_sha256_init(&ctx);
    uint8_t version[] = { (uint8_t)(s->version >> 24), (uint8_t)(s->version >> 16), (uint8_t)(s->version >> 8), (uint8_t)s->version };
    int err = mbedtls_sha256_starts(&ctx, 0);
    if (!err) err = mbedtls_sha256_update(&ctx, version, sizeof(version));
    const char *fields[] = { s->node_id, s->ssid, s->password, s->device_token, s->api_origin };
    const size_t caps[] = { sizeof(s->node_id), sizeof(s->ssid), sizeof(s->password), sizeof(s->device_token), sizeof(s->api_origin) };
    for (unsigned i = 0; !err && i < sizeof(fields)/sizeof(fields[0]); i++) {
        size_t n = strnlen(fields[i], caps[i]); if (n == caps[i]) { err = -1; break; }
        uint8_t length[] = { (uint8_t)(n >> 8), (uint8_t)n };
        err = mbedtls_sha256_update(&ctx, length, sizeof(length));
        if (!err) err = mbedtls_sha256_update(&ctx, (const unsigned char *)fields[i], n);
    }
    if (!err) err = mbedtls_sha256_finish(&ctx, out);
    mbedtls_sha256_free(&ctx); if (err) wipe(out, 32); return err == 0;
}
bool cp_provision_digest_equal(const uint8_t a[32], const uint8_t b[32]) {
    unsigned diff = 0; for (unsigned i = 0; i < 32; i++) diff |= a[i] ^ b[i]; return diff == 0;
}
