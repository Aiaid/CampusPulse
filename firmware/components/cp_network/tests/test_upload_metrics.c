#include "upload_metrics.h"
#include <assert.h>
#include <stdio.h>

int main(void) {
    cp_upload_metrics_t m={0};
    cp_debug_upload_t v;
    cp_upload_metrics_snapshot(&m,100,&v);
    assert(!v.known && !v.in_flight && !v.goodput_known);
    cp_upload_metrics_begin(&m,8192,100);
    cp_upload_metrics_snapshot(&m,1100,&v);
    assert(v.in_flight && !v.known && v.attempt_bytes==8192 && v.attempt_elapsed_ms==1000);
    /* Whole request elapsed includes preflight/TLS/response/ACK parsing. */
    cp_upload_metrics_finish(&m,CP_DEBUG_UPLOAD_ACKED,200,0,2100);
    cp_upload_metrics_snapshot(&m,4100,&v);
    assert(v.known && !v.in_flight && v.acked_bytes==8192 && v.goodput_known);
    assert(v.goodput_bytes_per_sec==4096 && v.last_age_ms==2000 && !v.failures);
    /* A new in-flight attempt retains an explicitly aged previous result. */
    cp_upload_metrics_begin(&m,4096,5000);
    cp_upload_metrics_snapshot(&m,6000,&v);
    assert(v.in_flight && v.last_bytes==8192 && v.last_age_ms==3900 && v.attempt_bytes==4096);
    /* HTTP 200 without a verified identity/count/hash ACK is never goodput. */
    cp_upload_metrics_finish(&m,CP_DEBUG_UPLOAD_BAD_ACK,200,0,7000);
    cp_upload_metrics_snapshot(&m,8000,&v);
    assert(v.result==CP_DEBUG_UPLOAD_BAD_ACK && v.last_http_status==200);
    assert(!v.goodput_known && !v.acked_bytes && !v.goodput_bytes_per_sec);
    assert(v.failures==1 && v.consecutive_failures==1);
    const cp_debug_upload_result_t failures[]={CP_DEBUG_UPLOAD_RETRY,CP_DEBUG_UPLOAD_REJECTED,
        CP_DEBUG_UPLOAD_AUTH,CP_DEBUG_UPLOAD_POLICY};
    for (unsigned i=0;i<sizeof failures/sizeof failures[0];++i) {
        cp_upload_metrics_begin(&m,4096,8000+i*1000);
        cp_upload_metrics_finish(&m,failures[i],i?403:0,-1,8500+i*1000);
        assert(!m.view.goodput_known && !m.view.acked_bytes);
    }
    assert(m.view.failures==5 && m.view.consecutive_failures==5);
    cp_upload_metrics_begin(&m,1,20000);
    cp_upload_metrics_finish(&m,CP_DEBUG_UPLOAD_ACKED,200,0,20000);
    assert(m.view.acked_bytes==1 && !m.view.goodput_known && !m.view.consecutive_failures);
    cp_upload_metrics_begin(&m,UINT32_MAX,21000);
    cp_upload_metrics_finish(&m,CP_DEBUG_UPLOAD_ACKED,200,0,21001);
    assert(m.view.goodput_bytes_per_sec==UINT32_MAX); /* No multiplication overflow. */
    cp_upload_metrics_snapshot(&m,UINT64_MAX,&v);
    assert(v.last_age_ms==UINT32_MAX);
    cp_upload_metrics_snapshot(&m,1,&v);
    assert(v.last_age_ms==0); /* Defensive monotonic rollback. */
    cp_upload_metrics_begin(&m,8192,0);
    cp_upload_metrics_finish(&m,CP_DEBUG_UPLOAD_ACKED,200,0,UINT64_MAX);
    assert(m.view.last_elapsed_ms==UINT32_MAX && m.view.goodput_known);
    assert(m.view.goodput_bytes_per_sec==0); /* Rate uses full elapsed, not its display cap. */
    m.view.failures=m.view.consecutive_failures=UINT32_MAX;
    cp_upload_metrics_begin(&m,1,0);
    cp_upload_metrics_finish(&m,CP_DEBUG_UPLOAD_RETRY,0,-1,UINT64_MAX);
    assert(m.view.failures==UINT32_MAX && m.view.consecutive_failures==UINT32_MAX);
    assert(m.view.last_elapsed_ms==UINT32_MAX);
    puts("upload telemetry: verified ACK, failure, age, in-flight and saturation cases passed");
}
