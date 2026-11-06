#pragma once

#include "esp_heap_caps.h"
#include <stdlib.h>

/* LVGL calls this once at lv_init for its unchanged 64 KiB CPU-only pool.
 * Do not fall back to internal RAM and consume the cold MQTT reserve. */
static inline void *wave_lvgl_pool_alloc(size_t bytes) {
    void *pool=heap_caps_malloc(bytes,MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT);
    if(!pool)abort();
    return pool;
}

#define LV_MEM_POOL_ALLOC(bytes) wave_lvgl_pool_alloc(bytes)
