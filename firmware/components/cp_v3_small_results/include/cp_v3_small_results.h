#pragma once
#include "cp_v3_evidence.h"
#include "cp_v3_stats.h"
#include "cp_v3_temporal.h"

/* Compact one-item statistics/1 serialization only. No address/history access,
 * collection, queue, upload, storage, clock calibration or policy application. */
#define CP_V3_SMALL_RULESET "unclassified-v1"
typedef cp_v3_temporal_time_t cp_v3_small_time_t;
typedef enum { CP_V3_SMALL_RUNNING,CP_V3_SMALL_PAUSED,CP_V3_SMALL_FAILED } cp_v3_small_state_t;
typedef struct {
    cp_v3_small_time_t time;
    cp_v3_small_state_t state;
    uint8_t resource_known_mask; /* bit0..4; unknown renders null, never zero. */
    uint64_t resources[5]; /* internal free/min/largest, PSRAM free, stack min. */
    uint64_t queue[6]; /* window items/bytes,event items/bytes,status items/bytes. */
    uint64_t losses[6]; /* window,event,status coalesced,upload,ACK,retry. */
    bool local_raw_counters_known;
    uint64_t local_raw[6]; /* enqueued,written,synced,queue drops,storage fails,space stops. */
} cp_v3_small_status_t;

cp_v3_result_t cp_v3_small_window_body(const cp_v3_scope_t *,const cp_v3_stats_snapshot_t *,
    cp_v3_small_time_t end,const char *batch_id,uint32_t seq,cp_v3_sha256_fn,void *,
    char *,size_t,size_t *,cp_v3_expected_t *);
cp_v3_result_t cp_v3_small_event_body(const cp_v3_scope_t *,const cp_v3_temporal_event_t *,
    uint32_t slice_ms,const char *batch_id,uint32_t seq,cp_v3_sha256_fn,void *,
    char *,size_t,size_t *,cp_v3_expected_t *);
cp_v3_result_t cp_v3_small_status_body(const cp_v3_scope_t *,const cp_v3_small_status_t *,
    const char *batch_id,uint32_t seq,cp_v3_sha256_fn,void *,char *,size_t,size_t *,cp_v3_expected_t *);
