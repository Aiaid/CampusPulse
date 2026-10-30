#pragma once
#include "esp_err.h"
#include "cp_settings.h"
#include "cp_network_diag.h"
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* Legacy transport values remain reserved and are always rejected. */
typedef enum { CP_PROVISION_BLE = 0, CP_PROVISION_SOFTAP = 1, CP_PROVISION_USB = 2 } cp_provision_mode_t;
/* Called on transport task: copy candidate and return promptly. Never block for
 * Wi-Fi/TLS/NVS here. ESP_OK means queued, not persisted or cloud accepted. */
typedef esp_err_t (*cp_provision_submit_fn)(const cp_settings_t *candidate,
                                         const char *attempt_id, void *ctx);
typedef struct {
    bool active;
    cp_provision_mode_t mode;
    char node_id[16];
    char attempt_id[37];
    char state[24];
    char reason[80];
} cp_provision_snapshot_t;
/* Physical USB only; other mode values return ESP_ERR_NOT_SUPPORTED before
 * state changes. Scanner/network must be stopped. The persistent factory-random
 * secret derives a per-session nonce; API origin is fixed by cp_settings. */
esp_err_t cp_provision_start(cp_provision_mode_t mode, const char *node_id,
                             const char *proof, cp_provision_submit_fn submit,
                             void *ctx);
/* Nonblocking: a concurrent USB exchange must finish before stop succeeds. */
esp_err_t cp_provision_stop(void);
/* Physical USB adapter owns framing/begin. Caller frees successful response.
 * status remains available after stop during candidate validation; other
 * operations require an active USB session. No returned secret except the USB
 * session nonce in authenticated-physical-channel info. */
esp_err_t cp_provision_usb_exchange(const uint8_t *request, size_t length,
                                    uint8_t **response, size_t *response_length);
void cp_provision_snapshot(cp_provision_snapshot_t *out);
void cp_provision_set_status(const char *state, const char *reason);

/* Nonblocking resolver over already validated application RAM. NULL output is a
 * capability query. Never access NVS/network from this callback. */
typedef bool (*cp_provision_credential_resolver_fn)(const char *node_id,cp_settings_t *saved,
    uint32_t *generation,void *context);
/* Bind the selected profile before context/start. Tokens contain 1..23 lower
 * ASCII letters, digits, '_' or '-'. Immutable while any session is active.
 * info.board is "<board_id> / <target_chip>"; no board component dependency. */
esp_err_t cp_provision_bind_board(const char *board_id,const char *target_chip);
esp_err_t cp_provision_bind_context(const char *node_id,const char *boot_id,uint32_t reset_reason,
    cp_provision_credential_resolver_fn resolver,void *context);
void cp_provision_set_diagnostic(const cp_network_diagnostic_t *diagnostic,const char *attempt_id);
void cp_provision_set_previous_attempt(const cp_network_attempt_t *attempt,esp_err_t history_error);
