#include "board_stats_window.h"
#include <stdint.h>
bool te_v3_window_init(te_v3_stats_window_t *w,void *arena,size_t bytes,const cp_v3_stats_config_t *config) {
    if(!w || w->state!=TE_WINDOW_IDLE || !config ||
       !((config->window_ms==30000 || config->window_ms==60000) && config->bin_ms==5000)) return false;
    return te_v3_stats_worker_init(&w->worker,arena,bytes,config);
}
bool te_v3_window_begin(te_v3_stats_window_t *w,uint64_t start,bool clock_usable) {
    if(!w || w->state!=TE_WINDOW_IDLE || !w->worker.core || !te_v3_stats_worker_begin(&w->worker,start))return false;
    cp_v3_stats_snapshot_t probe;
    if(!te_v3_stats_worker_clock_usable(&w->worker,clock_usable) ||
       !te_v3_stats_worker_snapshot(&w->worker,start,&probe)) {w->state=TE_WINDOW_FAILED;return false;}
    w->start_us=start;w->end_us=probe.end_mono_us;w->stop_us=0;w->last_us=0;
    w->processing_drops=0;w->have_report=false;w->state=TE_WINDOW_COLLECTING;return true;
}
bool te_v3_window_scan_state(te_v3_stats_window_t *w,uint64_t t,bool scan) {
    if(!w || w->state!=TE_WINDOW_COLLECTING || t<w->start_us || t>w->end_us) return false;
    if(!te_v3_stats_worker_scan_state(&w->worker,t,scan)){w->state=TE_WINDOW_FAILED;return false;}
    return true;
}
bool te_v3_window_report(te_v3_stats_window_t *w,const te_v3_report_t *r) {
    if(!w || (w->state!=TE_WINDOW_COLLECTING && w->state!=TE_WINDOW_DRAINING) || !r) return false;
    uint64_t limit=w->state==TE_WINDOW_DRAINING?w->stop_us:w->end_us;
    if(r->mono_us<w->start_us || r->mono_us>=limit || (w->have_report&&r->mono_us<w->last_us)) {
        w->state=TE_WINDOW_FAILED;return false;
    }
    w->last_us=r->mono_us;w->have_report=true;
    cp_v3_stats_result_t result=te_v3_stats_worker_observe(&w->worker,r);
    if(result==CP_V3_STATS_INVALID) {
        if(w->processing_drops==UINT64_MAX){w->state=TE_WINDOW_FAILED;return false;}
        ++w->processing_drops;return true;
    }
    if(result==CP_V3_STATS_OUTSIDE_WINDOW){w->state=TE_WINDOW_FAILED;return false;}
    return true;
}
bool te_v3_window_stop(te_v3_stats_window_t *w,uint64_t stop,bool stopped,bool idle) {
    if(!w || w->state!=TE_WINDOW_COLLECTING || !stopped || !idle ||
       stop<w->start_us || stop>w->end_us || (w->have_report&&w->last_us>=stop))return false;
    if(!te_v3_stats_worker_scan_state(&w->worker,stop,false)){w->state=TE_WINDOW_FAILED;return false;}
    w->stop_us=stop;w->state=TE_WINDOW_DRAINING;return true;
}
bool te_v3_window_finish(te_v3_stats_window_t *w,bool empty,cp_v3_stats_source_t source,cp_v3_stats_snapshot_t *out) {
    if(!w || w->state!=TE_WINDOW_DRAINING || !empty || !out)return false;
    if(source.processing_losses_known) {
        if(source.processing_losses>UINT64_MAX-w->processing_drops){w->state=TE_WINDOW_FAILED;return false;}
        source.processing_losses+=w->processing_drops;
    }
    if(!te_v3_stats_worker_source(&w->worker,source) ||
       !te_v3_stats_worker_finish(&w->worker,w->stop_us,out)) {w->state=TE_WINDOW_FAILED;return false;}
    w->state=TE_WINDOW_IDLE;return true;
}
