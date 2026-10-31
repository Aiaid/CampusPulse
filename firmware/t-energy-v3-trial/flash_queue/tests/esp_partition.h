#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#define ESP_OK 0
#define ESP_PARTITION_TYPE_DATA 1
typedef struct { int type; int subtype; uint32_t address; size_t size; size_t erase_size; char label[17]; bool encrypted; bool readonly; } esp_partition_t;
int esp_partition_read(const esp_partition_t *,size_t,void *,size_t);
int esp_partition_write(const esp_partition_t *,size_t,const void *,size_t);
int esp_partition_erase_range(const esp_partition_t *,size_t,size_t);
