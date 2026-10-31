#pragma once
#include "board_stats_worker.h"
/* Single worker owns this state. No temporal pointer exists here. The caller
 * must establish actual radio stop and callback quiescence before stop(). */
typedef enum { TE_WINDOW_IDLE,TE_WINDOW_COLLECTING,TE_WINDOW_DRAINING,TE_WINDOW_FAILED } te_v3_window_state_t;
typedef struct {
    te_v3_stats_worker_t worker;
    te_v3_window_state_t state;
    uint64_t start_us,end_us,stop_us,last_us,processing_drops;
    bool have_report;
} te_v3_stats_window_t;
bool te_v3_window_init(te_v3_stats_window_t *,void *arena,size_t bytes,const cp_v3_stats_config_t *);
bool te_v3_window_begin(te_v3_stats_window_t *,uint64_t start_us,bool clock_usable);
bool te_v3_window_scan_state(te_v3_stats_window_t *,uint64_t mono_us,bool scanning);
/* Call while collecting, or while draining records that were admitted before
 * stop. Bad AD/fragment and address overflow are counted by the shared core.
 * Out-of-order/out-of-window reports fail the window; never silently reassign. */
bool te_v3_window_report(te_v3_stats_window_t *,const te_v3_report_t *);
/* scan_stopped AND callbacks_idle are attestations from the radio owner. */
bool te_v3_window_stop(te_v3_stats_window_t *,uint64_t stop_us,bool scan_stopped,bool callbacks_idle);
/* queue_empty must be established after callbacks became idle. Source counts
 * are caller-owned window totals and may be unknown; no invented zero counts. */
bool te_v3_window_finish(te_v3_stats_window_t *,bool queue_empty,cp_v3_stats_source_t source,cp_v3_stats_snapshot_t *);
