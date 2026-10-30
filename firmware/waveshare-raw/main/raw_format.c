#include "raw_format.h"

#include <string.h>

#define REPORT_FIXED 43u
#define FRAME_OVERHEAD 12u

static void put16(uint8_t *p, uint16_t v) { p[0] = (uint8_t)v; p[1] = (uint8_t)(v >> 8); }
static void put32(uint8_t *p, uint32_t v) { for (unsigned i = 0; i < 4; ++i) p[i] = (uint8_t)(v >> (8 * i)); }
static void put64(uint8_t *p, uint64_t v) { for (unsigned i = 0; i < 8; ++i) p[i] = (uint8_t)(v >> (8 * i)); }
static uint32_t crc32(const uint8_t *p, size_t n) {
    uint32_t crc = 0xffffffffu;
    while (n--) {
        crc ^= *p++;
        for (unsigned i = 0; i < 8; ++i) crc = (crc >> 1) ^ (0xedb88320u & (0u - (crc & 1u)));
    }
    return crc ^ 0xffffffffu;
}
static void frame_start(uint8_t *out, uint32_t total, uint8_t type) {
    put32(out, total); out[4] = type; out[5] = out[6] = out[7] = 0;
}
static void frame_finish(uint8_t *out, size_t total) { put32(out + total - 4, crc32(out, total - 4)); }

size_t raw_encode_header(uint8_t *out, size_t cap, const uint8_t session[16]) {
    if (!out || !session || cap < RAW_HEADER_SIZE) return 0;
    memcpy(out, "CPRAW\r\n\032", 8); put16(out + 8, 1); put16(out + 10, RAW_HEADER_SIZE);
    memcpy(out + 12, session, 16); put32(out + 28, crc32(out, 28));
    return RAW_HEADER_SIZE;
}
size_t raw_encode_report(uint8_t *out, size_t cap, const raw_report_t *r) {
    if (!out || !r || r->length > RAW_PAYLOAD_MAX || r->kind > 1) return 0;
    size_t total = FRAME_OVERHEAD + REPORT_FIXED + r->length;
    if (cap < total) return 0;
    frame_start(out, (uint32_t)total, 1);
    uint8_t *p = out + 8;
    put64(p, r->seq); p += 8; put64(p, r->mono_us); p += 8;
    put16(p, r->length); p += 2; put16(p, r->periodic_interval); p += 2;
    memcpy(p, r->addr, 6); p += 6;
    *p++ = r->addr_type; *p++ = r->kind; *p++ = r->event_type; *p++ = r->props;
    *p++ = r->data_status; *p++ = r->sid; *p++ = r->primary_phy; *p++ = r->secondary_phy;
    *p++ = r->direct_addr_type; memcpy(p, r->direct_addr, 6); p += 6;
    *p++ = (uint8_t)r->rssi; *p++ = (uint8_t)r->tx_power;
    memcpy(p, r->payload, r->length);
    frame_finish(out, total); return total;
}
size_t raw_encode_stats(uint8_t *out, size_t cap, uint64_t mono_us, uint64_t received,
                        uint64_t enqueued, uint64_t queue_drops, uint64_t invalid,
                        uint64_t written, uint64_t synced) {
    const size_t total = FRAME_OVERHEAD + 7u * 8u;
    if (!out || cap < total) return 0;
    frame_start(out, (uint32_t)total, 2);
    const uint64_t values[] = {mono_us, received, enqueued, queue_drops, invalid, written, synced};
    for (unsigned i = 0; i < 7; ++i) put64(out + 8 + 8 * i, values[i]);
    frame_finish(out, total); return total;
}

size_t raw_encode_event(uint8_t *out, size_t cap, uint64_t mono_us,
                        uint32_t event, int32_t detail) {
    const size_t total = FRAME_OVERHEAD + 16u;
    if (!out || cap < total) return 0;
    frame_start(out, (uint32_t)total, 3);
    put64(out + 8, mono_us);
    put32(out + 16, event);
    put32(out + 20, (uint32_t)detail);
    frame_finish(out, total);
    return total;
}

size_t raw_encode_clock(uint8_t *out, size_t cap, uint64_t mono_us,
                        uint64_t utc_epoch_seconds, uint32_t uncertainty_us,
                        uint8_t source) {
    const size_t total = FRAME_OVERHEAD + 21u;
    if (!out || cap < total || (source != RAW_CLOCK_RTC &&
                                 source != RAW_CLOCK_HOST_CALIBRATED_RTC)) return 0;
    frame_start(out, (uint32_t)total, 4);
    put64(out + 8, mono_us);
    put64(out + 16, utc_epoch_seconds);
    put32(out + 24, uncertainty_us);
    out[28] = source;
    frame_finish(out, total);
    return total;
}
