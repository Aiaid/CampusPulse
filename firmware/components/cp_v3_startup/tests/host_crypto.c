/* Host adapter uses OpenSSL's actual EC parsing/public-point validation. ESP
 * builds compile/link startup_nvs.c against the actual ESP-IDF mbedTLS API. */
#include "mbedtls/pk.h"
#include <openssl/evp.h>
#include <openssl/x509.h>
#include <openssl/core_names.h>
#include <string.h>
void mbedtls_pk_init(mbedtls_pk_context *p) { memset(p, 0, sizeof *p); }
void mbedtls_pk_free(mbedtls_pk_context *p) { memset(p, 0, sizeof *p); }
int mbedtls_pk_parse_public_key(mbedtls_pk_context *p, const unsigned char *bytes, size_t n) {
    const unsigned char *cursor = bytes;
    EVP_PKEY *key = d2i_PUBKEY(NULL, &cursor, (long)n);
    if (!key || cursor != bytes + n) { EVP_PKEY_free(key); return -1; }
    EVP_PKEY_CTX *context = EVP_PKEY_CTX_new(key, NULL);
    char group[80] = {0}; size_t length = 0;
    int valid = context && EVP_PKEY_public_check(context) == 1;
    p->type = EVP_PKEY_is_a(key, "EC") ? MBEDTLS_PK_ECKEY : 0;
    if (EVP_PKEY_get_utf8_string_param(key, OSSL_PKEY_PARAM_GROUP_NAME, group, sizeof group, &length) == 1 &&
        !strcmp(group, "prime256v1")) p->ec.grp.id = MBEDTLS_ECP_DP_SECP256R1;
    p->ec.Q.valid = valid;
    EVP_PKEY_CTX_free(context); EVP_PKEY_free(key);
    return valid ? 0 : -1;
}
int mbedtls_pk_get_type(const mbedtls_pk_context *p) { return p->type; }
int mbedtls_ecp_check_pubkey(const mbedtls_ecp_group *g, const mbedtls_ecp_point *q) {
    return g->id == MBEDTLS_ECP_DP_SECP256R1 && q->valid ? 0 : -1;
}
