#include "board_admission.h"
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
static int object, freed, allocations, fail_at;
static void *alloc_pool(size_t n,void *ctx) { (void)ctx; return n && ++allocations != fail_at ? &object : NULL; }
static bool ext_yes(const void *p,void *ctx) { (void)p; return ctx != NULL; }
static void free_pool(void *p,void *ctx) { (void)p; (void)ctx; ++freed; }
int main(void) {
    size_t n = 7;
    assert(!te_v3_runtime_ready());
    assert(te_v3_report_pool_bytes(128, 1664, &n) && n == 212992);
    assert(!te_v3_report_pool_bytes(0, 1, &n) && n == 0);
    assert(!te_v3_report_pool_bytes(1, 0, &n) && n == 0);
    assert(!te_v3_report_pool_bytes(SIZE_MAX, 2, &n) && n == 0);
    assert(!te_v3_report_pool_bytes(1, 1, NULL));
    assert(!te_v3_pool_acquire(128, 10, alloc_pool, ext_yes, free_pool, NULL) && freed == 1);
    assert(te_v3_pool_acquire(128, 10, alloc_pool, ext_yes, free_pool, &object) == &object && freed == 1);
    assert(!te_v3_pool_acquire(SIZE_MAX, 2, alloc_pool, ext_yes, free_pool, &object) && freed == 1);
    assert(!te_v3_pool_acquire(1, 1, NULL, ext_yes, free_pool, &object));
    te_v3_pools_t pools = {0};
    allocations=freed=0;fail_at=2;
    assert(!te_v3_pools_acquire(&pools, 100, 200, 300, 1000, 100, alloc_pool, ext_yes, free_pool, &object));
    assert(!pools.reports && !pools.stats && !pools.temporal && freed == 1);
    allocations=freed=0;fail_at=0;
    assert(!te_v3_pools_acquire(&pools, 100, 200, 300, 699, 100, alloc_pool, ext_yes, free_pool, &object));
    assert(allocations == 0);
    assert(!te_v3_pools_acquire(&pools, SIZE_MAX, 2, 1, SIZE_MAX, 0, alloc_pool, ext_yes, free_pool, &object));
    assert(te_v3_pools_acquire(&pools, 100, 200, 300, 700, 100, alloc_pool, ext_yes, free_pool, &object));
    assert(!te_v3_pools_acquire(&pools, 1, 1, 1, 10, 0, alloc_pool, ext_yes, free_pool, &object));
    te_v3_pools_release(&pools,free_pool,&object);
    assert(!pools.reports && !pools.stats && !pools.temporal && freed == 3);
    puts("board admission tests passed");
}
