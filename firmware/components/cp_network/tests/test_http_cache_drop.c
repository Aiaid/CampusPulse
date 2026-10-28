#include "http_cache_drop.h"
#include <assert.h>
#include <stdio.h>

int main(void) {
    cp_http_cache_t c={.created_ms=100,.last_used_ms=1000,.confirmed=1};
    assert(cp_http_drop_flags(&c,1000,65536,32768)==0);
    assert(cp_http_drop_age(100,101)==0);
    assert(cp_http_drop_age(UINT64_MAX,0)==UINT32_MAX);
    assert(cp_http_drop_age(UINT64_MAX,UINT64_MAX-17)==17);
    assert(cp_http_drop_age(UINT32_MAX,0)==UINT32_MAX);
    uint32_t flags=cp_http_drop_flags(&c,99,65536,32768);
    assert(flags==(CP_HTTP_DROP_CREATED_ROLLBACK|CP_HTTP_DROP_IDLE_ROLLBACK));
    c.confirmed=CP_HTTP_CACHE_REQUESTS;c.body_pending=true;
    flags=cp_http_drop_flags(&c,30100,0,0);
    assert(flags==(CP_HTTP_DROP_REQUEST_LIMIT|CP_HTTP_DROP_IDLE_EXPIRED|
        CP_HTTP_DROP_LIFETIME_EXPIRED|CP_HTTP_DROP_HANDOFF_EXPIRED|
        CP_HTTP_DROP_ACTIVE_BUDGET|CP_HTTP_DROP_IDLE_BUDGET));
    c.confirmed=0;
    assert(cp_http_drop_flags(&c,30100,0,0)&CP_HTTP_DROP_UNCONFIRMED);
    c=(cp_http_cache_t){.created_ms=1,.last_used_ms=1,.confirmed=1,.body_pending=true};
    assert(cp_http_drop_flags(&c,100,CP_HTTP_CACHE_FREE,CP_HTTP_CACHE_LARGEST)==0);
    assert(cp_http_drop_flags(&c,101,CP_HTTP_CACHE_FREE,CP_HTTP_CACHE_LARGEST)==CP_HTTP_DROP_HANDOFF_EXPIRED);
    c.body_pending=false;
    assert(cp_http_drop_flags(&c,1500,CP_HTTP_CACHE_ACTIVE_FREE,CP_HTTP_CACHE_ACTIVE_LARGEST)==CP_HTTP_DROP_IDLE_BUDGET);
    assert(cp_http_drop_flags(&c,1501,CP_HTTP_CACHE_FREE,CP_HTTP_CACHE_LARGEST)==CP_HTTP_DROP_IDLE_EXPIRED);
    /* Across rollback and near UINT64_MAX, diagnostic age/limit flags agree
     * with the existing cache policy; diagnostics never replace that policy. */
    const uint64_t times[]={0,1,99,100,101,1499,1500,1501,29999,30000,
        UINT32_MAX,UINT64_MAX-1,UINT64_MAX};
    const uint32_t invalid=CP_HTTP_DROP_UNCONFIRMED|CP_HTTP_DROP_REQUEST_LIMIT|
        CP_HTTP_DROP_IDLE_EXPIRED|CP_HTTP_DROP_LIFETIME_EXPIRED|
        CP_HTTP_DROP_HANDOFF_EXPIRED|CP_HTTP_DROP_CREATED_ROLLBACK|CP_HTTP_DROP_IDLE_ROLLBACK;
    for(unsigned a=0;a<sizeof times/sizeof *times;++a)
        for(unsigned b=0;b<sizeof times/sizeof *times;++b)
            for(unsigned n=0;n<sizeof times/sizeof *times;++n)
                for(unsigned count=0;count<=CP_HTTP_CACHE_REQUESTS;++count)
                    for(unsigned pending=0;pending<2;++pending) {
                        c=(cp_http_cache_t){.created_ms=times[a],.last_used_ms=times[b],
                            .confirmed=count,.body_pending=pending!=0};
                        flags=cp_http_drop_flags(&c,times[n],65536,32768);
                        assert(cp_http_cache_alive(&c,times[n])==!(flags&invalid));
                    }
    puts("http cache drop diagnostics: passed");
}
