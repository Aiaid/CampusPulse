#include "board_settings.h"
#include <string.h>

static bool matches(const char *node, const cp_settings_t *settings) {
    return node && settings && memchr(settings->node_id, 0, sizeof settings->node_id) &&
           cp_settings_validate(settings) && strcmp(node, settings->node_id) == 0;
}
esp_err_t te_v3_settings_load(const char *node, cp_settings_t *out) {
    if (!node || !out) return ESP_ERR_INVALID_ARG;
    esp_err_t result = cp_settings_load(out);
    if (result != ESP_OK) { cp_settings_clear_sensitive(out); return result; }
    if (!matches(node, out)) { cp_settings_clear_sensitive(out); return ESP_ERR_INVALID_STATE; }
    return ESP_OK;
}
esp_err_t te_v3_settings_commit(const char *node, const cp_settings_t *candidate,
                                te_v3_candidate_validator_t validate, void *context) {
    if (!matches(node, candidate) || !validate) return ESP_ERR_INVALID_ARG;
    cp_settings_t frozen = *candidate;
    esp_err_t result = validate(&frozen, context);
    if (result == ESP_OK) result = cp_settings_save(&frozen);
    cp_settings_clear_sensitive(&frozen);
    return result;
}
