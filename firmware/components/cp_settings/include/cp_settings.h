#ifndef CP_SETTINGS_H
#define CP_SETTINGS_H
#include <stdbool.h>
#include <stdint.h>
#include "esp_err.h"
#define CP_SETTINGS_VERSION 3u
#define CP_WIFI_PERSONAL 0u
#define CP_WIFI_OPEN 1u
#define CP_WIFI_ENTERPRISE_PEAP 2u
#define CP_API_ORIGIN "https://pulse.anend.net"
#define CP_SETTINGS_TOKEN_SIZE 193u
#define CP_MQTT_PRODUCTION_URI "mqtts://q9a692f8.ala.cn-hangzhou.emqxsl.cn:8883"
#define CP_MQTT_CA_PROFILE "public-ca-bundle"
#define CP_SETTINGS_MQTT_USERNAME_SIZE 65u
#define CP_SETTINGS_MQTT_PASSWORD_SIZE 97u
/* Application-owned ordinary NVS; this is not encryption at rest. */
typedef struct {
    uint32_t version;
    char node_id[16];
    char ssid[33];
    char password[65];
    char device_token[CP_SETTINGS_TOKEN_SIZE];
    char api_origin[64];
    uint32_t wifi_security;
    char eap_username[129], eap_identity[129], eap_password[129];
    char mqtt_uri[64], mqtt_username[CP_SETTINGS_MQTT_USERNAME_SIZE];
    char mqtt_password[CP_SETTINGS_MQTT_PASSWORD_SIZE], mqtt_namespace[16];
} cp_settings_t;
/* Does not erase NVS on any initialization/recovery error. */
esp_err_t cp_settings_init(void);
bool cp_settings_validate(const cp_settings_t *settings);
/* All-empty MQTT fields are accepted by validate only to retain migrated v1/v2
 * credentials. Production network admission and new candidates require ready. */
bool cp_settings_mqtt_ready(const cp_settings_t *settings);
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
