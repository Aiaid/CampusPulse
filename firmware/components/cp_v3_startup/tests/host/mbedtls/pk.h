#pragma once
#include "ecp.h"
#include <stddef.h>
#define MBEDTLS_PK_ECKEY 2
typedef struct { int type; mbedtls_ecp_keypair ec; } mbedtls_pk_context;
void mbedtls_pk_init(mbedtls_pk_context *);
void mbedtls_pk_free(mbedtls_pk_context *);
int mbedtls_pk_parse_public_key(mbedtls_pk_context *, const unsigned char *, size_t);
int mbedtls_pk_get_type(const mbedtls_pk_context *);
static inline mbedtls_ecp_keypair *mbedtls_pk_ec(mbedtls_pk_context p) {
    /* Production macro returns the real context-owned pointer. The host shim
     * uses one copied key for the immediately following synchronous check. */
    static mbedtls_ecp_keypair ec; ec = p.ec; return &ec;
}
