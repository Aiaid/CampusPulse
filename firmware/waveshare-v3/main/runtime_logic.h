#pragma once
#include "cp_v3_evidence.h"
#include "cp_v3_temporal.h"
#include <limits.h>
/* Immutable anchor: drift is rounded once from the original anchor, never
 * incrementally on each reader call. No networking or wall-clock mutation. */
static inline bool edge_clock_at(cp_v3_time_t a,uint64_t mono,cp_v3_temporal_time_t *out) {
    if(!out||!a.clock_epoch||mono<a.mono_ms) return false;
    uint64_t delta=mono-a.mono_ms,growth=(delta+1999)/2000;
    if(delta>UINT64_MAX-a.utc_ms||growth>UINT32_MAX-a.uncertainty_ms||a.uncertainty_ms+growth>5000) return false;
    *out=(cp_v3_temporal_time_t){mono,a.utc_ms+delta,a.clock_epoch,(uint32_t)(a.uncertainty_ms+growth),true};
    return true;
}
static inline bool edge_retention_expiry(cp_v3_temporal_time_t source,uint32_t duration,uint32_t hours,uint64_t *out) {
    uint64_t age=(uint64_t)hours*3600000;
    if(!out||!source.utc_known||!hours||source.utc_ms<duration+(uint64_t)source.uncertainty_ms) return false;
    uint64_t lower=source.utc_ms-duration-source.uncertainty_ms;
    if(lower>UINT64_MAX-age) return false;
    *out=lower+age;return true;
}
static inline bool edge_time_aged(cp_v3_temporal_time_t current,uint64_t required_upper) {
    return current.utc_known&&current.utc_ms>=current.uncertainty_ms&&current.utc_ms-current.uncertainty_ms>=required_upper;
}
/* Durable progress catches up with every closed source window before a manual
 * storage pause may resume. Persisted-count is never a source sequence. */
static inline bool edge_storage_resume_ready(bool paused,bool running,bool bounded,
    uint32_t durable_seq,uint32_t closed_seq,uint16_t terminals,uint16_t pending_terminals) {
    return paused&&!running&&!bounded&&closed_seq<UINT32_MAX&&durable_seq==closed_seq&&!terminals&&!pending_terminals;
}
