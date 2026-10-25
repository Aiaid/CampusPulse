#ifndef CP_SETTINGS_H
#define CP_SETTINGS_H
#include <stdbool.h>
#include <stdint.h>
#include "esp_err.h"
#define CP_SETTINGS_VERSION 1u
#define CP_API_ORIGIN "https://pulse.anend.net"
#define CP_SETTINGS_TOKEN_SIZE 193u
/* Application-owned ordinary NVS; this is not encryption at rest. */
typedef struct {
    uint32_t version;
    char node_id[16];
    char ssid[33];
    char password[65];
    char device_token[CP_SETTINGS_TOKEN_SIZE];
    char api_origin[64];
} cp_settings_t;
/* Does not erase NVS on any initialization/recovery error. */
esp_err_t cp_settings_init(void);
bool cp_settings_validate(const cp_settings_t *settings);
/* Missing enrollment returns ESP_ERR_NOT_FOUND. Output is cleared on errors. */
esp_err_t cp_settings_load(cp_settings_t *out);
/* Call only after the candidate's network/cloud validation succeeds. Writes an
 * inactive slot, commits it, then atomically commits the active-slot selector.
 * A rejected or interrupted candidate never overwrites the last active slot. */
esp_err_t cp_settings_save(const cp_settings_t *settings);
/* Call in early boot before any ADC, I2S or RF initialization. Creates a
 * cryptorandom 128-bit proof once; read or commit errors never replace it. */
esp_err_t cp_settings_setup_proof(char out[33]);
void cp_settings_clear_sensitive(cp_settings_t *settings);
#endif
