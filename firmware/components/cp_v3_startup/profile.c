#include "cp_v3_startup.h"
#include <string.h>

enum { HEADER = 16, VERSION = 1 };
static const uint8_t p256_prefix[] = {
    0x30,0x59,0x30,0x13,0x06,0x07,0x2a,0x86,0x48,0xce,0x3d,0x02,0x01,
    0x06,0x08,0x2a,0x86,0x48,0xce,0x3d,0x03,0x01,0x07,0x03,0x42,0x00,0x04
};
static void wipe(void *data, size_t size) {
    volatile uint8_t *p = data; while (size--) *p++ = 0;
}
void cp_v3_startup_clear(cp_v3_startup_profile_t *p) { if (p) wipe(p, sizeof *p); }
static size_t length(const char *s, size_t capacity) {
    const char *end = memchr(s, 0, capacity); return end ? (size_t)(end - s) : capacity;
}
static uint32_t crc32(const uint8_t *p, size_t n) {
    uint32_t crc = UINT32_MAX;
    for (size_t i = 0; i < n; ++i) {
        crc ^= p[i];
        for (unsigned bit = 0; bit < 8; ++bit) crc = (crc >> 1) ^ (0xedb88320u & (0u - (crc & 1u)));
    }
    return ~crc;
}
static void put16(uint8_t *p, uint16_t n) { p[0] = (uint8_t)n; p[1] = (uint8_t)(n >> 8); }
static void put32(uint8_t *p, uint32_t n) { for (unsigned i = 0; i < 4; ++i) p[i] = (uint8_t)(n >> (i * 8)); }
static uint16_t get16(const uint8_t *p) { return (uint16_t)p[0] | (uint16_t)((uint16_t)p[1] << 8); }
static uint32_t get32(const uint8_t *p) { return (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24; }
bool cp_v3_startup_validate(const cp_v3_startup_profile_t *p, const char *node) {
    if (!p || !cp_settings_validate(&p->settings) || !cp_settings_mqtt_ready(&p->settings) ||
        (p->auto_start && p->settings.wifi_security == CP_WIFI_ENTERPRISE_PEAP) ||
        p->time_public_spki_len != CP_V3_STARTUP_TIME_SPKI_BYTES ||
        memcmp(p->time_public_spki, p256_prefix, sizeof p256_prefix)) return false;
    if (node && (length(node, sizeof p->settings.node_id) != 15 || memcmp(node, p->settings.node_id, 16))) return false;
    size_t n = length(p->time_key_id, sizeof p->time_key_id);
    if (!n || n == sizeof p->time_key_id) return false;
    for (size_t i = 0; i < n; ++i) {
        char c = p->time_key_id[i];
        if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
              (c >= '0' && c <= '9') || c == '_' || c == '-')) return false;
    }
    uint8_t nonzero = 0;
    for (size_t i = sizeof p256_prefix; i < p->time_public_spki_len; ++i) nonzero |= p->time_public_spki[i];
    return nonzero != 0;
}

/* Strings use lengths and bytes only. No compiler padding, unused credential
 * suffixes or irrelevant empty PEAP arrays reach Flash. Endpoints are fixed by
 * this schema's production contract and reconstructed, never arbitrary input. */
#define PROFILE_STRINGS(X) \
    X(settings.node_id) X(settings.ssid) X(settings.password) X(settings.device_token) \
    X(settings.eap_username) X(settings.eap_identity) X(settings.eap_password) \
    X(settings.mqtt_username) X(settings.mqtt_password) X(settings.mqtt_namespace) X(time_key_id)

bool cp_v3_startup_encode(const cp_v3_startup_profile_t *p, void *out, size_t capacity, size_t *written) {
    if (written) *written = 0;
    if (!out || !written || !cp_v3_startup_validate(p, NULL)) return false;
    uint8_t bytes[CP_V3_STARTUP_MAX_BYTES] = {0}; size_t pos = HEADER;
    put32(bytes + pos, p->settings.wifi_security); pos += 4;
#define WRITE_STRING(field) do { size_t n = length(p->field, sizeof p->field); \
    if (pos + 2 + n > sizeof bytes) { wipe(bytes, sizeof bytes); return false; } \
    put16(bytes + pos, (uint16_t)n); pos += 2; memcpy(bytes + pos, p->field, n); pos += n; } while (0);
    PROFILE_STRINGS(WRITE_STRING)
#undef WRITE_STRING
    put16(bytes + pos, p->time_public_spki_len); pos += 2;
    memcpy(bytes + pos, p->time_public_spki, p->time_public_spki_len); pos += p->time_public_spki_len;
    memcpy(bytes, "CPS3", 4); put16(bytes + 4, VERSION); put16(bytes + 6, p->auto_start ? 1u : 0u);
    put32(bytes + 8, (uint32_t)pos);
    /* CRC covers framing including flags/length, with its own field zero. */
    put32(bytes + 12, crc32(bytes, pos));
    bool ok = capacity >= pos;
    if (ok) { memcpy(out, bytes, pos); *written = pos; }
    wipe(bytes, sizeof bytes); return ok;
}

bool cp_v3_startup_decode(const void *input, size_t size, const char *node, cp_v3_startup_profile_t *out) {
    if (!out) return false;
    cp_v3_startup_clear(out);
    if (!input || size < HEADER + 4 || size > CP_V3_STARTUP_MAX_BYTES) return false;
    uint8_t bytes[CP_V3_STARTUP_MAX_BYTES]; memcpy(bytes, input, size);
    uint32_t expected = get32(bytes + 12); put32(bytes + 12, 0);
    bool ok = !memcmp(bytes, "CPS3", 4) && get16(bytes + 4) == VERSION &&
        get16(bytes + 6) <= 1 && get32(bytes + 8) == size && crc32(bytes, size) == expected;
    size_t pos = HEADER;
    if (ok) {
        out->settings.version = CP_SETTINGS_VERSION;
        out->settings.wifi_security = get32(bytes + pos); pos += 4;
        out->auto_start = get16(bytes + 6) != 0;
        memcpy(out->settings.api_origin, CP_API_ORIGIN, sizeof CP_API_ORIGIN);
        memcpy(out->settings.mqtt_uri, CP_MQTT_PRODUCTION_URI, sizeof CP_MQTT_PRODUCTION_URI);
#define READ_STRING(field) do { \
    if (pos + 2 > size) { ok = false; break; } size_t n = get16(bytes + pos); pos += 2; \
    if (n >= sizeof out->field || n > size - pos || memchr(bytes + pos, 0, n)) { ok = false; break; } \
    memcpy(out->field, bytes + pos, n); pos += n; } while (0);
        /* Each failed field leaves ok false; stop before reading the next. */
#define READ_IF_OK(field) if (ok) { READ_STRING(field) }
        PROFILE_STRINGS(READ_IF_OK)
#undef READ_IF_OK
#undef READ_STRING
        if (ok && pos + 2 <= size) {
            out->time_public_spki_len = get16(bytes + pos); pos += 2;
            if (out->time_public_spki_len <= sizeof out->time_public_spki && out->time_public_spki_len == size - pos) {
                memcpy(out->time_public_spki, bytes + pos, out->time_public_spki_len);
                ok = cp_v3_startup_validate(out, node);
            } else ok = false;
        } else ok = false;
    }
    wipe(bytes, sizeof bytes);
    if (!ok) cp_v3_startup_clear(out);
    return ok;
}
