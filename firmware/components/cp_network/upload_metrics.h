#ifndef CP_UPLOAD_METRICS_H
#define CP_UPLOAD_METRICS_H
#include "cp_debug.h"
#include <string.h>

typedef struct {
    cp_debug_upload_t view;
    uint64_t started_ms, finished_ms;
} cp_upload_metrics_t;
static inline uint32_t cp_upload_sat_u32(uint64_t n) {
    return n > UINT32_MAX ? UINT32_MAX : (uint32_t)n;
}
static inline uint32_t cp_upload_elapsed(uint64_t now, uint64_t then) {
    return now >= then ? cp_upload_sat_u32(now - then) : 0;
}
static inline void cp_upload_metrics_begin(cp_upload_metrics_t *m, uint32_t bytes, uint64_t now) {
    /* Caller owns the HTTP lock: excludes lock wait, journal read and previous
     * retries, includes this attempt's DNS/TLS/HTTP/cleanup/ACK validation. */
    m->started_ms = now;
    m->view.in_flight = true;
    m->view.attempt_bytes = bytes;
    m->view.attempt_elapsed_ms = 0;
}
static inline void cp_upload_metrics_finish(cp_upload_metrics_t *m,
    cp_debug_upload_result_t result, int32_t http, int32_t error, uint64_t now) {
    cp_debug_upload_t *v = &m->view;
    v->known = true;
    v->in_flight = false;
    v->result = result;
    v->last_bytes = v->attempt_bytes;
    uint64_t elapsed = now >= m->started_ms ? now-m->started_ms : 0;
    v->last_elapsed_ms = cp_upload_elapsed(now, m->started_ms);
    v->attempt_elapsed_ms = v->last_elapsed_ms;
    v->last_http_status = http;
    v->last_error = error;
    v->acked_bytes = result == CP_DEBUG_UPLOAD_ACKED ? v->last_bytes : 0;
    v->goodput_known = result == CP_DEBUG_UPLOAD_ACKED && elapsed > 0;
    v->goodput_bytes_per_sec = v->goodput_known ?
        cp_upload_sat_u32((uint64_t)v->acked_bytes * 1000u / elapsed) : 0;
    if (result == CP_DEBUG_UPLOAD_ACKED) v->consecutive_failures = 0;
    else {
        if (v->consecutive_failures < UINT32_MAX) ++v->consecutive_failures;
        if (v->failures < UINT32_MAX) ++v->failures;
    }
    m->finished_ms = now;
}
static inline void cp_upload_metrics_snapshot(const cp_upload_metrics_t *m,
    uint64_t now, cp_debug_upload_t *out) {
    *out = m->view;
    out->last_age_ms = out->known ? cp_upload_elapsed(now, m->finished_ms) : 0;
    if (out->in_flight) out->attempt_elapsed_ms = cp_upload_elapsed(now, m->started_ms);
}
#endif
