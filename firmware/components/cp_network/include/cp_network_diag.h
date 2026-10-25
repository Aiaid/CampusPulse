#ifndef CP_NETWORK_DIAG_H
#define CP_NETWORK_DIAG_H
#include "esp_err.h"
#include <stdbool.h>
#include <stdint.h>
#define CP_NETWORK_VALIDATE_TIMEOUT_MS 90000u
typedef enum {
    CP_DIAG_IDLE, CP_DIAG_HANDOFF, CP_DIAG_WIFI_CONNECT, CP_DIAG_DHCP,
    CP_DIAG_CLOCK, CP_DIAG_DNS, CP_DIAG_TLS, CP_DIAG_CLOUD_AUTH,
    CP_DIAG_SAVE, CP_DIAG_READY, CP_DIAG_STAGE_COUNT
} cp_diag_stage_t;
typedef enum {
    CP_DIAG_CODE_IDLE, CP_DIAG_QUEUED, CP_DIAG_HANDOFF_FAILED, CP_DIAG_NETWORK_START_FAILED,
    CP_DIAG_WIFI_CONNECTING, CP_DIAG_WIFI_NOT_FOUND, CP_DIAG_WIFI_AUTH_FAILED,
    CP_DIAG_WIFI_CONNECT_FAILED, CP_DIAG_WIFI_TIMEOUT, CP_DIAG_DHCP_WAIT, CP_DIAG_DHCP_TIMEOUT,
    CP_DIAG_CLOCK_SYNC, CP_DIAG_CLOCK_FAILED, CP_DIAG_CLOCK_TIMEOUT,
    CP_DIAG_DNS_RESOLVING, CP_DIAG_DNS_FAILED, CP_DIAG_DNS_TIMEOUT,
    CP_DIAG_TLS_CONNECTING, CP_DIAG_TLS_FAILED, CP_DIAG_TLS_CERTIFICATE_FAILED, CP_DIAG_TLS_TIMEOUT,
    CP_DIAG_CLOUD_CHECKING, CP_DIAG_CLOUD_AUTH_FAILED, CP_DIAG_HTTP_FAILED,
    CP_DIAG_INVALID_CLOUD_REPLY, CP_DIAG_CLOUD_TIMEOUT, CP_DIAG_NETWORK_VALIDATED,
    CP_DIAG_SAVING, CP_DIAG_SAVE_FAILED, CP_DIAG_SAVED, CP_DIAG_NETWORK_STOP_FAILED,
    CP_DIAG_VALIDATION_TIMEOUT, CP_DIAG_VALIDATION_INTERRUPTED,
    CP_DIAG_RESOURCE_EXHAUSTED, CP_DIAG_CODE_COUNT
} cp_diag_code_t;
/* Safe numeric evidence only. No addresses, identifiers, SSIDs or secrets. Zero
 * in an error/status field means no such observation, never a guessed success. */
typedef struct {
    cp_diag_stage_t stage;
    cp_diag_code_t code;
    int32_t esp_err, http_status, wifi_reason, tls_code;
    uint32_t tls_flags, elapsed_ms;
    uint8_t retryable, terminal;
} cp_network_diagnostic_t;
typedef void (*cp_network_progress_fn)(const cp_network_diagnostic_t *,void *);
const char *cp_network_diag_stage_name(cp_diag_stage_t stage);
const char *cp_network_diag_code_name(cp_diag_code_t code);
void cp_network_diag_reset(cp_network_diagnostic_t *d);
void cp_network_diag_update(cp_network_diagnostic_t *d,cp_diag_stage_t stage,
    cp_diag_code_t code,esp_err_t error,uint32_t elapsed,bool retryable,bool terminal);
cp_diag_code_t cp_network_diag_wifi_reason(unsigned reason);
cp_diag_code_t cp_network_diag_timeout_code(const cp_network_diagnostic_t *d);
void cp_network_diag_finish_timeout(cp_network_diagnostic_t *d,uint32_t elapsed);
bool cp_network_diag_valid(const cp_network_diagnostic_t *d);
typedef enum { CP_ATTEMPT_INTERRUPTED=1, CP_ATTEMPT_FAILED, CP_ATTEMPT_SAVED } cp_attempt_state_t;
typedef struct {
    uint32_t version;
    cp_attempt_state_t state;
    char attempt_id[37], boot_id[37];
    cp_network_diagnostic_t diagnostic;
} cp_network_attempt_t;
/* Application task only, after cp_settings_init. Never erase NVS. At most one
 * start marker and one terminal record per explicit candidate; no poll writes. */
esp_err_t cp_network_attempt_load(cp_network_attempt_t *out);
esp_err_t cp_network_attempt_save(const cp_network_attempt_t *attempt);
bool cp_network_attempt_valid(const cp_network_attempt_t *attempt);
#endif
