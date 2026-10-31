#include "small_runtime_logic.h"
#include <assert.h>
#include <stdio.h>
int main(void){
    assert(te_small_request_timeout_ms(CP_API_ORIGIN)==30000);
    const char *isolated[]={NULL,"","https://192.168.1.2:8799","https://isolated.example",
        CP_API_ORIGIN ":443",CP_API_ORIGIN ":8443",CP_API_ORIGIN "/",CP_API_ORIGIN ".",
        "https://test.pulse.anend.net","https://PULSE.anend.net"};
    for(unsigned i=0;i<sizeof isolated/sizeof *isolated;i++)assert(te_small_request_timeout_ms(isolated[i])==15000);
    for(int loaded=-1;loaded<=4;loaded++){
        assert(te_small_slot_reusable(CP_V3_QUEUE_FREE,loaded)==(loaded==0||loaded==3));
        assert(!te_small_slot_reusable(CP_V3_QUEUE_PENDING,loaded));
        assert(!te_small_slot_reusable(CP_V3_QUEUE_QUARANTINED,loaded));
    }
    cp_v3_time_t a={.mono_ms=1000,.utc_ms=1800000000000ULL,.clock_epoch=1,.uncertainty_ms=250};
    cp_v3_temporal_time_t t;
    assert(!te_small_clock_at(a,999,&t));
    assert(te_small_clock_at(a,1000,&t)&&t.utc_ms==a.utc_ms&&t.uncertainty_ms==250);
    for(uint64_t age=0;age<600000;age++){
        assert(te_small_clock_at(a,1000+age,&t));
        assert(t.utc_ms==a.utc_ms+age&&t.uncertainty_ms==250+(age+1999)/2000);
    }
    a.uncertainty_ms=5000;assert(te_small_clock_at(a,1000,&t));assert(!te_small_clock_at(a,1001,&t));
    a.clock_epoch=0;assert(!te_small_clock_at(a,1000,&t));
    a.clock_epoch=1;a.uncertainty_ms=250;a.utc_ms=UINT64_MAX-1;assert(!te_small_clock_at(a,1002,&t));
    cp_v3_trial_policy_t p={.statistics=true,.stats_max_addresses=512,.bin_ms=5000,.window_ms=60000,.max_body_bytes=1024,
        .queue_max_bytes=3072,.queue_max_items=3,.window_reserve_items=1,.status_reserve_items=1,.control_reserve_items=1,
        .window_reserve_bytes=1024,.status_reserve_bytes=1024,.control_reserve_bytes=1024,.working_bytes=TE_SMALL_WORKING,
        .storage_write_bytes_per_day=TE_SMALL_STORAGE_DAY,.max_upload_bytes_per_day=TE_SMALL_UPLINK_DAY,.retry_max_attempts=2};
    assert(te_small_policy(&p));p.window_ms=30000;assert(te_small_policy(&p));p.stats_max_addresses=513;assert(!te_small_policy(&p));p.stats_max_addresses=512;
    p.candidate_events=true;assert(!te_small_policy(&p));p.candidate_events=false;
    p.tf_queue=true;assert(!te_small_policy(&p));p.tf_queue=false;
    p.local_raw.enabled=true;assert(!te_small_policy(&p));p.local_raw.enabled=false;
    p.queue_max_items=12;assert(!te_small_policy(&p));p.queue_max_items=3;
    p.max_upload_bytes_per_day++;assert(!te_small_policy(&p));p.max_upload_bytes_per_day--;
    p.temporal.rolling=true;p.temporal.slice_ms=2000;p.temporal.history_ms=600000;p.temporal.max_tracks=512;p.temporal.max_open_events=64;p.temporal.max_event_ms=3600000;p.temporal.report_mode=CP_V3_TEMPORAL_REPORT_OFF;
    assert(te_small_policy(&p));p.temporal.report_mode=CP_V3_TEMPORAL_REPORT_TERMINAL;assert(!te_small_policy(&p));
    t=(cp_v3_temporal_time_t){.utc_ms=1800000000000ULL,.utc_known=true,.uncertainty_ms=250};uint64_t expiry;
    assert(te_small_expiry(t,60000,24,UINT64_MAX,&expiry)&&expiry==t.utc_ms-60250+86400000);
    assert(te_small_expiry(t,60000,24,t.utc_ms+10000,&expiry)&&expiry==t.utc_ms+10000);
    t.utc_known=false;assert(!te_small_expiry(t,60000,24,UINT64_MAX,&expiry));
    t.utc_known=true;t.utc_ms=60000;assert(!te_small_expiry(t,60000,24,UINT64_MAX,&expiry));
    puts("bounded runtime: immutable clock drift, physical queue/profile limits, raw/event exclusion and conservative TTL passed");
}
