#include "cp_collect.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <limits.h>
#include <string.h>
int main(void) {
    cp_collect_t *c = malloc(sizeof *c);
    assert(c);
    assert(cp_collect_begin(c, 1000, 30000, 5000, 1, 2, false));
    cp_report_t r = {.mono_ms = 1001,
                     .report_seq = 1,
                     .address = {2, 0, 0, 0, 0, 1},
                     .address_type = 0,
                     .rssi = -50};
    for (unsigned i = 0; i < 1000; i++) {
        r.report_seq++;
        r.mono_ms = 1000 + i % 30000;
        assert(cp_collect_observe(c, &r));
    }
    assert(c->address_count == 1 && c->addresses[0].reports == 1000 && c->reports_seen == 1000);
    assert(c->addresses[0].vehicle_evidence.parsed_reports == 1000 && !c->raw_count);
    r.address_type = 1;
    r.mono_ms = 7000;
    r.report_type = 4;
    assert(cp_collect_observe(c, &r));
    assert(c->address_count == 2 && c->addresses[1].bins[1] == 1 && c->scan_responses == 1);
    r.address[5] = 2;
    assert(cp_collect_observe(c, &r));
    assert(c->address_overflow && c->summary_drops == 1 && c->address_count == 2 &&
           c->reports_seen == 1002);
    assert(cp_collect_losses(c, 3, 0, 0, 0));
    assert(c->reports_seen == c->reports_aggregated + c->aggregation_drops);
    r.mono_ms = 31000;
    assert(!cp_collect_observe(c, &r));
    assert(cp_collect_begin(c, 31000, 30000, 5000, 2, 64, true));
    r.mono_ms = 31001;
    r.raw = CP_RAW_SELECTED;
    r.payload_length = 1;
    r.payload[0] = 42;
    for (unsigned i = 0; i < 4; i++)
        assert(cp_collect_observe(c, &r));
    r.raw = CP_RAW_INTENTIONAL;
    assert(cp_collect_observe(c, &r));
    r.raw = CP_RAW_PRESSURE;
    assert(cp_collect_observe(c, &r));
    assert(cp_collect_losses(c, 3, 1, 1, 1));
    assert(c->selected == 5 && c->raw_count == 4 && c->raw_drops == 1);
    assert(c->selected + c->intentional + c->pressure == c->reports_seen);
    assert(c->addresses[0].vehicle_evidence.parsed_reports == 0 &&
           c->addresses[0].vehicle_evidence.malformed_reports == 6);
    /* Raw OFF still extracts bounded evidence, joins ADV/SCAN_RSP only for
     * this canonical address/type and resets at the next collection window. */
    assert(cp_collect_begin(c, 61000, 30000, 5000, 3, 64, false));
    r.mono_ms = 61001;
    r.raw = CP_RAW_OFF;
    r.payload_length = 7;
    const uint8_t name[] = {6,9,'Y','A','D','E','A'};
    memcpy(r.payload, name, sizeof name);
    assert(cp_collect_observe(c, &r));
    assert(c->addresses[0].vehicle_evidence.name_brand_mask == (1u << CP_VEHICLE_NAME_YADEA));
    r.report_type = 4;
    const uint8_t hid[] = {3,3,0x12,0x18};
    r.payload_length = sizeof hid;
    memcpy(r.payload, hid, sizeof hid);
    assert(cp_collect_observe(c, &r));
    assert(c->addresses[0].vehicle_evidence.exclusion_mask == (1u << CP_VEHICLE_EXCL_HID_SERVICE));
    assert(c->addresses[0].vehicle_evidence.parsed_reports == c->addresses[0].reports && !c->raw_count);
    r.address_type = 0;
    r.payload_length = 0;
    assert(cp_collect_observe(c, &r));
    assert(c->addresses[1].vehicle_evidence.name_brand_mask == 0);
    /* A broken/exhausted per-address counter fails atomically and visibly. */
    c->addresses[1].reports = UINT32_MAX;
    c->addresses[1].vehicle_evidence.parsed_reports = UINT32_MAX;
    cp_collect_t before = *c;
    assert(!cp_collect_observe(c, &r));
    assert(!memcmp(c, &before, sizeof *c));
    c->addresses[1].reports = 1;
    before = *c;
    assert(!cp_collect_observe(c, &r));
    assert(!memcmp(c, &before, sizeof *c));
    assert(cp_collect_begin(c, 91000, 30000, 5000, 4, 64, false));
    assert(!c->addresses[0].vehicle_evidence.name_brand_mask && !c->addresses[0].vehicle_evidence.parsed_reports);
    assert(!cp_collect_begin(c, 0, 300000, 1, 1, 64, false));
    free(c);
    puts("Canonical MAC/type summaries, bins, raw budgets and loss equations: PASS");
    return 0;
}
