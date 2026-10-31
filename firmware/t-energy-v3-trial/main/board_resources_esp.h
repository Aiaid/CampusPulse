#pragma once
#include "board_resources.h"
/* Populate real ESP-IDF bindings; snapshot may be displayed without credentials.
 * Does not allocate, open a device, or enable the runtime gate. */
te_v3_resource_ops_t te_v3_esp_resource_ops(void);
bool te_v3_esp_memory_snapshot(te_v3_memory_snapshot_t *out);
bool te_v3_esp_resources_acquire(te_v3_pools_t *out,uint16_t capacity,size_t report_slots,
    const cp_v3_temporal_config_t *temporal,const te_v3_headroom_t *minimum,
    te_v3_resource_sizes_t *sizes);
