#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include "cp_pipeline.h"
#include "../components/cp_pipeline/domain_debug.h"

static uint64_t now_ms;
int64_t esp_timer_get_time(void) { return (int64_t)(now_ms * 1000); }
static bool observe(cp_collect_t *c, cp_report_t *r)
{
    uint32_t before = c->reports_seen;
    bool ok = cp_collect_observe(c, r);
    cp_domain_debug_observe(c, r, c->reports_seen != before);
    return ok;
}
static cp_debug_domain_t snapshot(uint64_t now)
{
    cp_debug_domain_t out;
    memset(&out, 0xff, sizeof out);
    now_ms = now;
    cp_pipeline_domain_snapshot(&out);
    return out;
}
int main(void)
{
    cp_pipeline_domain_snapshot(NULL);
    cp_debug_domain_t d = snapshot(0);
    assert(!d.known && d.reports_seen == 0);
    cp_collect_t c;
    assert(cp_collect_begin(&c, 1000, 4000, 1000, 1, 1, false));
    cp_report_t r = {.mono_ms=1010, .rssi=-70, .address_type=0,
        .payload_length=7, .payload={6,9,'Y','a','d','e','a'}};
    r.address[0]=1;
    assert(observe(&c,&r));
    cp_domain_debug_refresh(&c,1100,false,4000);
    d=snapshot(1100);
    assert(d.known && d.window_partial && d.vehicle_candidates==1);
    assert(d.vehicle_name_addresses==1 && d.vehicle_parsed_reports==1);
    assert(d.bin_reports[0]==1 && d.rssi_min==-70 && d.rssi_mean==-70);
    /* A different address is omitted from the policy-limited table, but its
     * overall report and aggregate histogram must remain visible. */
    r.address[0]=2;r.mono_ms=2020;r.rssi=-50;r.payload_length=0;
    assert(observe(&c,&r));
    cp_domain_debug_refresh(&c,1500,false,4000);
    d=snapshot(1500);assert(d.reports_seen==1 && d.age_ms==400);
    cp_domain_debug_refresh(&c,2200,false,4000);
    d=snapshot(2250);
    assert(d.reports_seen==2 && d.reports_aggregated==2 && d.addresses==1);
    assert(d.address_overflow && d.summary_drops==1 && d.bin_count==4);
    assert(d.bin_reports[0]==1 && d.bin_reports[1]==1);
    assert(d.rssi_samples==2 && d.rssi_min==-70 && d.rssi_mean==-60 && d.rssi_max==-50);
    assert(d.vehicle_parsed_reports==1); /* Scoped tracked-address evidence. */
    /* Half-open end is not binned, and ingress loss has no fabricated time. */
    r.mono_ms=5000;assert(!observe(&c,&r));
    assert(cp_collect_losses(&c,7,0,0,0));
    c.addresses[0].vehicle_evidence.exclusion_mask=1;
    cp_domain_debug_refresh(&c,5000,true,4000);
    d=snapshot(5500);
    assert(!d.window_partial && d.age_ms==500 && d.reports_seen==9);
    assert(d.aggregation_drops==7 && d.vehicle_candidates==0 && d.vehicle_excluded_addresses==1);
    uint32_t sum=0;for(unsigned i=0;i<d.bin_count;i++)sum+=d.bin_reports[i];
    assert(sum==2);
    /* A new slice with no reports cannot inherit the previous histogram. */
    assert(cp_collect_begin(&c,5000,4000,1000,2,2,false));
    cp_domain_debug_refresh(&c,5000,false,4000);d=snapshot(5000);
    assert(d.window_seq==2 && d.reports_seen==0 && d.rssi_samples==0);
    for(unsigned i=0;i<d.bin_count;i++)assert(d.bin_reports[i]==0);
    c.address_count=2;
    for(unsigned i=0;i<2;i++){
        c.addresses[i].vehicle_evidence.parsed_reports=UINT32_MAX;
        c.addresses[i].vehicle_evidence.malformed_reports=UINT32_MAX;
        c.addresses[i].vehicle_evidence.ecosystem_mask=1;
    }
    cp_domain_debug_refresh(&c,5100,true,1970);d=snapshot(5200);
    assert(d.window_partial && d.window_ms==1970 && d.bin_count==2);
    assert(d.vehicle_parsed_reports==UINT32_MAX && d.vehicle_malformed_reports==UINT32_MAX);
    assert(d.vehicle_ecosystem_addresses==2 && d.vehicle_candidates==0);
    d=snapshot(5000);assert(!d.known && d.age_ms==UINT32_MAX);
    d=snapshot(UINT64_MAX/1000);assert(d.age_ms==UINT32_MAX);
    cp_address_core_t compact_addresses[64];
    uint32_t compact_bins[64 * 16];
    cp_collect_compact_t compact = {.addresses = compact_addresses, .bins = compact_bins,
        .storage_capacity = 64, .bin_count = 16};
    assert(cp_collect_compact_begin(&compact, 10000, 16000, 1000, 3, 64, false));
    for (unsigned a = 0; a < 64; ++a) {
        r = (cp_report_t){.mono_ms = 10000 + (a % 16) * 1000, .rssi = -50,
            .address = {2,0,0,0,0,(uint8_t)a}, .payload_length = 7,
            .payload = {6,9,'Y','a','d','e','a'}};
        assert(cp_collect_compact_observe(&compact, &r));
        cp_domain_debug_observe_compact(&compact, &r, true);
    }
    cp_domain_debug_refresh_compact(&compact, 26000, true, 16000);
    d = snapshot(26000);
    assert(d.addresses == 64 && d.vehicle_candidates == 64 && d.vehicle_parsed_reports == 64);
    assert(d.bin_count == 16 && d.reports_seen == 64 && !d.summary_drops);
    for (unsigned b = 0; b < 16; ++b) assert(d.bin_reports[b] == 4);
    cp_domain_debug_observe_compact(NULL, &r, true);
    cp_domain_debug_refresh_compact(NULL, 0, false, 0);
    cp_domain_debug_observe(NULL,&r,true);
    cp_domain_debug_refresh(NULL,0,false,0);
    puts("domain debug: aggregate bins, overflow, evidence, boundaries, age and saturation passed");
}
