#include "cp_v3_stats.h"
#include "cp_vehicle.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static const char *const names[] = {
    "yadea", "aima", "tailg", "luyuan", "zeeho", "byd", "ninebot", "segway",
    "soco", "sunra", "niu-", "yd-1", "tl_1", "xiaodao", "lima", "niu-1",
    "smartbike", "bdb-pke", "ebike-1", "zub-1"
};
static cp_v3_stats_t *stats;
static unsigned cases;
static uint64_t seq;
static cp_vehicle_evidence_t evidence;
static bool tainted;
static void begin(void) {
    assert(cp_v3_stats_set_rules(stats, CP_V3_STATS_VEHICLE_RULESET));
    assert(cp_v3_stats_begin(stats, 0));
    memset(&evidence, 0, sizeof evidence); tainted = false; seq = 0;
}
static void observe(const uint8_t *data, size_t length, uint8_t kind, uint8_t status) {
    ++seq;
    cp_v3_stats_report_t r = {.seq=seq, .mono_us=seq*1000, .rssi=-60, .payload=data, .length=length,
        .kind=kind, .event_type=seq>1?4:0, .data_status=status, .address={1}, .address_type=0};
    cp_v3_stats_result_t result = cp_v3_stats_observe(stats, &r);
    if (kind || status || length > 31) { tainted = true; assert(result == CP_V3_STATS_UNSUPPORTED_REPORT); }
    else {
        assert(cp_vehicle_observe(&evidence, data, length));
        // The stats envelope guard is stricter about nonzero bytes after AD
        // padding. Other malformed inputs are carried by the compact oracle.
        if (result == CP_V3_STATS_BAD_AD) tainted = evidence.malformed_reports == 0;
        else assert(result == CP_V3_STATS_OK);
    }
}
static void name(const char *value) {
    uint8_t ad[31]; size_t n = strlen(value); assert(n <= 29);
    ad[0] = (uint8_t)(n+1); ad[1] = 9; memcpy(ad+2, value, n);
    observe(ad, n+2, 0, 0);
}
static void finish(cp_v3_stats_class_t expected) {
    cp_v3_stats_snapshot_t out;
    assert(cp_v3_stats_snapshot(stats, 30000000, &out));
    assert(out.unique_keys == 1 && !out.verified_keys && !out.rules_verified);
    unsigned total=0;
    for(unsigned i=0; i<CP_V3_STATS_CLASS_COUNT; ++i) { total+=out.counts[i]; assert(out.counts[i] == (i==(unsigned)expected)); }
    assert(total == out.unique_keys && !out.estimated_total_available);
    printf("{\"case\":%u,\"category\":%u,\"tainted\":%s,\"evidence\":{\"schema_version\":\"radar-compact-v1\","
        "\"parsed_reports\":%u,\"malformed_reports\":%u,\"name_brand_mask\":%u,\"exclusion_mask\":%u,\"ecosystem_mask\":%u}}\n",
        ++cases, expected, tainted?"true":"false", evidence.parsed_reports, evidence.malformed_reports,
        evidence.name_brand_mask, evidence.exclusion_mask, evidence.ecosystem_mask);
}
int main(void) {
    char initial_rules[65]=CP_V3_STATS_VEHICLE_RULESET;
    cp_v3_stats_config_t c={.capacity=16,.window_ms=30000,.bin_ms=5000,.rules_version=initial_rules};
    size_t bytes=cp_v3_stats_memory_bytes(c.capacity); void *memory=malloc(bytes); assert(memory);
    stats=cp_v3_stats_init(memory,bytes,&c); assert(stats && sizeof evidence == 16);
    memset(initial_rules,'x',sizeof initial_rules);
    assert(cp_v3_stats_begin(stats,0));
    cp_v3_stats_snapshot_t initial; assert(cp_v3_stats_snapshot(stats,0,&initial));
    assert(!strcmp(initial.rules_version,CP_V3_STATS_VEHICLE_RULESET));
    for(unsigned i=0; i<20; ++i) {
        begin(); name(names[i]);
        finish(i==5 ? CP_V3_STATS_CAR_RELATED : (i==6||i==7||i==16||i==17||i==19) ? CP_V3_STATS_UNKNOWN : CP_V3_STATS_E_BIKE_RELATED);
    }
    /* Every exclusion family, on a later scan response/report, vetoes the name.
     * 16/32/128-bit UUID encodings are equivalent device evidence. */
    static const uint8_t exclusions[][20] = {
        {7,9,'m','o','u','s','e','x'}, {7,9,'i','p','h','o','n','e'},
        {3,255,0x65,0}, {3,255,0xe0,0}, {3,255,0x4c,0}, {4,255,0x4c,0,0x10},
        {3,3,0x2c,0xfe}, {3,0x16,0xf7,0xfd}, {3,3,0x12,0x18},
        {3,0x19,0x40,0}, {3,0x19,0x80,0},
        {5,5,0x12,0x18,0,0},
        {17,7,0xfb,0x34,0x9b,0x5f,0x80,0,0,0x80,0,0x10,0,0,0x12,0x18,0,0},
    };
    for(unsigned i=0; i<sizeof exclusions/sizeof exclusions[0]; ++i) {
        begin(); name("yadea"); observe(exclusions[i], exclusions[i][0]+1, 0, 0); finish(CP_V3_STATS_UNKNOWN);
    }
    const uint8_t company[]={3,255,0x20,0};
    begin(); observe(company,sizeof company,0,0); finish(CP_V3_STATS_UNKNOWN);
    begin(); name("yadea"); observe(company,sizeof company,0,0); finish(CP_V3_STATS_E_BIKE_RELATED);
    begin(); name("yadea"); name("BYD"); finish(CP_V3_STATS_CONFLICTING);
    begin(); name("BYD"); name("yadea"); finish(CP_V3_STATS_CONFLICTING);
    begin(); name("yadea"); name("BYD"); name("iphone"); finish(CP_V3_STATS_UNKNOWN);
    begin(); name("Laima"); finish(CP_V3_STATS_UNKNOWN);
    begin(); name("Tesla"); finish(CP_V3_STATS_UNKNOWN);
    begin(); name("iphone"); finish(CP_V3_STATS_UNKNOWN);
    const uint8_t malformed[][9]={{7,9,'y','a'}, {2,255,0}, {2,0x19,0}, {2,3,0}, {2,9,0xff}, {2,9,0}, {2,1,1,0,1}};
    const size_t malformed_lengths[]={4,3,3,3,3,3,5};
    for(unsigned i=0; i<sizeof malformed_lengths/sizeof malformed_lengths[0]; ++i) {
        begin(); name("yadea"); observe(malformed[i],malformed_lengths[i],0,0); name("BYD"); finish(CP_V3_STATS_UNKNOWN);
    }
    /* Complete 31-byte legacy envelope is supported; extended and incomplete
     * observations do not receive positive classification, even after a hit. */
    uint8_t full[32]={6,9,'y','a','d','e','a'};
    begin(); observe(full,31,0,0); finish(CP_V3_STATS_E_BIKE_RELATED);
    for(unsigned i=1; i<=3; ++i) { begin(); name("yadea"); observe(full,7,0,(uint8_t)i); finish(CP_V3_STATS_UNKNOWN); }
    begin(); name("yadea"); observe(full,7,1,0); finish(CP_V3_STATS_UNKNOWN);
    begin(); name("yadea"); observe(full,32,0,0); finish(CP_V3_STATS_UNKNOWN);
    /* Rebinding is for next begin. A policy buffer can be reused immediately;
     * both pending and active versions are internal constants/copies. */
    begin(); name("yadea"); char version[65]=CP_V3_STATS_RULESET;
    assert(cp_v3_stats_set_rules(stats,version)); memset(version,'x',sizeof version);
    cp_v3_stats_snapshot_t old,next; assert(cp_v3_stats_snapshot(stats,30000000,&old));
    assert(!strcmp(old.rules_version,CP_V3_STATS_VEHICLE_RULESET) && old.counts[CP_V3_STATS_E_BIKE_RELATED]==1);
    assert(!cp_v3_stats_set_rules(stats,"unreviewed/1"));
    assert(cp_v3_stats_begin(stats,0)); name("yadea");
    assert(cp_v3_stats_snapshot(stats,30000000,&next));
    assert(!strcmp(next.rules_version,CP_V3_STATS_RULESET) && next.counts[CP_V3_STATS_UNKNOWN]==1);
    /* All retained keys share exactly one primary category, including conflicts.
     * Repeated reports do not add a second category contribution. */
    begin();
    for(unsigned key=0; key<4; ++key) {
        uint8_t ad[]={6,9,'y','a','d','e','a'};
        cp_v3_stats_report_t r={.seq=key+1,.mono_us=(key+1)*1000,.rssi=-60,
            .payload=ad,.length=sizeof ad,.address={(uint8_t)key}};
        if(key==1) { ad[0]=4; memcpy(ad+2,"byd",3); r.length=5; }
        if(key==2) { r.payload=company; r.length=sizeof company; }
        assert(cp_v3_stats_observe(stats,&r)==CP_V3_STATS_OK);
        if(key==3) { const uint8_t byd[]={4,9,'b','y','d'}; r.payload=byd; r.length=sizeof byd; r.seq=5; r.mono_us=5000;
            assert(cp_v3_stats_observe(stats,&r)==CP_V3_STATS_OK); }
    }
    assert(cp_v3_stats_snapshot(stats,30000000,&next));
    assert(next.unique_keys==4 && next.worker_reports==5 && next.counts[CP_V3_STATS_E_BIKE_RELATED]==1 &&
        next.counts[CP_V3_STATS_CAR_RELATED]==1 && next.counts[CP_V3_STATS_UNKNOWN]==1 && next.counts[CP_V3_STATS_CONFLICTING]==1 &&
        next.candidate_keys[CP_V3_STATS_E_BIKE_RELATED]==1 && next.candidate_keys[CP_V3_STATS_CAR_RELATED]==1 && !next.verified_keys);
    free(memory);
    return 0;
}
