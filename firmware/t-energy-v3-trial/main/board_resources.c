#include "board_resources.h"
#include "board_report.h"
#include <stdint.h>

static bool valid_alignment(size_t n) { return n && !(n & (n-1)); }
static bool enough(const te_v3_resource_ops_t *ops,const te_v3_headroom_t *m,te_v3_memory_snapshot_t *out) {
    te_v3_memory_snapshot_t x={0};
    if (!ops->measure(ops->context,&x)) return false;
    if (out) *out=x;
    return x.external_free>=m->external_free && x.internal_free>=m->internal_free &&
        x.internal_largest>=m->internal_largest && x.external_largest>=m->external_largest;
}
static void *allocate(const te_v3_resource_ops_t *ops,size_t alignment,size_t bytes) {
    void *p=ops->alloc(alignment,bytes,ops->context);
    if (!p) return NULL;
    if (((uintptr_t)p % alignment) || !ops->external(p,ops->context)) {
        ops->release(p,ops->context); return NULL;
    }
    return p;
}
bool te_v3_resources_acquire(te_v3_pools_t *out,uint16_t capacity,size_t report_slots,
    const cp_v3_temporal_config_t *temporal,const te_v3_headroom_t *minimum,
    const te_v3_resource_ops_t *ops,te_v3_resource_sizes_t *sizes) {
    if (sizes) *sizes=(te_v3_resource_sizes_t){0};
    if (!out || out->reports || out->stats || out->temporal || !minimum ||
        !ops || !ops->alloc || !ops->external || !ops->release || !ops->measure ||
        !capacity || capacity>CP_V3_STATS_MAX_CAPACITY) return false;
    cp_v3_temporal_memory_t layout={0};
    te_v3_resource_sizes_t z={0};
    z.stats=cp_v3_stats_memory_bytes(capacity);z.stats_alignment=cp_v3_stats_memory_alignment();
    if (!te_v3_report_pool_bytes(report_slots,sizeof(te_v3_report_t),&z.reports) ||
        !z.stats || !valid_alignment(z.stats_alignment)) return false;
    if (temporal) {
        z.temporal_alignment=cp_v3_temporal_memory_alignment();
        if (!valid_alignment(z.temporal_alignment) ||
            !cp_v3_temporal_memory_layout(temporal,&layout) || !(z.temporal=layout.total_bytes)) return false;
    }
    te_v3_memory_snapshot_t memory={0};
    if (!enough(ops,minimum,&memory) || z.reports>SIZE_MAX-z.stats ||
        z.reports+z.stats>SIZE_MAX-z.temporal ||
        z.reports+z.stats+z.temporal>memory.external_free-minimum->external_free) return false;
    te_v3_pools_t p={0};
    if(memory.external_largest>=z.reports)p.reports=allocate(ops,_Alignof(te_v3_report_t),z.reports);
    if(p.reports && enough(ops,minimum,&memory) && memory.external_largest>=z.stats)
        p.stats=allocate(ops,z.stats_alignment,z.stats);
    if(p.stats && enough(ops,minimum,&memory) && temporal && memory.external_largest>=z.temporal)
        p.temporal=allocate(ops,z.temporal_alignment,z.temporal);
    if(!p.stats || (temporal&&!p.temporal) || !enough(ops,minimum,NULL)) {te_v3_pools_release(&p,ops->release,ops->context);return false;}
    *out=p;if(sizes)*sizes=z;return true;
}
