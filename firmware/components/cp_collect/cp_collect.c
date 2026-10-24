#include "cp_collect.h"
#include <limits.h>
#include <string.h>
bool cp_collect_begin(cp_collect_t *c, uint64_t start, uint32_t window, uint32_t bin, uint32_t seq,
                      unsigned capacity, bool raw) {
    if (!c || window < 1000 || window > 300000 || !bin || bin > window ||
        (window + bin - 1) / bin > CP_COLLECT_BINS || !seq || !capacity ||
        capacity > CP_COLLECT_ADDRESSES)
        return false;
    memset(c, 0, sizeof *c);
    c->start_ms = start;
    c->window_ms = window;
    c->bin_ms = bin;
    c->window_seq = seq;
    c->address_capacity = capacity;
    c->raw_enabled = raw;
    return true;
}
static void rssi_note(int16_t value, uint32_t *n, int16_t *min, int16_t *max, int64_t *sum) {
    if (value < -127 || value > 126)
        return;
    if (!*n) {
        *min = value;
        *max = value;
    } else {
        if (value < *min)
            *min = value;
        if (value > *max)
            *max = value;
    }
    (*n)++;
    *sum += value;
}
bool cp_collect_observe(cp_collect_t *c, const cp_report_t *r) {
    if (!c || !r || r->mono_ms < c->start_ms || r->mono_ms - c->start_ms >= c->window_ms ||
        r->payload_length > 31 || r->address_type > 4 ||
        (c->raw_enabled && r->raw != CP_RAW_SELECTED && r->raw != CP_RAW_INTENTIONAL &&
         r->raw != CP_RAW_PRESSURE) ||
        c->reports_seen == UINT32_MAX)
        return false;
    c->reports_seen++;
    c->reports_aggregated++;
    if (r->report_type == 4)
        c->scan_responses++;
    else
        c->adv++;
    rssi_note(r->rssi, &c->rssi_samples, &c->rssi_min, &c->rssi_max, &c->rssi_sum);
    if (c->raw_enabled) {
        switch (r->raw) {
        case CP_RAW_SELECTED:
            c->selected++;
            if (c->raw_count < CP_COLLECT_RAW)
                c->raw[c->raw_count++] = *r;
            else
                c->raw_drops++;
            break;
        case CP_RAW_PRESSURE:
            c->pressure++;
            break;
        case CP_RAW_INTENTIONAL:
            c->intentional++;
            break;
        default:
            return false;
        }
    }
    cp_address_summary_t *a = NULL;
    for (unsigned i = 0; i < c->address_count; i++)
        if (c->addresses[i].address_type == r->address_type &&
            !memcmp(c->addresses[i].address, r->address, 6)) {
            a = &c->addresses[i];
            break;
        }
    if (!a) {
        if (c->address_count == c->address_capacity) {
            c->address_overflow = true;
            c->summary_drops++;
            return true;
        }
        a = &c->addresses[c->address_count++];
        a->used = true;
        a->address_type = r->address_type;
        memcpy(a->address, r->address, 6);
        a->first_ms = (uint32_t)(r->mono_ms - c->start_ms);
    }
    a->reports++;
    if (r->report_type == 4)
        a->scan_responses++;
    else
        a->adv++;
    const uint32_t offset = (uint32_t)(r->mono_ms - c->start_ms);
    if (offset < a->first_ms)
        a->first_ms = offset;
    if (offset > a->last_ms)
        a->last_ms = offset;
    a->bins[offset / c->bin_ms]++;
    rssi_note(r->rssi, &a->samples, &a->rssi_min, &a->rssi_max, &a->rssi_sum);
    return true;
}
bool cp_collect_losses(cp_collect_t *c, uint32_t dropped, uint32_t selected, uint32_t intentional,
                       uint32_t pressure) {
    if (!c || dropped > UINT32_MAX - c->reports_seen ||
        dropped > UINT32_MAX - c->aggregation_drops ||
        (c->raw_enabled ? (uint64_t)selected + intentional + pressure != dropped
                        : selected || intentional || pressure))
        return false;
    c->reports_seen += dropped;
    c->aggregation_drops += dropped;
    c->selected += selected;
    c->raw_drops += selected;
    c->intentional += intentional;
    c->pressure += pressure;
    return true;
}
