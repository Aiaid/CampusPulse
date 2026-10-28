#pragma once
#include <stddef.h>
#include <stdint.h>
#define MALLOC_CAP_8BIT (1u << 2)
#define MALLOC_CAP_INTERNAL (1u << 11)
typedef struct {
    size_t total_free_bytes, total_allocated_bytes, largest_free_block, minimum_free_bytes;
    size_t allocated_blocks, free_blocks, total_blocks;
} multi_heap_info_t;
void heap_caps_get_info(multi_heap_info_t *, uint32_t);
