#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#define CP_HTTP_CACHE_IDLE_MS 1500u
#define CP_HTTP_CACHE_LIFETIME_MS 30000u
#define CP_HTTP_CACHE_REQUESTS 8u
#define CP_HTTP_CACHE_FREE (36u*1024u)
#define CP_HTTP_CACHE_LARGEST (20u*1024u)
#define CP_HTTP_CACHE_ACTIVE_FREE (32u*1024u)
#define CP_HTTP_CACHE_ACTIVE_LARGEST (18u*1024u)
#define CP_HTTP_CACHE_BODY_HANDOFF_MS 100u
typedef struct { uint64_t created_ms,last_used_ms; unsigned confirmed;
    bool body_pending,body_alive; } cp_http_cache_t;
static inline bool cp_http_cache_alive(const cp_http_cache_t *cache,uint64_t now) {
    return cache->confirmed && cache->confirmed<CP_HTTP_CACHE_REQUESTS &&
        now>=cache->last_used_ms && now-cache->last_used_ms<CP_HTTP_CACHE_IDLE_MS &&
        now>=cache->created_ms && now-cache->created_ms<CP_HTTP_CACHE_LIFETIME_MS &&
        (!cache->body_pending || now-cache->last_used_ms<CP_HTTP_CACHE_BODY_HANDOFF_MS);
}
static inline bool cp_http_cache_active_budget(size_t free_bytes,size_t largest) {
    return free_bytes>=CP_HTTP_CACHE_ACTIVE_FREE&&largest>=CP_HTTP_CACHE_ACTIVE_LARGEST;
}
static inline bool cp_http_cache_budget(size_t free_bytes,size_t largest,size_t reserve) {
    return reserve<=SIZE_MAX-CP_HTTP_CACHE_FREE &&
        free_bytes>=CP_HTTP_CACHE_FREE+reserve &&
        reserve<=SIZE_MAX-CP_HTTP_CACHE_LARGEST &&
        largest>=CP_HTTP_CACHE_LARGEST+reserve;
}
static inline bool cp_http_cache_body_freed(cp_http_cache_t *cache,uint64_t now,
    size_t free_bytes,size_t largest) {
    if(!cp_http_cache_alive(cache,now)||!cp_http_cache_budget(free_bytes,largest,0))return false;
    cache->body_pending=cache->body_alive=false;return true;
}
static inline bool cp_http_cache_current_budget(const cp_http_cache_t *cache,size_t free_bytes,size_t largest) {
    return cache->body_alive||cache->body_pending ? cp_http_cache_active_budget(free_bytes,largest) :
        cp_http_cache_budget(free_bytes,largest,0);
}
