#include "cp_v3_budget_nvs.h"
#include "nvs.h"
#include <string.h>

static const char *const keys[2] = {"a", "b"};
static bool same_owner(const cp_v3_budget_record_t *a, const cp_v3_budget_record_t *b) {
    return !memcmp(a->owner_key, b->owner_key, CP_V3_BUDGET_OWNER_BYTES);
}
static bool forward(const cp_v3_budget_record_t *older, const cp_v3_budget_record_t *newer) {
    return same_owner(older, newer) && newer->sequence == older->sequence + 1u &&
        newer->utc_day >= older->utc_day &&
        newer->reserved_bytes && (newer->utc_day != older->utc_day || newer->reserved_bytes > older->reserved_bytes);
}
static cp_v3_budget_load_t load(void *context, void *out, size_t capacity, size_t *length) {
    cp_v3_budget_nvs_t *s = context;
    if (length) *length = 0;
    if (!s || !s->ready || !out || capacity < CP_V3_BUDGET_RECORD_BYTES || !length) return CP_V3_BUDGET_LOAD_IO;
    nvs_handle_t handle;
    esp_err_t error = nvs_open(s->namespace_name, NVS_READONLY, &handle);
    if (error == ESP_ERR_NVS_NOT_FOUND) return s->have_record ? CP_V3_BUDGET_LOAD_CORRUPT : CP_V3_BUDGET_LOAD_ABSENT;
    if (error != ESP_OK) return CP_V3_BUDGET_LOAD_IO;
    uint8_t bytes[2][CP_V3_BUDGET_RECORD_BYTES];
    cp_v3_budget_record_t records[2]; bool present[2] = {false, false};
    cp_v3_budget_load_t result = CP_V3_BUDGET_LOAD_PRESENT;
    for (unsigned i = 0; i < 2; i++) {
        size_t n = 0;
        error = nvs_get_blob(handle, keys[i], NULL, &n);
        if (error == ESP_ERR_NVS_NOT_FOUND) continue;
        if (error != ESP_OK) { result = CP_V3_BUDGET_LOAD_IO; break; }
        if (n != CP_V3_BUDGET_RECORD_BYTES) { result = CP_V3_BUDGET_LOAD_CORRUPT; break; }
        error = nvs_get_blob(handle, keys[i], bytes[i], &n);
        if (error != ESP_OK) { result = error == ESP_ERR_NVS_NOT_FOUND ? CP_V3_BUDGET_LOAD_CORRUPT : CP_V3_BUDGET_LOAD_IO; break; }
        if (n != CP_V3_BUDGET_RECORD_BYTES || !cp_v3_budget_decode(bytes[i], n, &records[i]) || !records[i].reserved_bytes) { result = CP_V3_BUDGET_LOAD_CORRUPT; break; }
        present[i] = true;
    }
    nvs_close(handle);
    if (result != CP_V3_BUDGET_LOAD_PRESENT) return result;
    if (!present[0] && !present[1]) return s->have_record ? CP_V3_BUDGET_LOAD_CORRUPT : CP_V3_BUDGET_LOAD_ABSENT;
    unsigned chosen = present[0] ? 0 : 1;
    if (present[0] && present[1]) {
        if (!same_owner(&records[0], &records[1])) return CP_V3_BUDGET_LOAD_CORRUPT;
        if (records[0].sequence == records[1].sequence) {
            if (memcmp(bytes[0], bytes[1], CP_V3_BUDGET_RECORD_BYTES)) return CP_V3_BUDGET_LOAD_CORRUPT;
        } else {
            chosen = records[0].sequence > records[1].sequence ? 0 : 1;
            if (!forward(&records[chosen ^ 1u], &records[chosen])) return CP_V3_BUDGET_LOAD_CORRUPT;
        }
    }
    if (s->have_record) {
        cp_v3_budget_record_t previous;
        if (!cp_v3_budget_decode(s->current, sizeof s->current, &previous) ||
            records[chosen].sequence < s->sequence ||
            (records[chosen].sequence == s->sequence && memcmp(s->current, bytes[chosen], sizeof s->current)) ||
            (records[chosen].sequence > s->sequence && !forward(&previous, &records[chosen]))) return CP_V3_BUDGET_LOAD_CORRUPT;
    }
    memcpy(out, bytes[chosen], CP_V3_BUDGET_RECORD_BYTES); *length = CP_V3_BUDGET_RECORD_BYTES;
    memcpy(s->current, bytes[chosen], sizeof s->current);
    s->sequence = records[chosen].sequence; s->active_slot = (int8_t)chosen; s->have_record = true;
    return CP_V3_BUDGET_LOAD_PRESENT;
}
static bool store(void *context, const void *record, size_t length) {
    cp_v3_budget_nvs_t *s = context; cp_v3_budget_record_t next;
    if (!s || !s->ready || !cp_v3_budget_decode(record, length, &next)) return false;
    uint8_t current[CP_V3_BUDGET_RECORD_BYTES]; size_t n = 0;
    cp_v3_budget_load_t loaded = load(s, current, sizeof current, &n);
    if (loaded != CP_V3_BUDGET_LOAD_ABSENT && loaded != CP_V3_BUDGET_LOAD_PRESENT) return false;
    if (loaded == CP_V3_BUDGET_LOAD_ABSENT) {
        if (next.sequence != 1) return false;
    } else {
        cp_v3_budget_record_t previous;
        if (!cp_v3_budget_decode(current, n, &previous) || !forward(&previous, &next)) return false;
    }
    unsigned target = s->have_record ? (unsigned)s->active_slot ^ 1u : 0;
    /* Preserve the same spare floor used by the small flash queue. available
     * excludes NVS-reserved entries; free_entries alone would overstate room.
     * One namespace + conservative blob index/chunk/entry allowance. */
    nvs_stats_t stats;
    if (nvs_get_stats(NULL, &stats) != ESP_OK ||
        stats.available_entries < CP_V3_BUDGET_NVS_FREE_ENTRY_FLOOR + (length + 31u) / 32u + 5u) return false;
    nvs_handle_t handle;
    if (nvs_open(s->namespace_name, NVS_READWRITE, &handle) != ESP_OK) return false;
    esp_err_t error = nvs_set_blob(handle, keys[target], record, length);
    if (error == ESP_OK) error = nvs_commit(handle);
    nvs_close(handle);
    if (error != ESP_OK) return false; /*May already have committed. Never undo. */
    uint8_t readback[CP_V3_BUDGET_RECORD_BYTES]; n = 0;
    return load(s, readback, sizeof readback, &n) == CP_V3_BUDGET_LOAD_PRESENT && n == length && !memcmp(record, readback, length);
}
esp_err_t cp_v3_budget_nvs_open(cp_v3_budget_nvs_t *s, const char *name, cp_v3_budget_store_t *out) {
    if (out) memset(out, 0, sizeof *out);
    if (!s || !out || !name || !*name || strnlen(name, 16) >= 16) return ESP_ERR_INVALID_ARG;
    for (const char *p = name; *p; p++) if (!((*p >= 'a' && *p <= 'z') || (*p >= '0' && *p <= '9') || *p == '_')) return ESP_ERR_INVALID_ARG;
    memset(s, 0, sizeof *s); memcpy(s->namespace_name, name, strlen(name) + 1);
    s->active_slot = -1; s->ready = true;
    uint8_t bytes[CP_V3_BUDGET_RECORD_BYTES]; size_t length = 0;
    cp_v3_budget_load_t result = load(s, bytes, sizeof bytes, &length);
    if (result == CP_V3_BUDGET_LOAD_IO || result == CP_V3_BUDGET_LOAD_CORRUPT) {
        s->ready = false; return result == CP_V3_BUDGET_LOAD_IO ? ESP_FAIL : ESP_ERR_INVALID_RESPONSE;
    }
    *out = (cp_v3_budget_store_t){.context = s, .load = load, .store = store, .logical_write_bytes = 4096};
    return ESP_OK;
}
