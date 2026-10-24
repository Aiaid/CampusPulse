#pragma once
#include "esp_err.h"
#include "cp_settings.h"
#include <stdbool.h>

typedef enum { CP_PROVISION_BLE = 0, CP_PROVISION_SOFTAP = 1 } cp_provision_mode_t;
/* Called on transport task: copy candidate and return promptly. Never block for
 * Wi-Fi/TLS/NVS here. ESP_OK means queued, not persisted or cloud accepted. */
typedef esp_err_t (*cp_provision_submit_fn)(const cp_settings_t *candidate,
                                         const char *attempt_id, void *ctx);
typedef struct {
    bool active;
    cp_provision_mode_t mode;
    char node_id[16];
    char service_name[30];
    char proof[33];
    char ap_password[33];
    char attempt_id[37];
    char state[24];
    char reason[80];
} cp_provision_snapshot_t;
/* Exclusive boot mode: scanner/network must be stopped. proof is a persistent
 * factory-random secret (32 hex chars), never a MAC/global firmware password.
 * API origin is fixed by cp_settings. No BLE memory release occurs. */
esp_err_t cp_provision_start(cp_provision_mode_t mode, const char *node_id,
                             const char *proof, cp_provision_submit_fn submit,
                             void *ctx);
/* On failure, ownership remains active and callers must not start another radio
 * owner. A failed BLE teardown is latched until reboot (IDF frees internal state
 * even when stop fails); do not retry initialization in that boot. */
esp_err_t cp_provision_stop(void);
void cp_provision_snapshot(cp_provision_snapshot_t *out);
void cp_provision_set_status(const char *state, const char *reason);
