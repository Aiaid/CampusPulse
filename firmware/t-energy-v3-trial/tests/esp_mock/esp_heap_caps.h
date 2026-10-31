#pragma once
#include <stddef.h>
#include <stdint.h>
#define MALLOC_CAP_SPIRAM 1u
#define MALLOC_CAP_8BIT 2u
#define MALLOC_CAP_INTERNAL 4u
void *heap_caps_aligned_calloc(size_t,size_t,size_t,uint32_t);
void heap_caps_free(void *);
size_t heap_caps_get_free_size(uint32_t);
size_t heap_caps_get_minimum_free_size(uint32_t);
size_t heap_caps_get_largest_free_block(uint32_t);
