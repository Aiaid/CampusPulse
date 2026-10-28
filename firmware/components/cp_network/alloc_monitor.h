#pragma once
#include "esp_err.h"
#include <stdbool.h>
#include <stdint.h>

typedef struct {
    /* Callback count since registration in this boot, saturated at UINT32_MAX.
     * This is an allocation failure count, not a TLS failure or request count. */
    uint32_t failure_count;
    uint32_t recorded_failure_count;
    uint32_t last_requested_bytes;
    uint32_t last_caps;
    /* The detail tuple is coherent. Concurrent callbacks may leave an older
     * tuple: compare recorded_failure_count with failure_count before assigning
     * these details to the latest failure. A saturated count cannot order them. */
    bool details_available;
} cp_alloc_monitor_snapshot_t;

/* Own the SDK's single global failed-allocation callback for this boot.
 * IDF 5.5.3 has no getter or chaining API: other components must not replace it.
 * Idempotent after success; never resets counters during setup/network restart.
 * Call from serialized application initialization before network allocations. */
esp_err_t cp_alloc_monitor_init(void);

/* One bounded attempt; no heap, waiting, locks, addresses or function names.
 * A concurrent detail update returns the count with details_available=false. */
cp_alloc_monitor_snapshot_t cp_alloc_monitor_snapshot(void);
