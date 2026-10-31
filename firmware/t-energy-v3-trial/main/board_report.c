#include "board_report.h"
#include <stddef.h>
#include <string.h>
void te_v3_report_init(te_v3_report_t *slot, uint64_t seq, uint64_t mono_us) {
    if (!slot) return;
    memset(slot, 0, offsetof(te_v3_report_t, payload));
    slot->seq=seq; slot->mono_us=mono_us;
    slot->rssi=127; slot->tx_power=127; slot->sid=255;
}
bool te_v3_report_view(const te_v3_report_t *slot, cp_v3_stats_report_t *out) {
    if (!slot || !out || !slot->seq || slot->kind>1 || slot->length>CP_V3_STATS_PAYLOAD_MAX) return false;
    *out=(cp_v3_stats_report_t){.seq=slot->seq,.mono_us=slot->mono_us,
        .address_type=slot->address_type,.kind=slot->kind,.event_type=slot->event_type,
        .props=slot->props,.data_status=slot->data_status,.sid=slot->sid,
        .primary_phy=slot->primary_phy,.secondary_phy=slot->secondary_phy,
        .direct_address_type=slot->direct_address_type,.periodic_interval=slot->periodic_interval,
        .rssi=slot->rssi,.tx_power=slot->tx_power,.payload=slot->payload,.length=slot->length};
    memcpy(out->address,slot->address,sizeof out->address);
    memcpy(out->direct_address,slot->direct_address,sizeof out->direct_address);
    return true;
}
bool te_v3_count_loss(uint32_t *count) {
    if (!count || *count == UINT32_MAX) return false;
    ++*count;
    return *count != UINT32_MAX;
}
bool te_v3_report_is_scan_response(const te_v3_report_t *slot) {
    if (!slot) return false;
    if (slot->kind==0) return slot->event_type==4;
    if (slot->kind==1) return (slot->props & 0x08u)!=0;
    return false;
}
