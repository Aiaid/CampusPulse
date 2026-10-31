#include "board_resources.h"
#include "board_report.h"
#include <assert.h>
#include <stdalign.h>
#include <stdio.h>
#include <stdint.h>
static size_t stats_align=16, temporal_align=32, stats_bytes=1024, temporal_bytes=4096;
static bool layout_ok=true;
size_t cp_v3_stats_memory_bytes(uint16_t n) { return n==512 ? stats_bytes : 0; }
size_t cp_v3_stats_memory_alignment(void) { return stats_align; }
size_t cp_v3_temporal_memory_alignment(void) { return temporal_align; }
bool cp_v3_temporal_memory_layout(const cp_v3_temporal_config_t *c,cp_v3_temporal_memory_t *m) {
    if (!c || !layout_ok) return false; *m=(cp_v3_temporal_memory_t){.total_bytes=temporal_bytes}; return true;
}
static alignas(64) unsigned char blocks[3][256];
static unsigned allocations,releases,fail_at,misalign_at,not_external_at,measure_calls,measure_fail_at;
static size_t after_external=1000000, after_internal=100000,after_largest=80000,external_largest=1000000;
static unsigned small_largest_at;
static void *alloc_test(size_t a,size_t n,void *ctx) { (void)a;(void)n;(void)ctx;unsigned k=++allocations;if(k==fail_at)return NULL;assert(k<=3);return blocks[k-1]+(k==misalign_at); }
static bool ext_test(const void *p,void *ctx) {(void)ctx;return !(not_external_at && p==blocks[not_external_at-1]);}
static void free_test(void *p,void *ctx) {(void)p;(void)ctx;++releases;}
static bool measure_test(void *ctx,te_v3_memory_snapshot_t *out) {
    (void)ctx; ++measure_calls; if(measure_calls==measure_fail_at)return false;
    *out=(te_v3_memory_snapshot_t){.external_free=measure_calls==1?1000000:after_external,
        .external_minimum=500000,.external_largest=measure_calls==small_largest_at?1:external_largest,
        .internal_free=after_internal,.internal_minimum=70000,.internal_largest=after_largest};return true;
}
static void reset(void) {allocations=releases=fail_at=misalign_at=not_external_at=measure_calls=measure_fail_at=0;after_external=1000000;after_internal=100000;after_largest=80000;external_largest=1000000;small_largest_at=0;layout_ok=true;stats_align=16;temporal_align=32;}
int main(void) {
    te_v3_resource_ops_t ops={alloc_test,ext_test,free_test,measure_test,NULL};
    te_v3_headroom_t min={.external_free=10000,.internal_free=20000,.internal_largest=10000};cp_v3_temporal_config_t cfg={0};
    te_v3_pools_t p={0};te_v3_resource_sizes_t sizes;
    reset();assert(te_v3_resources_acquire(&p,512,128,&cfg,&min,&ops,&sizes));
    assert(sizes.reports==128*sizeof(te_v3_report_t)&&sizes.stats==1024&&sizes.temporal==4096);
    assert(sizes.stats_alignment==16&&sizes.temporal_alignment==32 && measure_calls==4);
    te_v3_pools_release(&p,free_test,NULL);assert(releases==3);
    for(unsigned k=1;k<=3;k++) {reset();fail_at=k;assert(!te_v3_resources_acquire(&p,512,128,&cfg,&min,&ops,&sizes));assert(releases==k-1 && !p.reports&&!p.stats&&!p.temporal);}
    reset();misalign_at=2;assert(!te_v3_resources_acquire(&p,512,128,&cfg,&min,&ops,&sizes));assert(releases==2);
    reset();not_external_at=3;assert(!te_v3_resources_acquire(&p,512,128,&cfg,&min,&ops,&sizes));assert(releases==3);
    reset();after_external=9999;assert(!te_v3_resources_acquire(&p,512,128,&cfg,&min,&ops,&sizes));assert(releases==1);
    reset();after_largest=9999;assert(!te_v3_resources_acquire(&p,512,128,&cfg,&min,&ops,&sizes));assert(releases==0);
    reset();measure_fail_at=4;assert(!te_v3_resources_acquire(&p,512,128,&cfg,&min,&ops,&sizes));assert(releases==3);
    reset();small_largest_at=1;assert(!te_v3_resources_acquire(&p,512,128,&cfg,&min,&ops,&sizes));assert(releases==0);
    reset();small_largest_at=2;assert(!te_v3_resources_acquire(&p,512,128,&cfg,&min,&ops,&sizes));assert(releases==1);
    reset();small_largest_at=3;assert(!te_v3_resources_acquire(&p,512,128,&cfg,&min,&ops,&sizes));assert(releases==2);
    reset();min.external_largest=100;small_largest_at=4;
    assert(!te_v3_resources_acquire(&p,512,128,&cfg,&min,&ops,&sizes));assert(releases==3);min.external_largest=0;
    reset();stats_align=3;assert(!te_v3_resources_acquire(&p,512,128,&cfg,&min,&ops,&sizes));assert(!allocations);
    reset();layout_ok=false;assert(!te_v3_resources_acquire(&p,512,128,&cfg,&min,&ops,&sizes));assert(!allocations);
    reset();assert(te_v3_resources_acquire(&p,512,128,NULL,&min,&ops,&sizes));
    assert(p.reports && p.stats && !p.temporal && sizes.temporal==0 && sizes.temporal_alignment==0 && allocations==2);
    te_v3_pools_release(&p,free_test,NULL);assert(releases==2);
    reset();fail_at=2;assert(!te_v3_resources_acquire(&p,512,128,NULL,&min,&ops,&sizes));assert(releases==1);
    reset();after_external=9999;assert(!te_v3_resources_acquire(&p,512,128,NULL,&min,&ops,&sizes));assert(releases==1);
    reset();assert(!te_v3_resources_acquire(&p,513,128,&cfg,&min,&ops,&sizes));assert(!allocations);
    reset();assert(!te_v3_resources_acquire(&p,512,SIZE_MAX,&cfg,&min,&ops,&sizes));assert(!allocations);
    puts("board resource tests passed");
}
