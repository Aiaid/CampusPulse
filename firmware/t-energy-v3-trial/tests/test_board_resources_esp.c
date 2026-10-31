#include "board_resources_esp.h"
#include "esp_heap_caps.h"
#include <assert.h>
#include <stdio.h>
static int object,freed,allocated,delegated;
bool te_v3_resources_acquire(te_v3_pools_t *out,uint16_t capacity,size_t slots,
    const cp_v3_temporal_config_t *temporal,const te_v3_headroom_t *minimum,
    const te_v3_resource_ops_t *ops,te_v3_resource_sizes_t *sizes) {
    (void)out;(void)temporal;(void)minimum;(void)sizes;
    assert(capacity==512 && slots==128 && ops->alloc && ops->measure && ops->external && ops->release);
    ++delegated;return true;
}
void *heap_caps_aligned_calloc(size_t a,size_t n,size_t size,uint32_t caps) {
    assert(a==16 && n==1 && size==4096 && caps==(MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT));++allocated;return &object;
}
void heap_caps_free(void *p) {assert(p==&object);++freed;}
bool esp_ptr_external_ram(const void *p) {return p==&object;}
size_t heap_caps_get_free_size(uint32_t caps) {return caps==(MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT)?101:201;}
size_t heap_caps_get_minimum_free_size(uint32_t caps) {return caps==(MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT)?102:202;}
size_t heap_caps_get_largest_free_block(uint32_t caps) {return caps==(MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT)?103:203;}
int main(void) {
    te_v3_resource_ops_t ops=te_v3_esp_resource_ops();te_v3_memory_snapshot_t s;
    assert(ops.measure(NULL,&s));assert(s.external_free==101&&s.external_minimum==102&&s.external_largest==103);
    assert(s.internal_free==201&&s.internal_minimum==202&&s.internal_largest==203);
    assert(!ops.measure(NULL,NULL));
    assert(!ops.alloc(3,4096,NULL)&&!ops.alloc(16,0,NULL)&&!allocated);
    void *p=ops.alloc(16,4096,NULL);assert(p==&object && allocated==1 && ops.external(p,NULL));
    assert(!ops.external(NULL,NULL));ops.release(p,NULL);assert(freed==1);
    assert(te_v3_esp_resources_acquire(NULL,512,128,NULL,NULL,NULL) && delegated==1);
    puts("ESP resource binding tests passed");
}
