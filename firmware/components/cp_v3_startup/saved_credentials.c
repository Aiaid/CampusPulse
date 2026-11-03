#include "cp_v3_saved_credentials.h"
#include "cp_v3_startup.h"

void cp_v3_saved_credentials_load(const char *node, cp_v3_saved_credentials_t *out) {
    if (!out) return;
    cp_v3_saved_credentials_clear(out);
    if (!node) return;
    cp_v3_startup_profile_t profile;
    esp_err_t result = cp_v3_startup_load(node, &profile);
    if (result == ESP_OK) out->settings = profile.settings;
    cp_v3_startup_clear(&profile);
    if (result == ESP_ERR_NOT_FOUND) result = cp_settings_load_for_reuse(&out->settings);
    if (result == ESP_ERR_NOT_FOUND) {
        cp_v3_saved_credentials_clear(out);
        out->credential_state = out->mqtt_state = CP_V3_SAVED_MISSING;
        return;
    }
    if (result != ESP_OK || !cp_v3_saved_credential_ready(&out->settings, node)) {
        cp_v3_saved_credentials_clear(out);
        return;
    }
    out->credential_state = CP_V3_SAVED_READY;
    out->mqtt_state = cp_settings_mqtt_ready(&out->settings) ? CP_V3_SAVED_READY : CP_V3_SAVED_MISSING;
}
