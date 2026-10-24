#pragma once
/* Host-only standard-crypto adapter. Production uses ESP-IDF mbedTLS. */
#include <openssl/hmac.h>
#include <openssl/evp.h>
typedef int mbedtls_md_info_t;
#define MBEDTLS_MD_SHA256 1
static inline const mbedtls_md_info_t *mbedtls_md_info_from_type(int type) { static const int sha256 = 1; return type == 1 ? &sha256 : NULL; }
static inline int mbedtls_md_hmac(const mbedtls_md_info_t *type, const unsigned char *key, size_t klen, const unsigned char *in, size_t len, unsigned char *out) { unsigned n = 0; return type && HMAC(EVP_sha256(), key, (int)klen, in, len, out, &n) && n == 32 ? 0 : -1; }
