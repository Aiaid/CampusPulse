#include "board_stats_worker.h"
#include <stdint.h>
bool te_v3_stats_worker_init(te_v3_stats_worker_t *w,void *arena,size_t bytes,
                             const cp_v3_stats_config_t *config) {
    if (!w || w->core || w->active || !arena || !config) return false;
    size_t alignment=cp_v3_stats_memory_alignment();
    size_t need=cp_v3_stats_memory_bytes(config->capacity);
    if (!alignment || !need || (uintptr_t)arena%alignment || bytes<need) return false;
    cp_v3_stats_t *core=cp_v3_stats_init(arena,bytes,config);
    if (!core) return false;
    w->core=core; return true;
}
bool te_v3_stats_worker_begin(te_v3_stats_worker_t *w,uint64_t start) {
    if (!w || !w->core || w->active || !cp_v3_stats_begin(w->core,start)) return false;
    w->active=true;return true;
}
cp_v3_stats_result_t te_v3_stats_worker_observe(te_v3_stats_worker_t *w,const te_v3_report_t *r) {
    cp_v3_stats_report_t report;
    if (!w || !w->core || !w->active || !te_v3_report_view(r,&report)) return CP_V3_STATS_INVALID;
    return cp_v3_stats_observe(w->core,&report);
}
bool te_v3_stats_worker_scan_state(te_v3_stats_worker_t *w,uint64_t t,bool scanning) {
    return w && w->core && w->active && cp_v3_stats_scan_state(w->core,t,scanning);
}
bool te_v3_stats_worker_source(te_v3_stats_worker_t *w,cp_v3_stats_source_t source) {
    return w && w->core && w->active && cp_v3_stats_set_source(w->core,source);
}
bool te_v3_stats_worker_clock_usable(te_v3_stats_worker_t *w,bool usable) {
    return w && w->core && w->active && cp_v3_stats_set_clock_usable(w->core,usable);
}
bool te_v3_stats_worker_snapshot(te_v3_stats_worker_t *w,uint64_t t,cp_v3_stats_snapshot_t *out) {
    if (!w || !w->core || !w->active || !out || !cp_v3_stats_snapshot(w->core,t,out)) return false;
    if (out->window_closed) w->active=false;
    return true;
}
bool te_v3_stats_worker_finish(te_v3_stats_worker_t *w,uint64_t t,cp_v3_stats_snapshot_t *out) {
    if (!w || !w->core || !w->active || !out || !cp_v3_stats_snapshot(w->core,t,out)) return false;
    w->active=false;return true;
}
