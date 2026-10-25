/* Selected tables adapted from AI Passport Radar main/veh_rules.c,
 * dev_phone.c and ad_parse.h at 5fb8ab532414eb0029fc5ea131a03cb0993db180.
 * MIT, Copyright (c) 2026 FoloToy. Full permission and warranty notice retained
 * in firmware/ai-passport-radar/LICENSE. New strict parser, bounded matching and
 * category evidence masks follow worker/vehicle-rules.ts, not the old counter.
 * No legacy main/scanner/UI dependency, heap, radio or storage operation. */
#include "cp_vehicle.h"
#include <limits.h>
#include <string.h>

_Static_assert(sizeof(cp_vehicle_evidence_t) == 16, "compact vehicle evidence must remain 16 bytes");

static const char *const names[] = {
    "yadea", "aima", "tailg", "luyuan", "zeeho", "byd", "ninebot", "segway",
    "soco", "sunra", "niu-", "^yd", "^tl_", "xiaodao", "lima", "^niu",
    "smartbike", "bdb-pke", "^ebike", "^zub"
};
static const char *const peripheral_names[] = {
    "mouse", "keyboard", "kbd", "trackpad", "touchpad", "buds", "earbud", "airpod",
    "headphone", "headset", "speaker", "watch", "band", "pen", "stylus", "printer",
    "ikf", "qcy", "edifier", "soundcore", "baseus", "jbl", "bose", "deli",
    "desktop-", "laptop-", "tws"
};
static const char *const phone_names[] = {
    "iphone", "galaxy", "pixel", "redmi", "huawei", "honor", "oneplus", "oppo",
    "vivo", "xiaomi", "mi ", "realme"
};
static const uint16_t office_companies[] = {
    0x0065, 0x011b, 0x0040, 0x0004, 0x018b, 0x01a9, 0x01f1,
    0x025d, 0x065f, 0x0755, 0x041e, 0x0381, 0x02ea
};
static const uint16_t phone_companies[] = {
    0x00e0, 0x0075, 0x0837, 0x8486, 0x027d, 0x09c6, 0x038f,
    0x079a, 0x072f, 0x08a4, 0x03ab, 0x08ca, 0x02c5, 0x0008
};
#define COUNT(a) (sizeof(a) / sizeof((a)[0]))
static uint8_t lower(uint8_t c) { return c >= 'A' && c <= 'Z' ? (uint8_t)(c + 'a' - 'A') : c; }
static bool letter(uint8_t c) { c = lower(c); return c >= 'a' && c <= 'z'; }
static uint16_t le16(const uint8_t *p) { return (uint16_t)(p[0] | ((uint16_t)p[1] << 8)); }
static bool in_table(uint16_t value, const uint16_t *table, size_t length) {
    for (size_t i = 0; i < length; ++i) if (table[i] == value) return true;
    return false;
}
static void exclude(cp_vehicle_evidence_t *e, unsigned bit) { e->exclusion_mask |= (uint16_t)(1u << bit); }
static bool match_at(const uint8_t *data, size_t length, size_t offset, const char *word) {
    const size_t n = strlen(word);
    if (offset > length || n > length - offset) return false;
    for (size_t i = 0; i < n; ++i) if (lower(data[offset + i]) != (uint8_t)word[i]) return false;
    return true;
}
static bool contains(const uint8_t *data, size_t length, const char *word) {
    for (size_t i = 0; i < length; ++i) if (match_at(data, length, i, word)) return true;
    return false;
}
static bool bounded_name(const uint8_t *data, size_t length, unsigned index) {
    const char *word = names[index];
    if (word[0] == '^') {
        ++word;
        const size_t n = strlen(word);
        if (!match_at(data, length, 0, word)) return false;
        if (length == n) return true;
        if (index == CP_VEHICLE_NAME_YD_PREFIX)
            return (data[n] >= '0' && data[n] <= '9') || data[n] == ' ' || data[n] == '_' || data[n] == '-';
        if (index == CP_VEHICLE_NAME_NIU_PREFIX)
            return data[n] == ' ' || data[n] == '_' || data[n] == '-';
        if (index == CP_VEHICLE_NAME_EBIKE_PREFIX) return !letter(data[n]);
        return true;
    }
    const size_t n = strlen(word);
    for (size_t i = 0; i < length; ++i) {
        if (!match_at(data, length, i, word)) continue;
        if ((i == 0 || !letter(data[i - 1])) && (i + n == length || !letter(data[i + n]))) return true;
    }
    return false;
}

/* Unicode Cc/Cf and U+FFFD agree with the backend's sanitized-name guard.
 * UTF-8 must be shortest-form scalar values; invalid names invalidate the AD.
 * These are category ranges, not an encoding of or retained observed name. */
static bool name_codepoint_allowed(uint32_t cp) {
    static const uint32_t ranges[][2] = {
        {0x00ad,0x00ad}, {0x0600,0x0605}, {0x061c,0x061c}, {0x06dd,0x06dd},
        {0x070f,0x070f}, {0x0890,0x0891}, {0x08e2,0x08e2}, {0x180e,0x180e},
        {0x200b,0x200f}, {0x202a,0x202e}, {0x2060,0x2064}, {0x2066,0x206f},
        {0xfeff,0xfeff}, {0xfff9,0xfffb}, {0x110bd,0x110bd}, {0x110cd,0x110cd},
        {0x13430,0x1343f}, {0x1bca0,0x1bca3}, {0x1d173,0x1d17a},
        {0xe0001,0xe0001}, {0xe0020,0xe007f}
    };
    if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f) || cp == 0xfffd) return false;
    for (size_t i = 0; i < COUNT(ranges); ++i)
        if (cp >= ranges[i][0] && cp <= ranges[i][1]) return false;
    return true;
}
static bool valid_name(const uint8_t *p, size_t length) {
    for (size_t i = 0; i < length;) {
        uint32_t cp = p[i++];
        unsigned continuation = 0;
        uint32_t minimum = 0;
        if (cp >= 0xc2 && cp <= 0xdf) { cp &= 0x1f; continuation = 1; minimum = 0x80; }
        else if (cp >= 0xe0 && cp <= 0xef) { cp &= 0x0f; continuation = 2; minimum = 0x800; }
        else if (cp >= 0xf0 && cp <= 0xf4) { cp &= 0x07; continuation = 3; minimum = 0x10000; }
        else if (cp >= 0x80) return false;
        if (continuation > length - i) return false;
        for (unsigned j = 0; j < continuation; ++j) {
            uint8_t next = p[i++];
            if ((next & 0xc0) != 0x80) return false;
            cp = (cp << 6) | (next & 0x3f);
        }
        if (cp < minimum || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) || !name_codepoint_allowed(cp)) return false;
    }
    return true;
}
static void note_name(cp_vehicle_evidence_t *e, const uint8_t *p, size_t n) {
    for (unsigned i = 0; i < COUNT(names); ++i)
        if (bounded_name(p, n, i)) e->name_brand_mask |= UINT32_C(1) << i;
    bool peripheral = false;
    for (size_t i = 0; i < COUNT(peripheral_names); ++i)
        if (contains(p, n, peripheral_names[i])) peripheral = true;
    if (peripheral) exclude(e, CP_VEHICLE_EXCL_PERIPHERAL_NAME);
    else for (size_t i = 0; i < COUNT(phone_names); ++i)
        if (contains(p, n, phone_names[i])) exclude(e, CP_VEHICLE_EXCL_PHONE_NAME);
}
static void note_company(cp_vehicle_evidence_t *e, const uint8_t *p, size_t n) {
    const uint16_t value = le16(p);
    if (in_table(value, office_companies, COUNT(office_companies))) exclude(e, CP_VEHICLE_EXCL_OFFICE_COMPANY);
    if (in_table(value, phone_companies, COUNT(phone_companies))) exclude(e, CP_VEHICLE_EXCL_PHONE_VENDOR);
    if (value == 0x004c || value == 0x0006) exclude(e, CP_VEHICLE_EXCL_CONSUMER_COMPANY);
    if (value == 0x004c && n >= 3 && (p[2] == 0x0c || p[2] == 0x0f || p[2] == 0x10))
        exclude(e, CP_VEHICLE_EXCL_APPLE_PHONE_SUBTYPE);
    if (value == 0x0020) e->ecosystem_mask |= 1u << CP_VEHICLE_ECOSYSTEM_COMPANY_0020;
    if (value == 0x1010) e->ecosystem_mask |= 1u << CP_VEHICLE_ECOSYSTEM_COMPANY_1010;
}
static void note_service(cp_vehicle_evidence_t *e, uint16_t value) {
    if (value == 0xfe2c || value == 0xfe26) exclude(e, CP_VEHICLE_EXCL_FAST_PAIR);
    if (value == 0xfdf7 || value == 0xfd92 || value == 0xfebe) exclude(e, CP_VEHICLE_EXCL_GADGET_SERVICE);
    if (value == 0x1812) exclude(e, CP_VEHICLE_EXCL_HID_SERVICE);
    /* 0x1813 is Scan Parameters, not the inherited incorrect HID label. */
}
static void note_uuid(cp_vehicle_evidence_t *e, const uint8_t *p, size_t width) {
    static const uint8_t base_prefix[12] = {0xfb,0x34,0x9b,0x5f,0x80,0x00,0x00,0x80,0x00,0x10,0x00,0x00};
    if (width == 2) note_service(e, le16(p));
    else if (width == 4 && p[2] == 0 && p[3] == 0) note_service(e, le16(p));
    else if (width == 16 && p[14] == 0 && p[15] == 0 && !memcmp(p, base_prefix, sizeof base_prefix))
        note_service(e, le16(p + 12));
}
static void note_appearance(cp_vehicle_evidence_t *e, uint16_t value) {
    if (value == 0x0040) exclude(e, CP_VEHICLE_EXCL_PHONE_APPEARANCE);
    if ((value >= 0x0080 && value <= 0x008f) || (value >= 0x00c0 && value <= 0x00c2)
        || (value >= 0x0300 && value <= 0x03ff) || (value >= 0x0440 && value <= 0x044f)
        || (value >= 0x0480 && value <= 0x048f) || (value >= 0x0540 && value <= 0x057f))
        exclude(e, CP_VEHICLE_EXCL_GADGET_APPEARANCE);
}
static bool parse(cp_vehicle_evidence_t *e, const uint8_t *payload, size_t length) {
    if (length > 31 || (length && !payload)) return false;
    for (size_t offset = 0; offset < length;) {
        const uint8_t field_length = payload[offset];
        if (field_length == 0) break;
        if (field_length > length - offset - 1) return false;
        const uint8_t type = payload[offset + 1];
        const uint8_t *p = payload + offset + 2;
        const size_t n = field_length - 1;
        if (type == 0x01 || type == 0x0a) { if (n != 1) return false; }
        else if (type == 0x08 || type == 0x09) {
            if (!valid_name(p, n)) return false;
            note_name(e, p, n);
        } else if (type == 0xff) {
            if (n < 2) return false;
            note_company(e, p, n);
        } else if (type == 0x19) {
            if (n != 2) return false;
            note_appearance(e, le16(p));
        } else if (type >= 0x02 && type <= 0x07) {
            const size_t width = type <= 0x03 ? 2 : type <= 0x05 ? 4 : 16;
            if (n % width) return false;
            for (size_t i = 0; i < n; i += width) note_uuid(e, p + i, width);
        } else if (type == 0x16 || type == 0x20 || type == 0x21) {
            const size_t width = type == 0x16 ? 2 : type == 0x20 ? 4 : 16;
            if (n < width) return false;
            note_uuid(e, p, width);
        }
        offset += field_length + 1;
    }
    return true;
}
bool cp_vehicle_observe(cp_vehicle_evidence_t *state, const uint8_t *payload, size_t length) {
    if (!state) return false;
    cp_vehicle_evidence_t report = {0};
    if (!parse(&report, payload, length)) {
        if (state->malformed_reports == UINT32_MAX) return false;
        state->malformed_reports++;
        return true;
    }
    if (state->parsed_reports == UINT32_MAX) return false;
    state->parsed_reports++;
    state->name_brand_mask |= report.name_brand_mask;
    state->exclusion_mask |= report.exclusion_mask;
    state->ecosystem_mask |= report.ecosystem_mask;
    return true;
}
