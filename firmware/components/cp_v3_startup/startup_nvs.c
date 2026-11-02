#include "cp_v3_startup.h"
#include "nvs.h"
#include "nvs_flash.h"
#include "mbedtls/pk.h"
#include "mbedtls/ecp.h"
#include <string.h>

static const char *const slots[] = {"a", "b"};
static const char *const namespace_name = "cpv3start";
static void wipe(void *data, size_t size) { volatile uint8_t *p = data; while (size--) *p++ = 0; }
static bool valid_key(const cp_v3_startup_profile_t *p) {
    mbedtls_pk_context key; mbedtls_pk_init(&key);
    bool ok = mbedtls_pk_parse_public_key(&key, p->time_public_spki, p->time_public_spki_len) == 0 &&
        mbedtls_pk_get_type(&key) == MBEDTLS_PK_ECKEY;
    if (ok) {
        mbedtls_ecp_keypair *ec = mbedtls_pk_ec(key);
        ok = ec && ec->MBEDTLS_PRIVATE(grp).id == MBEDTLS_ECP_DP_SECP256R1 &&
            mbedtls_ecp_check_pubkey(&ec->MBEDTLS_PRIVATE(grp), &ec->MBEDTLS_PRIVATE(Q)) == 0;
    }
    mbedtls_pk_free(&key); return ok;
}
esp_err_t cp_v3_startup_init(void) { return nvs_flash_init(); }

/* Absence means the entire dedicated profile store has no selector or slots.
 * A first-save crash can leave an orphan blob; deliberate USB recovery must
 * handle that case explicitly instead of silently promoting it on reboot. */
static esp_err_t selected(nvs_handle_t handle, uint8_t *slot) {
    esp_err_t error = nvs_get_u8(handle, "active", slot);
    if (error == ESP_OK) return *slot <= 1 ? ESP_OK : ESP_ERR_INVALID_STATE;
    if (error != ESP_ERR_NVS_NOT_FOUND) return error;
    for (unsigned i = 0; i < 2; ++i) {
        size_t size = 0; error = nvs_get_blob(handle, slots[i], NULL, &size);
        if (error == ESP_OK) return ESP_ERR_INVALID_STATE;
        if (error != ESP_ERR_NVS_NOT_FOUND) return error;
    }
    return ESP_ERR_NOT_FOUND;
}
static esp_err_t read_profile(nvs_handle_t handle, uint8_t slot, const char *node,
    cp_v3_startup_profile_t *out) {
    uint8_t bytes[CP_V3_STARTUP_MAX_BYTES]; size_t size = 0;
    esp_err_t error = nvs_get_blob(handle, slots[slot], NULL, &size);
    if (error == ESP_ERR_NVS_NOT_FOUND) return ESP_ERR_INVALID_STATE;
    if (error != ESP_OK) return error;
    if (!size || size > sizeof bytes) return ESP_ERR_INVALID_SIZE;
    error = nvs_get_blob(handle, slots[slot], bytes, &size);
    if (error == ESP_OK && (!cp_v3_startup_decode(bytes, size, node, out) || !valid_key(out))) error = ESP_ERR_INVALID_RESPONSE;
    wipe(bytes, sizeof bytes);
    if (error != ESP_OK) cp_v3_startup_clear(out);
    return error;
}
esp_err_t cp_v3_startup_load(const char *node, cp_v3_startup_profile_t *out) {
    if (!out) return ESP_ERR_INVALID_ARG;
    cp_v3_startup_clear(out);
    if (!node) return ESP_ERR_INVALID_ARG;
    nvs_handle_t handle; esp_err_t error = nvs_open(namespace_name, NVS_READONLY, &handle);
    if (error == ESP_ERR_NVS_NOT_FOUND) return ESP_ERR_NOT_FOUND;
    if (error != ESP_OK) return error;
    uint8_t slot = 0; error = selected(handle, &slot);
    if (error == ESP_OK) error = read_profile(handle, slot, node, out);
    nvs_close(handle);
    if (error != ESP_OK) cp_v3_startup_clear(out);
    return error;
}
static bool recoverable(esp_err_t error) {
    return error == ESP_ERR_INVALID_STATE || error == ESP_ERR_INVALID_SIZE ||
        error == ESP_ERR_INVALID_RESPONSE || error == ESP_ERR_NVS_NOT_FOUND ||
        error == ESP_ERR_NVS_TYPE_MISMATCH;
}
static esp_err_t save(const cp_v3_startup_profile_t *p, bool explicit_recovery) {
    if (!cp_v3_startup_validate(p, NULL) || !valid_key(p)) return ESP_ERR_INVALID_ARG;
    uint8_t bytes[CP_V3_STARTUP_MAX_BYTES]; size_t size = 0;
    if (!cp_v3_startup_encode(p, bytes, sizeof bytes, &size)) return ESP_ERR_INVALID_ARG;
    esp_err_t error; nvs_handle_t handle;
    nvs_stats_t stats;
    error = nvs_get_stats(NULL, &stats);
    /* Namespace, blob index/chunk and selector overhead + retained free floor.
     * Never substitute free_entries: available excludes SDK-reserved entries. */
    if (error == ESP_OK && stats.available_entries < CP_V3_STARTUP_NVS_FREE_ENTRY_FLOOR + (size + 31u) / 32u + 7u) error = ESP_ERR_NO_MEM;
    if (error != ESP_OK) { wipe(bytes, sizeof bytes); return error; }
    error = nvs_open(namespace_name, NVS_READWRITE, &handle);
    if (error != ESP_OK) { wipe(bytes, sizeof bytes); return error; }
    uint8_t active = 0; error = selected(handle, &active);
    cp_v3_startup_profile_t previous;
    if (error == ESP_OK) {
        error = read_profile(handle, active, p->settings.node_id, &previous);
        if (explicit_recovery && recoverable(error)) error = ESP_OK;
    }
    else if (error == ESP_ERR_NOT_FOUND) { active = 1; error = ESP_OK; }
    else if (explicit_recovery && recoverable(error)) {
        /* If the selector has a valid value preserve its selected bytes even
         * when corrupt. Missing/type-corrupt selectors confer no authority. */
        uint8_t old = 2;
        esp_err_t inspected = nvs_get_u8(handle, "active", &old);
        if (inspected == ESP_OK) { active = old <= 1 ? old : 1; error = ESP_OK; }
        else if (inspected == ESP_ERR_NVS_NOT_FOUND || inspected == ESP_ERR_NVS_TYPE_MISMATCH) { active = 1; error = ESP_OK; }
        else error = inspected;
    }
    cp_v3_startup_clear(&previous);
    uint8_t target = active ^ 1u;
    if (error == ESP_OK) error = nvs_set_blob(handle, slots[target], bytes, size);
    if (explicit_recovery && error == ESP_ERR_NVS_TYPE_MISMATCH) {
        error = nvs_erase_key(handle, slots[target]);
        if (error == ESP_OK) error = nvs_commit(handle);
        if (error == ESP_OK) error = nvs_set_blob(handle, slots[target], bytes, size);
    }
    if (error == ESP_OK) error = nvs_commit(handle);
    /* Close/reopen ensures verification observes committed data, not pending
     * handle state. A failed/uncertain commit never advances the selector. */
    nvs_close(handle);
    if (error == ESP_OK) {
        error = nvs_open(namespace_name, NVS_READONLY, &handle);
        if (error == ESP_OK) {
            uint8_t readback[CP_V3_STARTUP_MAX_BYTES]; size_t n = sizeof readback;
            error = nvs_get_blob(handle, slots[target], readback, &n);
            if (error == ESP_OK && (n != size || memcmp(readback, bytes, size))) error = ESP_ERR_INVALID_RESPONSE;
            wipe(readback, sizeof readback); nvs_close(handle);
        }
    }
    if (error == ESP_OK) {
        error = nvs_open(namespace_name, NVS_READWRITE, &handle);
        if (error == ESP_OK) {
            error = nvs_set_u8(handle, "active", target);
            if (explicit_recovery && error == ESP_ERR_NVS_TYPE_MISMATCH) {
                error = nvs_erase_key(handle, "active");
                if (error == ESP_OK) error = nvs_commit(handle);
                if (error == ESP_OK) error = nvs_set_u8(handle, "active", target);
            }
            if (error == ESP_OK) error = nvs_commit(handle);
            nvs_close(handle);
        }
    }
    if (error == ESP_OK) {
        error = nvs_open(namespace_name, NVS_READONLY, &handle);
        if (error == ESP_OK) {
            uint8_t verified = 2; error = nvs_get_u8(handle, "active", &verified);
            if (error == ESP_OK && verified != target) error = ESP_ERR_INVALID_RESPONSE;
            nvs_close(handle);
        }
    }
    wipe(bytes, sizeof bytes); return error;
}
esp_err_t cp_v3_startup_save(const cp_v3_startup_profile_t *p) { return save(p, false); }
esp_err_t cp_v3_startup_reconfigure(const cp_v3_startup_profile_t *p) {
    if (!cp_v3_startup_validate(p, NULL) || !valid_key(p)) return ESP_ERR_INVALID_ARG;
    cp_v3_startup_profile_t existing;
    esp_err_t error = cp_v3_startup_load(p->settings.node_id, &existing);
    cp_v3_startup_clear(&existing);
    if (error == ESP_OK || error == ESP_ERR_NOT_FOUND) return cp_v3_startup_save(p);
    if (!recoverable(error)) return error;
    return save(p, true);
}
