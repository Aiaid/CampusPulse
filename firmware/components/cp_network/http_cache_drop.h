#pragma once
#include "http_cache.h"
/* Numeric call sites, not an assertion that one predicate uniquely caused a
 * drop. CP_HTTP_DROP_MEMORY_WORK is shared by encoder and radio callers. */
typedef enum {
    CP_HTTP_DROP_REQUEST=1, CP_HTTP_DROP_UNAVAILABLE, CP_HTTP_DROP_TRANSPORT_END,
    CP_HTTP_DROP_SERVICE, CP_HTTP_DROP_CONTACT, CP_HTTP_DROP_CONFIG,
    CP_HTTP_DROP_ACTIVATION, CP_HTTP_DROP_STOP, CP_HTTP_DROP_MEMORY_WORK,
    CP_HTTP_DROP_UPLOAD_MEMORY, CP_HTTP_DROP_UPLOAD_READY,
    CP_HTTP_DROP_UPLOAD_FINALIZE, CP_HTTP_DROP_ACK_FALLBACK,
    CP_HTTP_DROP_ACK_LIMIT, CP_HTTP_DROP_ACK_RESULT,
} cp_http_drop_reason_t;
/* flags combine contemporaneous observations. Heap/age flags are sampled at
 * cleanup entry, after the original guard; they do not retroactively identify
 * which short-circuit operand the guard evaluated. No policy lives here. */
enum {
    CP_HTTP_DROP_UNCONFIRMED=1u<<0, CP_HTTP_DROP_REQUEST_LIMIT=1u<<1,
    CP_HTTP_DROP_IDLE_EXPIRED=1u<<2, CP_HTTP_DROP_LIFETIME_EXPIRED=1u<<3,
    CP_HTTP_DROP_HANDOFF_EXPIRED=1u<<4, CP_HTTP_DROP_CREATED_ROLLBACK=1u<<5,
    CP_HTTP_DROP_IDLE_ROLLBACK=1u<<6, CP_HTTP_DROP_ACTIVE_BUDGET=1u<<7,
    CP_HTTP_DROP_IDLE_BUDGET=1u<<8, CP_HTTP_DROP_NONINGEST=1u<<9,
    CP_HTTP_DROP_STOPPED=1u<<10, CP_HTTP_DROP_LINK_UNSYNCED=1u<<11,
    CP_HTTP_DROP_HTTP_ERROR=1u<<12, CP_HTTP_DROP_HTTP_STATUS=1u<<13,
    CP_HTTP_DROP_DISCONNECTED=1u<<14, CP_HTTP_DROP_INCOMPLETE=1u<<15,
    CP_HTTP_DROP_ALLOC_FAILED=1u<<16, CP_HTTP_DROP_ACK_NOT_ACCEPTED=1u<<17,
};
static inline uint32_t cp_http_drop_age(uint64_t now,uint64_t since) {
    uint64_t age=now>=since?now-since:0;
    return age>UINT32_MAX?UINT32_MAX:(uint32_t)age;
}
static inline uint32_t cp_http_drop_flags(const cp_http_cache_t *cache,
    uint64_t now,size_t free_bytes,size_t largest)
{
    uint32_t flags=0;
    if(!cache->confirmed)flags|=CP_HTTP_DROP_UNCONFIRMED;
    if(cache->confirmed>=CP_HTTP_CACHE_REQUESTS)flags|=CP_HTTP_DROP_REQUEST_LIMIT;
    if(now<cache->created_ms)flags|=CP_HTTP_DROP_CREATED_ROLLBACK;
    else if(now-cache->created_ms>=CP_HTTP_CACHE_LIFETIME_MS)flags|=CP_HTTP_DROP_LIFETIME_EXPIRED;
    if(now<cache->last_used_ms)flags|=CP_HTTP_DROP_IDLE_ROLLBACK;
    else {
        uint64_t idle=now-cache->last_used_ms;
        if(idle>=CP_HTTP_CACHE_IDLE_MS)flags|=CP_HTTP_DROP_IDLE_EXPIRED;
        if(cache->body_pending&&idle>=CP_HTTP_CACHE_BODY_HANDOFF_MS)flags|=CP_HTTP_DROP_HANDOFF_EXPIRED;
    }
    if(!cp_http_cache_active_budget(free_bytes,largest))flags|=CP_HTTP_DROP_ACTIVE_BUDGET;
    if(!cp_http_cache_budget(free_bytes,largest,0))flags|=CP_HTTP_DROP_IDLE_BUDGET;
    return flags;
}
