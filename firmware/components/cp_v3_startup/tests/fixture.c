#include "cp_v3_startup.h"
#include "nvs.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

typedef struct {
    bool exists, selected, have[2], wrong_selector_type, wrong_blob_type[2]; uint8_t active;
    uint8_t bytes[2][CP_V3_STARTUP_MAX_BYTES]; size_t sizes[2];
} store_t;
static store_t durable, pending;
static size_t available = 1024;
static int commits, fail_commit, blob_reads, fail_blob_read, selector_reads, fail_selector_read;
static bool after_commit, fail_blob_write, fail_selector_write, fail_open, fail_stats, fail_erase;
static unsigned mutations;
static const unsigned char unrelated[] = "immutable legacy settings, credentials, queues and capture bytes";
static unsigned char legacy[sizeof unrelated];
static void reset_faults(void) {
    commits = fail_commit = blob_reads = fail_blob_read = selector_reads = fail_selector_read = 0;
    after_commit = fail_blob_write = fail_selector_write = fail_open = fail_stats = fail_erase = false;
    available = 1024; mutations = 0;
}
static void fresh(void) { memset(&durable, 0, sizeof durable); memcpy(legacy, unrelated, sizeof legacy); reset_faults(); }
esp_err_t nvs_flash_init(void) { return ESP_OK; }
esp_err_t nvs_open(const char *name, int mode, nvs_handle_t *handle) {
    assert(!strcmp(name, "cpv3start"));
    if (fail_open) return ESP_FAIL;
    if (!durable.exists && mode == NVS_READONLY) return ESP_ERR_NVS_NOT_FOUND;
    pending = durable; *handle = mode + 1; return ESP_OK;
}
void nvs_close(nvs_handle_t handle) { (void)handle; }
esp_err_t nvs_get_stats(const char *partition, nvs_stats_t *stats) {
    assert(!partition); if (fail_stats) return ESP_FAIL;
    *stats = (nvs_stats_t){.available_entries = available, .free_entries = 99999}; return ESP_OK;
}
esp_err_t nvs_get_u8(nvs_handle_t handle, const char *key, uint8_t *value) {
    (void)handle; assert(!strcmp(key, "active"));
    if (++selector_reads == fail_selector_read) return ESP_FAIL;
    if (durable.wrong_selector_type) return ESP_ERR_NVS_TYPE_MISMATCH;
    if (!durable.selected) return ESP_ERR_NVS_NOT_FOUND;
    *value = durable.active; return ESP_OK;
}
esp_err_t nvs_set_u8(nvs_handle_t handle, const char *key, uint8_t value) {
    assert(handle == NVS_READWRITE + 1 && !strcmp(key, "active"));
    if (fail_selector_write) return ESP_FAIL;
    if (pending.wrong_selector_type) return ESP_ERR_NVS_TYPE_MISMATCH;
    pending.exists = pending.selected = true; pending.active = value; ++mutations; return ESP_OK;
}
static unsigned slot(const char *key) { assert(!strcmp(key, "a") || !strcmp(key, "b")); return key[0] == 'b'; }
esp_err_t nvs_get_blob(nvs_handle_t handle, const char *key, void *out, size_t *size) {
    (void)handle; unsigned i = slot(key);
    if (durable.wrong_blob_type[i]) return ESP_ERR_NVS_TYPE_MISMATCH;
    if (out && ++blob_reads == fail_blob_read) return ESP_FAIL;
    if (!durable.have[i]) return ESP_ERR_NVS_NOT_FOUND;
    if (!out) { *size = durable.sizes[i]; return ESP_OK; }
    if (*size < durable.sizes[i]) return ESP_ERR_INVALID_SIZE;
    memcpy(out, durable.bytes[i], durable.sizes[i]); *size = durable.sizes[i]; return ESP_OK;
}
esp_err_t nvs_set_blob(nvs_handle_t handle, const char *key, const void *data, size_t size) {
    assert(handle == NVS_READWRITE + 1); unsigned i = slot(key);
    if (fail_blob_write) return ESP_FAIL;
    if (pending.wrong_blob_type[i]) return ESP_ERR_NVS_TYPE_MISMATCH;
    assert(size <= sizeof pending.bytes[i]);
    pending.exists = pending.have[i] = true; pending.sizes[i] = size;
    memcpy(pending.bytes[i], data, size); ++mutations; return ESP_OK;
}
esp_err_t nvs_erase_key(nvs_handle_t handle, const char *key) {
    assert(handle == NVS_READWRITE + 1);
    if (fail_erase) return ESP_FAIL;
    if (!strcmp(key, "active")) { pending.selected = false; pending.wrong_selector_type = false; }
    else { unsigned i = slot(key); pending.have[i] = false; pending.wrong_blob_type[i] = false; }
    ++mutations; return ESP_OK;
}
esp_err_t nvs_commit(nvs_handle_t handle) {
    assert(handle == NVS_READWRITE + 1); ++commits;
    if (commits == fail_commit && !after_commit) return ESP_FAIL;
    durable = pending;
    if (commits == fail_commit) return ESP_FAIL;
    return ESP_OK;
}
static cp_v3_startup_profile_t profile(void) {
    cp_v3_startup_profile_t p = { .settings.version = CP_SETTINGS_VERSION, .auto_start = true };
    strcpy(p.settings.node_id, "cp_aabbccddeeff"); strcpy(p.settings.ssid, "synthetic-ap");
    strcpy(p.settings.password, "synthetic-password"); memset(p.settings.device_token, 'x', 40);
    strcpy(p.settings.api_origin, CP_API_ORIGIN); strcpy(p.settings.mqtt_uri, CP_MQTT_PRODUCTION_URI);
    strcpy(p.settings.mqtt_username, "fixture_pool"); strcpy(p.settings.mqtt_password, "synthetic-broker-password");
    strcpy(p.settings.mqtt_namespace, "fixture_pool"); strcpy(p.time_key_id, "synthetic-key-1");
    /* NIST P-256 generator point, public/non-secret test key. */
    static const uint8_t der[] = {
        0x30,0x59,0x30,0x13,0x06,0x07,0x2a,0x86,0x48,0xce,0x3d,0x02,0x01,
        0x06,0x08,0x2a,0x86,0x48,0xce,0x3d,0x03,0x01,0x07,0x03,0x42,0x00,0x04,
        0x6b,0x17,0xd1,0xf2,0xe1,0x2c,0x42,0x47,0xf8,0xbc,0xe6,0xe5,0x63,0xa4,0x40,0xf2,
        0x77,0x03,0x7d,0x81,0x2d,0xeb,0x33,0xa0,0xf4,0xa1,0x39,0x45,0xd8,0x98,0xc2,0x96,
        0x4f,0xe3,0x42,0xe2,0xfe,0x1a,0x7f,0x9b,0x8e,0xe7,0xeb,0x4a,0x7c,0x0f,0x9e,0x16,
        0x2b,0xce,0x33,0x57,0x6b,0x31,0x5e,0xce,0xcb,0xb6,0x40,0x68,0x37,0xbf,0x51,0xf5
    };
    memcpy(p.time_public_spki, der, sizeof der); p.time_public_spki_len = sizeof der; return p;
}
static void cleared(const cp_v3_startup_profile_t *p) {
    const unsigned char *bytes = (const unsigned char *)p;
    for (size_t i = 0; i < sizeof *p; ++i) assert(bytes[i] == 0);
}
static void old_profile(void) {
    cp_v3_startup_profile_t out; assert(cp_v3_startup_load("cp_aabbccddeeff", &out) == ESP_OK);
    assert(!strcmp(out.settings.ssid, "synthetic-ap")); cp_v3_startup_clear(&out);
    assert(!memcmp(legacy, unrelated, sizeof legacy));
}
static void codec(void) {
    cp_v3_startup_profile_t p = profile(), out; uint8_t bytes[CP_V3_STARTUP_MAX_BYTES], changed[sizeof bytes]; size_t n;
    assert(cp_v3_startup_encode(&p, bytes, sizeof bytes, &n));
    assert(n < 420 && !memcmp(bytes, "CPS3\1\0\1\0", 8));
    assert(cp_v3_startup_decode(bytes, n, p.settings.node_id, &out)); assert(!memcmp(&p, &out, sizeof p));
    for (size_t cut = 0; cut < n; ++cut) { memset(&out, 0xab, sizeof out); assert(!cp_v3_startup_decode(bytes, cut, p.settings.node_id, &out)); cleared(&out); }
    for (size_t i = 0; i < n; ++i) { memcpy(changed, bytes, n); changed[i] ^= 1; assert(!cp_v3_startup_decode(changed, n, p.settings.node_id, &out)); cleared(&out); }
    assert(!cp_v3_startup_decode(bytes, n, "cp_112233445566", &out)); cleared(&out);
    assert(!cp_v3_startup_encode(&p, changed, n - 1, &n) && n == 0);
    p.auto_start = false; p.settings.wifi_security = CP_WIFI_ENTERPRISE_PEAP; p.settings.password[0] = 0;
    memset(p.settings.eap_username, 'u', 128); memset(p.settings.eap_identity, 'i', 128); memset(p.settings.eap_password, 'p', 128);
    assert(cp_v3_startup_encode(&p, bytes, sizeof bytes, &n)); assert(n < CP_V3_STARTUP_MAX_BYTES);
    assert(cp_v3_startup_decode(bytes, n, p.settings.node_id, &out));
    p.auto_start = true; assert(!cp_v3_startup_validate(&p, NULL));
    p = profile(); strcpy(p.settings.mqtt_uri, "mqtts://fixture.invalid:8883"); assert(!cp_v3_startup_validate(&p, NULL));
    p = profile(); strcpy(p.settings.api_origin, "https://fixture.invalid"); assert(!cp_v3_startup_validate(&p, NULL));
    p = profile(); p.settings.mqtt_password[0] = 0; assert(!cp_v3_startup_validate(&p, NULL));
    p = profile(); p.time_key_id[0] = 0; assert(!cp_v3_startup_validate(&p, NULL));
    p = profile(); p.time_public_spki_len = 90; assert(!cp_v3_startup_validate(&p, NULL));
    p = profile(); p.time_public_spki[30] ^= 1; assert(cp_v3_startup_save(&p) == ESP_ERR_INVALID_ARG);
    /* Well-framed, CRC-correct, wrong EC point is still rejected by the actual
     * provider crypto validation. CRC alone is never authentication. */
    fresh(); assert(cp_v3_startup_encode(&p, bytes, sizeof bytes, &n));
    durable.exists = durable.selected = durable.have[0] = true; durable.active = 0;
    durable.sizes[0] = n; memcpy(durable.bytes[0], bytes, n);
    assert(cp_v3_startup_load(p.settings.node_id, &out) != ESP_OK); cleared(&out);

}
int main(void) {
    fresh(); assert(cp_v3_startup_init() == ESP_OK); codec();
    cp_v3_startup_profile_t p = profile(), candidate = p, out;
    strcpy(candidate.settings.ssid, "candidate-ap");
    fresh(); assert(cp_v3_startup_load(p.settings.node_id, &out) == ESP_ERR_NOT_FOUND); cleared(&out);
    assert(cp_v3_startup_save(&p) == ESP_OK); old_profile(); store_t old = durable;
    /* A later unselected candidate is not authority, including if corrupt. */
    durable.have[old.active ^ 1u] = true; durable.sizes[old.active ^ 1u] = 11;
    memset(durable.bytes[old.active ^ 1u], 0xab, 11); old_profile(); durable = old;
    assert(cp_v3_startup_load("cp_112233445566", &out) != ESP_OK); cleared(&out);
    for (int event = 0; event < 9; ++event) {
        durable = old; reset_faults();
        if (event == 0) fail_blob_write = true;
        if (event == 1) { fail_commit = 1; after_commit = false; }
        if (event == 2) { fail_commit = 1; after_commit = true; }
        if (event == 3) fail_blob_read = 2; /* selected read then inactive readback */
        if (event == 4) fail_selector_write = true;
        if (event == 5) { fail_commit = 2; after_commit = false; }
        if (event == 6) available = CP_V3_STARTUP_NVS_FREE_ENTRY_FLOOR;
        if (event == 7) fail_stats = true;
        if (event == 8) fail_open = true;
        assert(cp_v3_startup_save(&candidate) != ESP_OK);
        if (event >= 6) assert(!mutations);
        reset_faults(); old_profile();
        assert(!memcmp(durable.bytes[old.active], old.bytes[old.active], old.sizes[old.active]));
    }
    durable = old; reset_faults(); fail_commit = 2; after_commit = true;
    assert(cp_v3_startup_save(&candidate) != ESP_OK); reset_faults();
    assert(cp_v3_startup_load(p.settings.node_id, &out) == ESP_OK && !strcmp(out.settings.ssid, "candidate-ap"));
    durable = old; reset_faults(); fail_selector_read = 2;
    assert(cp_v3_startup_save(&candidate) != ESP_OK); reset_faults();
    assert(cp_v3_startup_load(p.settings.node_id, &out) == ESP_OK && !strcmp(out.settings.ssid, "candidate-ap"));
    durable = old; durable.active = 2; assert(cp_v3_startup_load(p.settings.node_id, &out) != ESP_OK); cleared(&out);
    assert(cp_v3_startup_save(&p) != ESP_OK);
    durable = old; durable.have[durable.active] = false; assert(cp_v3_startup_load(p.settings.node_id, &out) != ESP_OK); cleared(&out);
    durable = old; durable.bytes[durable.active][30] ^= 1; assert(cp_v3_startup_load(p.settings.node_id, &out) != ESP_OK); cleared(&out);
    durable = old; durable.selected = false; assert(cp_v3_startup_load(p.settings.node_id, &out) != ESP_OK); cleared(&out);
    assert(cp_v3_startup_save(&p) != ESP_OK); /* never promote orphan/higher inactive */
    fresh(); fail_commit = 1; after_commit = true; assert(cp_v3_startup_save(&p) != ESP_OK); reset_faults();
    assert(cp_v3_startup_load(p.settings.node_id, &out) != ESP_OK); cleared(&out);
    assert(!memcmp(legacy, unrelated, sizeof legacy));
    assert(cp_v3_startup_reconfigure(&candidate) == ESP_OK);
    assert(cp_v3_startup_load(p.settings.node_id, &out) == ESP_OK && !strcmp(out.settings.ssid, "candidate-ap"));
    /* Every recovery uses freshly approved input, never an orphaned candidate. */
    for (unsigned state = 0; state < 6; ++state) {
        durable = old; reset_faults();
        if (state == 0) durable.selected = false;
        if (state == 1) durable.active = 3;
        if (state == 2) durable.wrong_selector_type = true;
        if (state == 3) durable.wrong_blob_type[durable.active] = true;
        if (state == 4) durable.bytes[durable.active][30] ^= 1;
        if (state == 5) durable.have[durable.active] = false;
        assert(cp_v3_startup_save(&candidate) != ESP_OK); reset_faults();
        assert(cp_v3_startup_reconfigure(&candidate) == ESP_OK);
        assert(cp_v3_startup_load(p.settings.node_id, &out) == ESP_OK && !strcmp(out.settings.ssid, "candidate-ap"));
        assert(!memcmp(legacy, unrelated, sizeof legacy));
    }
    /* Recovery may remove only individual wrong-type keys; combined maximum
     * candidate/selector type repair needs four commits, budgeted at 16KiB. */
    durable = old; reset_faults(); durable.wrong_selector_type = durable.wrong_blob_type[0] = true;
    assert(cp_v3_startup_reconfigure(&candidate) == ESP_OK && commits == 4);
    assert(cp_v3_startup_load(p.settings.node_id, &out) == ESP_OK && !strcmp(out.settings.ssid, "candidate-ap"));
    for (int commit = 1; commit <= 4; ++commit) for (unsigned persisted = 0; persisted < 2; ++persisted) {
        durable = old; reset_faults(); durable.wrong_selector_type = durable.wrong_blob_type[0] = true;
        fail_commit = commit; after_commit = persisted != 0;
        assert(cp_v3_startup_reconfigure(&candidate) != ESP_OK); reset_faults();
        if (commit == 4 && persisted) {
            assert(cp_v3_startup_load(p.settings.node_id, &out) == ESP_OK && !strcmp(out.settings.ssid, "candidate-ap"));
        } else { assert(cp_v3_startup_load(p.settings.node_id, &out) != ESP_OK); cleared(&out); }
        assert(!memcmp(legacy, unrelated, sizeof legacy));
    }
    durable = old; reset_faults(); durable.wrong_selector_type = durable.wrong_blob_type[0] = true; fail_erase = true;
    assert(cp_v3_startup_reconfigure(&candidate) != ESP_OK); reset_faults();
    assert(cp_v3_startup_load(p.settings.node_id, &out) != ESP_OK); cleared(&out);
    for (unsigned event = 0; event < 4; ++event) {
        durable = old; durable.selected = false; reset_faults();
        if (event == 0) fail_blob_write = true;
        if (event == 1) fail_blob_read = 1; /* no selected profile read */
        if (event == 2) fail_selector_write = true;
        if (event == 3) { fail_commit = 2; after_commit = false; }
        assert(cp_v3_startup_reconfigure(&candidate) != ESP_OK); reset_faults();
        assert(cp_v3_startup_load(p.settings.node_id, &out) != ESP_OK); cleared(&out);
        assert(!memcmp(legacy, unrelated, sizeof legacy));
    }
    puts("startup codec, production/PEAP gates, NVS faults and preservation passed");
    return 0;
}
