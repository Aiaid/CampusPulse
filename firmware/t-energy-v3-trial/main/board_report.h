#pragma once
#include "cp_v3_stats.h"
/* This board-owned slot holds a full SDK report until the worker releases it.
 * Address byte order and event/status values remain those supplied by NimBLE.
 * Legacy-only unavailable radio fields use RSSI/TX power 127 and SID 255;
 * zeroed fields not supplied by legacy are placeholders, interpreted via kind. */
typedef struct {
    uint64_t seq, mono_us;
    uint16_t length, periodic_interval;
    uint8_t address[6], address_type, kind, event_type, props, data_status, sid;
    uint8_t primary_phy, secondary_phy, direct_address_type, direct_address[6];
    int16_t rssi, tx_power;
    uint8_t payload[CP_V3_STATS_PAYLOAD_MAX];
} te_v3_report_t;
/* Initialize metadata before mapping an SDK event; payload is overwritten only
 * for its actual length. seq is assigned even to callback drops by the owner. */
void te_v3_report_init(te_v3_report_t *slot, uint64_t seq, uint64_t mono_us);
/* Worker-only borrowed view, valid only until slot is returned to the pool. */
bool te_v3_report_view(const te_v3_report_t *slot, cp_v3_stats_report_t *out);
/* False means saturated: stop admission and report an accounting fault. */
bool te_v3_count_loss(uint32_t *count);
/* NimBLE HCI legacy event 4, extended props bit 0x08; caller validates kind. */
bool te_v3_report_is_scan_response(const te_v3_report_t *slot);
