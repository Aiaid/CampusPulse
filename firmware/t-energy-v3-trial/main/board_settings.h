#pragma once
#include "cp_settings.h"
/* Worker only. The validator must establish authenticated network/cloud
 * acceptance; ESP_OK means accepted, every other result prohibits saving. */
typedef esp_err_t (*te_v3_candidate_validator_t)(const cp_settings_t *, void *);
esp_err_t te_v3_settings_load(const char *node, cp_settings_t *out);
esp_err_t te_v3_settings_commit(const char *node, const cp_settings_t *candidate,
                                te_v3_candidate_validator_t validate, void *context);
