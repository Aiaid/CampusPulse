#include "board_stats_window.h"
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
static void exercise(uint32_t duration) {
    cp_v3_stats_config_t c={.capacity=512,.window_ms=duration,.bin_ms=5000,.rules_version=CP_V3_STATS_RULESET};
    size_t n=cp_v3_stats_memory_bytes(c.capacity),a=cp_v3_stats_memory_alignment();
    void *raw=malloc(n+a);assert(raw);uintptr_t p=(uintptr_t)raw;p+=(a-p%a)%a;
    te_v3_stats_window_t w={0};assert(te_v3_window_init(&w,(void*)p,n,&c));
    unsigned char temporal[16];memset(temporal,0x95,sizeof temporal);
    assert(te_v3_window_begin(&w,1000000,true));
    assert(te_v3_window_scan_state(&w,1000000,true));
    te_v3_report_t r;te_v3_report_init(&r,1,2000000);r.rssi=-42;
    assert(te_v3_window_report(&w,&r));
    assert(!te_v3_window_stop(&w,3000000,false,true));
    assert(!te_v3_window_stop(&w,3000000,true,false));
    uint64_t end=1000000+(uint64_t)duration*1000;
    assert(te_v3_window_stop(&w,end,true,true));
    te_v3_report_init(&r,3,3000000);r.address[0]=1;r.kind=1;r.data_status=1;r.rssi=127;
    assert(te_v3_window_report(&w,&r));
    te_v3_report_init(&r,4,4000000);r.kind=2; /* invalid board metadata */
    assert(te_v3_window_report(&w,&r));
    cp_v3_stats_source_t src={.reports_seen_known=true,.queue_drops_known=true,.processing_losses_known=true,.reports_seen=4,.queue_drops=1};
    cp_v3_stats_snapshot_t s;assert(!te_v3_window_finish(&w,false,src,&s));
    assert(te_v3_window_finish(&w,true,src,&s));
    assert(s.window_closed && s.duration_ms==duration && s.worker_reports==2 && s.received_reports==4);
    assert(s.callback_drops==1 && s.aggregation_drops==1 && s.source_consistent && (s.quality_mask&16) && (s.quality_mask&32));
    assert(s.fragment_more_reports==1 && s.rssi_samples==1 && s.rssi_sum==-42);
    assert(te_v3_window_begin(&w,end,true));
    assert(te_v3_window_scan_state(&w,end,true));
    assert(te_v3_window_stop(&w,end+1000000,true,true));
    cp_v3_stats_source_t unknown={0};assert(te_v3_window_finish(&w,true,unknown,&s));
    assert(!s.window_closed && (s.quality_mask&1) && !s.source_consistent && !s.received_reports_known);
    assert(s.scan_coverage_ms==1000 && s.snapshot_mono_us==end+1000000);
    for(unsigned i=0;i<sizeof temporal;i++)assert(temporal[i]==0x95);
    assert(te_v3_window_begin(&w,end+2000000,false));
    te_v3_report_init(&r,1,end+2000001);assert(te_v3_window_report(&w,&r));
    assert(te_v3_window_stop(&w,end+3000000,true,true));
    te_v3_report_init(&r,2,end+3000000);assert(!te_v3_window_report(&w,&r));
    assert(w.state==TE_WINDOW_FAILED && !te_v3_window_finish(&w,true,src,&s));
    cp_v3_stats_free(w.worker.core);free(raw);
}
static void out_of_order(void) {
    cp_v3_stats_config_t c={.capacity=8,.window_ms=30000,.bin_ms=5000,.rules_version=CP_V3_STATS_RULESET};
    size_t n=cp_v3_stats_memory_bytes(c.capacity),a=cp_v3_stats_memory_alignment();
    void *raw=malloc(n+a);assert(raw);uintptr_t p=(uintptr_t)raw;p+=(a-p%a)%a;
    te_v3_stats_window_t w={0};te_v3_report_t r;
    assert(te_v3_window_init(&w,(void*)p,n,&c)&&te_v3_window_begin(&w,1000000,false));
    te_v3_report_init(&r,1,3000000);assert(te_v3_window_report(&w,&r));
    te_v3_report_init(&r,2,2000000);assert(!te_v3_window_report(&w,&r)&&w.state==TE_WINDOW_FAILED);
    cp_v3_stats_free(w.worker.core);free(raw);
}
int main(void) {exercise(30000);exercise(60000);out_of_order();puts("board stats window tests passed");}
