#pragma once
#include "cp_v3_queue.h"
#include <string.h>
/* This marker is a local exclusive-namespace contract, not an authenticated
 * import voucher. Only this application's prepaid publications may enter it. */
#define EDGE_LIFECYCLE_MARKER_BYTES 64u
static inline uint32_t edge_lifecycle_crc(const uint8_t *p,size_t n) {
    uint32_t crc=UINT32_MAX;
    while(n--){crc^=*p++;for(unsigned i=0;i<8;i++)crc=(crc>>1)^(0xedb88320u&(0u-(crc&1u)));}return ~crc;
}
static inline void edge_lifecycle_marker(const uint8_t owner[32],uint8_t out[64]) {
    memset(out,0,64);memcpy(out,"CPLIFE01",8);memcpy(out+8,owner,32);out[40]=4;out[41]=4;out[42]=2;out[43]=2;out[45]=8;
    uint32_t crc=edge_lifecycle_crc(out,60);for(unsigned i=0;i<4;i++)out[60+i]=(uint8_t)(crc>>(8*i));
}
static inline bool edge_lifecycle_marker_matches(const void *p,size_t n,const uint8_t owner[32]) {
    uint8_t wanted[64];edge_lifecycle_marker(owner,wanted);return p&&n==64&&!memcmp(p,wanted,64);
}
static inline bool edge_lifecycle_record(const void *p,size_t n,unsigned slot,const char *node,
    cp_v3_sha256_fn hash,void *context) {
    if(!p||!node||!node[0]||strlen(node)>=65||n<103)return false;
    const uint8_t *b=p;const uint8_t profile[]={1,0,0,0,4,4,2,2,0,8};
    if(memcmp(b,"CPV3Q002",8)||memcmp(b+12,profile,sizeof profile)||memcmp(b+38,node,strlen(node)+1))return false;
    cp_v3_queue_tombstone_t identity;return cp_v3_queue_record_check(p,n,slot,hash,context,&identity);
}
static inline uint64_t edge_lifecycle_charge(size_t encoded) {
    return encoded&&encoded<=CP_V3_QUEUE_SLOT_BYTES?3u*((uint64_t)encoded+512u):0;
}
