#pragma once
#include "board_admission.h"
#include "cp_v3_temporal.h"
#include <stdint.h>
/* Allocation callbacks allocate aligned PSRAM; each measurement is a snapshot
 * and may change immediately. Minimum-free values are historical low watermarks. */
typedef void *(*te_v3_aligned_alloc_t)(size_t alignment,size_t bytes,void *context);
typedef struct {
    size_t external_free,external_minimum,external_largest;
    size_t internal_free,internal_minimum,internal_largest;
} te_v3_memory_snapshot_t;
typedef bool (*te_v3_measure_t)(void *context,te_v3_memory_snapshot_t *out);
typedef struct {
    te_v3_aligned_alloc_t alloc;
    te_v3_pool_external_t external;
    te_v3_pool_free_t release;
    te_v3_measure_t measure;
    void *context;
} te_v3_resource_ops_t;
typedef struct { size_t external_free,internal_free,internal_largest,external_largest; } te_v3_headroom_t;
typedef struct { size_t reports,stats,temporal,stats_alignment,temporal_alignment; } te_v3_resource_sizes_t;
/* NULL temporal means policy explicitly disables temporal; otherwise the full
 * rolling arena is mandatory. Calls shared ABI-specific memory query functions.
 * Requires empty out.
 * Successful acquisition transfers ownership to out; on failure all fresh
 * allocations are released and out remains empty. No hardware or gate action. */
bool te_v3_resources_acquire(te_v3_pools_t *out,uint16_t capacity,size_t report_slots,
    const cp_v3_temporal_config_t *temporal,const te_v3_headroom_t *minimum,
    const te_v3_resource_ops_t *ops,te_v3_resource_sizes_t *sizes);
