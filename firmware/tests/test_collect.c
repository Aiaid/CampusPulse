#include "cp_collect.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
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
    assert(!cp_collect_begin(c, 0, 300000, 1, 1, 64, false));
    free(c);
    puts("Canonical MAC/type summaries, bins, raw budgets and loss equations: PASS");
    return 0;
}
