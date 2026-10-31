#pragma once
#include "cp_v3_budget.h"
#include "esp_err.h"
#include <stdbool.h>
#include <stdint.h>
#define CP_V3_BUDGET_NVS_FREE_ENTRY_FLOOR 128u

typedef struct {
    char namespace_name[16];
    uint8_t current[CP_V3_BUDGET_RECORD_BYTES];
    uint64_t sequence;
    int8_t active_slot;
    bool ready, have_record;
} cp_v3_budget_nvs_t;

/* Caller initializes NVS without erasure and serializes provider/core/storage
 * calls with the same outer owner mutex. Use one dedicated stable namespace
 * (root uses cpv3budg) across node boots/policies/writers. Read-only validation;
 * ABSENT is never synthesized from corrupt/foreign/ambiguous nonempty blobs.
 * Does not initialize, erase, migrate or reset NVS or unrelated keys.
 * logical_write_bytes=4096 is conservative logical metadata accounting,
 * not evidence of physical flash writes, GC amplification or wear endurance. */
esp_err_t cp_v3_budget_nvs_open(cp_v3_budget_nvs_t *, const char *namespace_name,
    cp_v3_budget_store_t *out);
