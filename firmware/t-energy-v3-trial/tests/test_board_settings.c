#include "board_settings.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
static cp_settings_t saved;
static int load_result, validate_result, save_result, saves, validations;
bool cp_settings_validate(const cp_settings_t *s) { return s && s->version == 3; }
esp_err_t cp_settings_load(cp_settings_t *out) { *out = saved; return load_result; }
esp_err_t cp_settings_save(const cp_settings_t *s) { ++saves; if (save_result == ESP_OK) saved = *s; return save_result; }
void cp_settings_clear_sensitive(cp_settings_t *s) { memset(s, 0, sizeof *s); }
static esp_err_t cloud(const cp_settings_t *s, void *ctx) { (void)s; (void)ctx; ++validations; return validate_result; }
int main(void) {
    cp_settings_t candidate = {.version = 3}, out;
    strcpy(candidate.node_id, "cp_a"); strcpy(candidate.password, "secret");
    saved = candidate;
    assert(te_v3_settings_load("cp_a", &out) == ESP_OK);
    assert(te_v3_settings_load("cp_b", &out) == ESP_ERR_INVALID_STATE && !out.password[0]);
    load_result = ESP_ERR_NOT_FOUND;
    assert(te_v3_settings_load("cp_a", &out) == ESP_ERR_NOT_FOUND && !out.password[0]);
    assert(te_v3_settings_commit("cp_a", &candidate, NULL, NULL) == ESP_ERR_INVALID_ARG);
    assert(te_v3_settings_commit("cp_b", &candidate, cloud, NULL) == ESP_ERR_INVALID_ARG);
    assert(!validations && !saves);
    validate_result = ESP_FAIL;
    assert(te_v3_settings_commit("cp_a", &candidate, cloud, NULL) == ESP_FAIL && saves == 0);
    validate_result = ESP_OK;
    save_result = ESP_FAIL;
    assert(te_v3_settings_commit("cp_a", &candidate, cloud, NULL) == ESP_FAIL && saves == 1);
    save_result = ESP_OK;
    assert(te_v3_settings_commit("cp_a", &candidate, cloud, NULL) == ESP_OK && saves == 2);
    candidate.version = 0;
    assert(te_v3_settings_commit("cp_a", &candidate, cloud, NULL) == ESP_ERR_INVALID_ARG && saves == 2);
    puts("board settings tests passed");
}
