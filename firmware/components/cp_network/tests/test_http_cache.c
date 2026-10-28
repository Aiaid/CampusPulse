#include "http_cache.h"
#include <assert.h>
#include <stdio.h>
int main(void) {
    cp_http_cache_t c={0};assert(!cp_http_cache_alive(&c,0));
    c=(cp_http_cache_t){.created_ms=100,.last_used_ms=1000,.confirmed=1};
    assert(cp_http_cache_alive(&c,2499));assert(!cp_http_cache_alive(&c,2500));
    assert(!cp_http_cache_alive(&c,999));
    c.last_used_ms=30000;assert(cp_http_cache_alive(&c,30099));
    assert(!cp_http_cache_alive(&c,30100));
    c.last_used_ms=1000;c.confirmed=CP_HTTP_CACHE_REQUESTS-1;
    assert(cp_http_cache_alive(&c,1001));++c.confirmed;assert(!cp_http_cache_alive(&c,1001));
    assert(cp_http_cache_budget(CP_HTTP_CACHE_FREE,CP_HTTP_CACHE_LARGEST,0));
    assert(!cp_http_cache_budget(CP_HTTP_CACHE_FREE-1,CP_HTTP_CACHE_LARGEST,0));
    assert(!cp_http_cache_budget(CP_HTTP_CACHE_FREE,CP_HTTP_CACHE_LARGEST-1,0));
    assert(cp_http_cache_budget(CP_HTTP_CACHE_FREE+8193,CP_HTTP_CACHE_LARGEST+8193,8193));
    assert(!cp_http_cache_budget(CP_HTTP_CACHE_FREE+8192,CP_HTTP_CACHE_LARGEST+8193,8193));
    assert(!cp_http_cache_budget(SIZE_MAX,SIZE_MAX,SIZE_MAX));
    /* This is the measured lifecycle: active body+TLS may clear32/18 yet fail
     * idle36/20. Only actual body release can establish the idle floor. */
    c=(cp_http_cache_t){.created_ms=100,.last_used_ms=1000,.confirmed=1,.body_pending=true,.body_alive=true};
    assert(cp_http_cache_current_budget(&c,33532,20480));
    assert(cp_http_cache_active_budget(33532,20480));
    assert(!cp_http_cache_body_freed(&c,1001,33532,20480)&&c.body_pending);
    assert(cp_http_cache_body_freed(&c,1001,38000,20480)&&!c.body_pending&&!c.body_alive);
    assert(!cp_http_cache_current_budget(&c,33532,20480));
    c.body_pending=true;
    assert(!cp_http_cache_body_freed(&c,1100,38000,20480));
    assert(!cp_http_cache_active_budget(32767,20480));
    assert(!cp_http_cache_active_budget(40000,18431));
    puts("HTTP cache: bounded idle/lifetime/eight receipts, rollback and postallocation RAM reserves passed");
}
