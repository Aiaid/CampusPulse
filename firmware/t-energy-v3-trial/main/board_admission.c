#include "board_admission.h"
#include <stdint.h>

bool te_v3_report_pool_bytes(size_t slots, size_t slot_bytes, size_t *bytes) {
    if (!bytes) return false;
    *bytes = 0;
    if (!slots || !slot_bytes || slots > SIZE_MAX / slot_bytes) return false;
    *bytes = slots * slot_bytes;
    return true;
}
bool te_v3_runtime_ready(void) {
    /* This is intentionally not controlled by a config flag or host input. */
    return false;
}
void *te_v3_pool_acquire(size_t slots, size_t slot_bytes, te_v3_pool_alloc_t alloc,
                         te_v3_pool_external_t external, te_v3_pool_free_t release,
                         void *context) {
    size_t bytes;
    if (!alloc || !external || !release || !te_v3_report_pool_bytes(slots, slot_bytes, &bytes)) return NULL;
    void *pool = alloc(bytes, context);
    if (!pool) return NULL;
    if (!external(pool, context)) { release(pool, context); return NULL; }
    return pool;
}
void te_v3_pools_release(te_v3_pools_t *p, te_v3_pool_free_t release, void *ctx) {
    if (!p || !release) return;
    if (p->temporal) release(p->temporal,ctx);
    if (p->stats) release(p->stats,ctx);
    if (p->reports) release(p->reports,ctx);
    *p=(te_v3_pools_t){0};
}
bool te_v3_pools_acquire(te_v3_pools_t *out, size_t r, size_t s, size_t t,
    size_t free_external, size_t reserve, te_v3_pool_alloc_t alloc,
    te_v3_pool_external_t external, te_v3_pool_free_t release, void *ctx) {
    if (!out || !alloc || !external || !release || !r || !s || !t) return false;
    /* Never overwrite existing ownership; caller must release first. */
    if (out->reports || out->stats || out->temporal) return false;
    if (r>SIZE_MAX-s || r+s>SIZE_MAX-t || r+s+t>SIZE_MAX-reserve ||
        r+s+t+reserve>free_external) return false;
    te_v3_pools_t p={0};
    p.reports=te_v3_pool_acquire(1,r,alloc,external,release,ctx);
    if (p.reports) p.stats=te_v3_pool_acquire(1,s,alloc,external,release,ctx);
    if (p.stats) p.temporal=te_v3_pool_acquire(1,t,alloc,external,release,ctx);
    if (!p.temporal) { te_v3_pools_release(&p,release,ctx); return false; }
    *out=p; return true;
}
