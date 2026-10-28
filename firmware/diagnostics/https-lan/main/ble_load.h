#pragma once
#include <stdbool.h>
#include <stdint.h>
#include "esp_err.h"
#include "sdkconfig.h"
#if CONFIG_CP_LAN_BLE_LOAD
#define LAN_BLE_ENABLED 1
#else
#define LAN_BLE_ENABLED 0
#endif

/* Counts only. No observation or identifier leaves the worker's RAM. */
typedef struct {
    uint32_t received, enqueued, processed, queue_drops, aggregate_drops;
    uint32_t address_overflow, windows, queue_highwater, scan_errors, resets;
    bool scan_active;
} lan_ble_counts_t;
esp_err_t lan_ble_start(void);
esp_err_t lan_ble_stop(void);
bool lan_ble_runtime_retained(void);
void lan_ble_snapshot(lan_ble_counts_t *out);
void lan_ble_print(const char *scope, const char *mode, unsigned sample,
                   const lan_ble_counts_t *before);
void lan_ble_print_between(const char *scope, const char *mode, unsigned sample,
                          const lan_ble_counts_t *before, const lan_ble_counts_t *after);
