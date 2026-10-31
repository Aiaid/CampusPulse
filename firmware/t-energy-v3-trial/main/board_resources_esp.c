#include "board_resources_esp.h"
#include "esp_heap_caps.h"
#include "esp_memory_utils.h"
#include <stdint.h>
#define EXTERNAL_CAPS (MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT)
#define INTERNAL_CAPS (MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT)
static void *allocate(size_t alignment,size_t bytes,void *ctx) {
    (void)ctx;
    if(!alignment || (alignment&(alignment-1)) || !bytes)return NULL;
    return heap_caps_aligned_calloc(alignment,1,bytes,EXTERNAL_CAPS);
}
static bool external(const void *p,void *ctx) {(void)ctx;return p&&esp_ptr_external_ram(p);}
static void release(void *p,void *ctx) {(void)ctx;heap_caps_free(p);}
bool te_v3_esp_memory_snapshot(te_v3_memory_snapshot_t *out) {
    if(!out)return false;
    *out=(te_v3_memory_snapshot_t){
        .external_free=heap_caps_get_free_size(EXTERNAL_CAPS),
        .external_minimum=heap_caps_get_minimum_free_size(EXTERNAL_CAPS),
        .external_largest=heap_caps_get_largest_free_block(EXTERNAL_CAPS),
        .internal_free=heap_caps_get_free_size(INTERNAL_CAPS),
        .internal_minimum=heap_caps_get_minimum_free_size(INTERNAL_CAPS),
        .internal_largest=heap_caps_get_largest_free_block(INTERNAL_CAPS)};
    return true;
}
static bool measure(void *ctx,te_v3_memory_snapshot_t *out) {(void)ctx;return te_v3_esp_memory_snapshot(out);}
te_v3_resource_ops_t te_v3_esp_resource_ops(void) {
    return (te_v3_resource_ops_t){.alloc=allocate,.external=external,.release=release,.measure=measure};
}
bool te_v3_esp_resources_acquire(te_v3_pools_t *out,uint16_t capacity,size_t slots,
    const cp_v3_temporal_config_t *temporal,const te_v3_headroom_t *minimum,
    te_v3_resource_sizes_t *sizes) {
    te_v3_resource_ops_t ops=te_v3_esp_resource_ops();
    return te_v3_resources_acquire(out,capacity,slots,temporal,minimum,&ops,sizes);
}
