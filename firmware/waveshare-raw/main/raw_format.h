#ifndef RAW_FORMAT_H
#define RAW_FORMAT_H

#include <stddef.h>
#include <stdint.h>

#define RAW_PAYLOAD_MAX 1650u
#define RAW_HEADER_SIZE 32u
#define RAW_FRAME_MAX 1728u

enum {
    RAW_EVENT_SCANNING = 1,
    RAW_EVENT_USER_STOP = 2,
    RAW_EVENT_SPACE_STOP = 3,
    RAW_EVENT_SCAN_ERROR = 4,
    RAW_EVENT_SCAN_ENDED = 5,
    RAW_EVENT_BLE_RESET = 6,
    RAW_EVENT_STORAGE_ERROR = 7,
    RAW_EVENT_POWER_STOP = 8,
};

enum {
    RAW_CLOCK_RTC = 1,
    RAW_CLOCK_HOST_CALIBRATED_RTC = 2,
};

typedef struct {
    uint64_t seq, mono_us;
    uint16_t length, periodic_interval;
    uint8_t addr[6], addr_type, kind, event_type, props, data_status, sid;
    uint8_t primary_phy, secondary_phy, direct_addr_type, direct_addr[6];
    int8_t rssi, tx_power;
    uint8_t payload[RAW_PAYLOAD_MAX];
} raw_report_t;

/* Return encoded byte count, or zero on invalid input or insufficient capacity. */
size_t raw_encode_header(uint8_t *out, size_t cap, const uint8_t session[16]);
size_t raw_encode_report(uint8_t *out, size_t cap, const raw_report_t *report);
size_t raw_encode_stats(uint8_t *out, size_t cap, uint64_t mono_us,
                        uint64_t received, uint64_t enqueued, uint64_t queue_drops,
                        uint64_t invalid, uint64_t written, uint64_t synced);

size_t raw_encode_event(uint8_t *out, size_t cap, uint64_t mono_us,
                        uint32_t event, int32_t detail);

size_t raw_encode_clock(uint8_t *out, size_t cap, uint64_t mono_us,
                        uint64_t utc_epoch_seconds, uint32_t uncertainty_us,
                        uint8_t source);

#endif
