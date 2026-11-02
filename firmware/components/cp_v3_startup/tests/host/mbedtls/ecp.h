#pragma once
#define MBEDTLS_PRIVATE(member) member
#define MBEDTLS_ECP_DP_SECP256R1 3
typedef struct { int id; } mbedtls_ecp_group;
typedef struct { int valid; } mbedtls_ecp_point;
typedef struct { mbedtls_ecp_group grp; mbedtls_ecp_point Q; } mbedtls_ecp_keypair;
int mbedtls_ecp_check_pubkey(const mbedtls_ecp_group *, const mbedtls_ecp_point *);
