#include "board_stats_worker.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
int main(void) {
    cp_v3_stats_config_t config={.capacity=512,.window_ms=60000,.bin_ms=5000,.rules_version=CP_V3_STATS_RULESET};
    size_t n=cp_v3_stats_memory_bytes(config.capacity),alignment=cp_v3_stats_memory_alignment();
    assert(n && alignment);void *arena=malloc(n+alignment);assert(arena);
    uintptr_t base=(uintptr_t)arena,aligned=base+(alignment-base%alignment)%alignment;
    te_v3_stats_worker_t worker={0};
    assert(!te_v3_stats_worker_init(&worker,(void *)(aligned+1),n,&config));
    assert(!te_v3_stats_worker_init(&worker,(void *)aligned,n-1,&config));
    assert(te_v3_stats_worker_init(&worker,(void *)aligned,n,&config));
    unsigned char independent_temporal[64];memset(independent_temporal,0x6d,sizeof independent_temporal);
    assert(te_v3_stats_worker_begin(&worker,1000000));
    assert(!te_v3_stats_worker_begin(&worker,1000000));
    assert(te_v3_stats_worker_clock_usable(&worker,true));
    assert(te_v3_stats_worker_scan_state(&worker,1000000,true));
    te_v3_report_t r;
    for(unsigned i=0;i<512;i++) {
        te_v3_report_init(&r,i+1,1000000+(uint64_t)i*1000);
        r.address[0]=(uint8_t)i;r.address[1]=(uint8_t)(i>>8);r.address_type=0;
        r.rssi=(i==0)?127:-60;
        if(i==0){r.kind=1;r.props=8;r.event_type=0;r.data_status=1;}
        cp_v3_stats_result_t got=te_v3_stats_worker_observe(&worker,&r);
        assert(got==(i==0?CP_V3_STATS_UNSUPPORTED_REPORT:CP_V3_STATS_OK));
    }
    te_v3_report_init(&r,513,2000000);r.address[0]=0;r.address[1]=2;r.rssi=-70;
    assert(te_v3_stats_worker_observe(&worker,&r)==CP_V3_STATS_ADDRESS_FULL);
    te_v3_report_init(&r,514,61000000);assert(te_v3_stats_worker_observe(&worker,&r)==CP_V3_STATS_OUTSIDE_WINDOW);
    assert(te_v3_stats_worker_scan_state(&worker,11000000,false));
    assert(te_v3_stats_worker_scan_state(&worker,21000000,true));
    cp_v3_stats_source_t src={.reports_seen_known=true,.queue_drops_known=true,.processing_losses_known=true,.reports_seen=513};
    assert(te_v3_stats_worker_source(&worker,src));
    cp_v3_stats_snapshot_t out;
    assert(te_v3_stats_worker_snapshot(&worker,30000000,&out) && !out.window_closed);
    assert(!te_v3_stats_worker_begin(&worker,61000000));
    assert(te_v3_stats_worker_snapshot(&worker,61000000,&out) && out.window_closed);
    assert(out.worker_reports==513 && out.adv_reports==512 && out.scan_response_reports==1);
    assert(out.unique_keys==512 && out.address_overflow_reports==1 && out.counts[CP_V3_STATS_UNKNOWN]==512);
    assert(out.fragment_more_reports==1 && out.unsupported_reports==1 && out.outside_window_reports==1);
    assert(out.rssi_samples==512 && out.rssi_sum==-(511*60+70) && out.rssi_unknown_reports==1);
    assert(out.configured_bins==12 && out.bin_count==12 && out.scan_coverage_ms==50000 && (out.quality_mask&4) && (out.quality_mask&8));
    for(unsigned i=0;i<sizeof independent_temporal;i++)assert(independent_temporal[i]==0x6d);
    assert(te_v3_stats_worker_observe(&worker,&r)==CP_V3_STATS_INVALID);
    assert(te_v3_stats_worker_begin(&worker,61000000));
    assert(te_v3_stats_worker_snapshot(&worker,121000000,&out)&&out.window_closed&&out.worker_reports==0);
    for(unsigned i=0;i<sizeof independent_temporal;i++)assert(independent_temporal[i]==0x6d);
    cp_v3_stats_free(worker.core);free(arena);printf("board stats worker tests passed (host workspace=%zu alignment=%zu)\n",n,alignment);
}
