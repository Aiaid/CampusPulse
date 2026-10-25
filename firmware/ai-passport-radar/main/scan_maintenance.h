#pragma once

#include "scan_table.h"

// Shared by the service worker and host regression. No report arrival or UI
// read is required. Inherited table/classifier semantics are diagnostic only;
// this is not the future ingestion core.
// Caller owns the table mutex and samples now_ms after acquiring it.
static inline void scan_maintenance_tick(scan_table_t *table, uint32_t now_ms)
{
    scan_table_prune(table, now_ms, SCAN_PRUNE_WINDOW_MS);
    scan_table_tick_dwell(table, now_ms);
    scan_table_tick_confirm(table, now_ms);
}

// Keep sampling inside the locked maintenance operation. A clock callback lets
// host tests interleave a new observation before sampling without mocking BLE.
static inline uint32_t scan_maintenance_run_locked(scan_table_t *table,
                                                  uint32_t (*clock_ms)(void))
{
    const uint32_t now_ms = clock_ms();
    scan_maintenance_tick(table, now_ms);
    return now_ms;
}
