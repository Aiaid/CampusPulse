#pragma once
#include "board_report.h"
/* One worker task owns this object, its arena and every operation below.
 * This module never references or clears the independent temporal arena.
 * Callers stop ingress and drain callbacks/slots before final snapshot. */
typedef struct { cp_v3_stats_t *core; bool active; } te_v3_stats_worker_t;
/* Worker must be zero-initialized. Caller owns aligned PSRAM arena. Obtain capacity-specific bytes/alignment
 * from the shared ABI; this function neither allocates nor takes ownership. */
bool te_v3_stats_worker_init(te_v3_stats_worker_t *,void *arena,size_t bytes,
                             const cp_v3_stats_config_t *);
bool te_v3_stats_worker_begin(te_v3_stats_worker_t *,uint64_t start_mono_us);
cp_v3_stats_result_t te_v3_stats_worker_observe(te_v3_stats_worker_t *,const te_v3_report_t *);
bool te_v3_stats_worker_scan_state(te_v3_stats_worker_t *,uint64_t mono_us,bool scanning);
bool te_v3_stats_worker_source(te_v3_stats_worker_t *,cp_v3_stats_source_t);
bool te_v3_stats_worker_clock_usable(te_v3_stats_worker_t *,bool usable);
/* A partial snapshot leaves the window active. A complete snapshot closes it;
 * only then may begin reset this statistics core for a new window. */
bool te_v3_stats_worker_snapshot(te_v3_stats_worker_t *,uint64_t mono_us,cp_v3_stats_snapshot_t *);
/* Finalize even a partial snapshot. Only for a quiescent, fully drained ingress;
 * lifecycle owner enforces that prerequisite. */
bool te_v3_stats_worker_finish(te_v3_stats_worker_t *,uint64_t mono_us,cp_v3_stats_snapshot_t *);
