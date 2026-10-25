#pragma once
#include <openssl/evp.h>
typedef struct { EVP_MD_CTX *inner; } mbedtls_sha256_context;
static inline void mbedtls_sha256_init(mbedtls_sha256_context *ctx) { ctx->inner = EVP_MD_CTX_new(); }
static inline int mbedtls_sha256_starts(mbedtls_sha256_context *ctx, int is224) { return ctx->inner && !is224 && EVP_DigestInit_ex(ctx->inner, EVP_sha256(), NULL) ? 0 : -1; }
static inline int mbedtls_sha256_update(mbedtls_sha256_context *ctx, const unsigned char *in, size_t len) { return EVP_DigestUpdate(ctx->inner, in, len) ? 0 : -1; }
static inline int mbedtls_sha256_finish(mbedtls_sha256_context *ctx, unsigned char *out) { unsigned n = 0; return EVP_DigestFinal_ex(ctx->inner, out, &n) && n == 32 ? 0 : -1; }
static inline void mbedtls_sha256_free(mbedtls_sha256_context *ctx) { EVP_MD_CTX_free(ctx->inner); ctx->inner = NULL; }
