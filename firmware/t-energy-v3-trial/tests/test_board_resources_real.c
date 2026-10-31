/* Host ABI integration with the actual shared layout functions; this simulates
 * PSRAM accounting but does not establish ESP32-S3 sizes or fragmentation. */
#include "board_resources.h"
#include "board_report.h"
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
typedef struct { void *p[3];size_t n[3],used; } pool_t;
static void *allocate(size_t alignment,size_t bytes,void *ctx) {
    pool_t *s=ctx;if(alignment<sizeof(void *))alignment=sizeof(void *);
    if(bytes>SIZE_MAX-(alignment-1))return NULL;
    size_t rounded=(bytes+alignment-1)/alignment*alignment;
    for(unsigned i=0;i<3;i++)if(!s->p[i]){
        void *p=aligned_alloc(alignment,rounded);if(!p)return NULL;
        memset(p,0,rounded);s->p[i]=p;s->n[i]=rounded;s->used+=rounded;return p;
    }
    return NULL;
}
static bool external(const void *p,void *ctx) {pool_t *s=ctx;for(unsigned i=0;i<3;i++)if(s->p[i]==p)return true;return false;}
static void release(void *p,void *ctx) {pool_t *s=ctx;for(unsigned i=0;i<3;i++)if(s->p[i]==p){s->used-=s->n[i];free(p);s->p[i]=NULL;s->n[i]=0;return;}assert(false);}
static bool measure(void *ctx,te_v3_memory_snapshot_t *out) {
    pool_t *s=ctx;size_t free_bytes=8u*1024u*1024u-s->used;
    *out=(te_v3_memory_snapshot_t){.external_free=free_bytes,.external_minimum=free_bytes,
        .external_largest=free_bytes,.internal_free=200000,.internal_minimum=180000,.internal_largest=150000};return true;
}
int main(void) {
    pool_t state={0};te_v3_resource_ops_t ops={allocate,external,release,measure,&state};
    te_v3_headroom_t min={.external_free=512*1024,.internal_free=50000,.internal_largest=20000};
    cp_v3_temporal_config_t cfg=cp_v3_temporal_default_config();
    cfg.max_tracks=512;cfg.history_ms=600000;cfg.slice_ms=2000;
    cp_v3_temporal_memory_t layout;assert(cp_v3_temporal_memory_layout(&cfg,&layout));
    te_v3_pools_t pools={0};te_v3_resource_sizes_t z;
    assert(te_v3_resources_acquire(&pools,512,128,NULL,&min,&ops,&z));
    assert(z.stats==cp_v3_stats_memory_bytes(512) && z.stats_alignment==cp_v3_stats_memory_alignment());
    assert(!pools.temporal && !z.temporal);te_v3_pools_release(&pools,release,&state);assert(!state.used);
    assert(te_v3_resources_acquire(&pools,512,128,&cfg,&min,&ops,&z));
    assert(z.temporal==layout.total_bytes && z.temporal_alignment==cp_v3_temporal_memory_alignment());
    assert((uintptr_t)pools.stats%z.stats_alignment==0 && (uintptr_t)pools.temporal%z.temporal_alignment==0);
    printf("real host ABI: reports=%zu stats=%zu align=%zu temporal=%zu align=%zu slices=%u cell=%u\n",
        z.reports,z.stats,z.stats_alignment,z.temporal,z.temporal_alignment,layout.history_slices,layout.cell_bytes);
    te_v3_pools_release(&pools,release,&state);assert(!state.used);
    puts("real shared resource integration passed (host ABI, simulated PSRAM)");
}
