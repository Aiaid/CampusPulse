#pragma once
#include "cp_v3_queue.h"
#include "esp_partition.h"

/* Dedicated unencrypted data/0x40 partition, exactly 12 two-sector slots. */
#define TE_FLASH_QUEUE_BYTES (CP_V3_QUEUE_SLOTS * 8192u)
typedef struct {
    const esp_partition_t *partition;
    uint16_t uncertain;
    uint8_t comparison[CP_V3_QUEUE_SLOT_BYTES];
} te_flash_queue_t;
bool te_flash_queue_prepare(te_flash_queue_t *, const esp_partition_t *, cp_v3_queue_store_t *);
