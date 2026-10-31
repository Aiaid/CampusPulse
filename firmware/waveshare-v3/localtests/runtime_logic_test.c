#include "runtime_logic.h"
#include "runtime_json.h"
#include <assert.h>
#include <stdio.h>
static bool upper(const char *json,uint64_t *u){return edge_frozen_upper(json,strlen(json),u);}
int main(void) {
    cp_v3_time_t a={.mono_ms=100,.utc_ms=10000,.clock_epoch=1,.uncertainty_ms=251};cp_v3_temporal_time_t t;
    assert(!edge_clock_at(a,99,&t));assert(edge_clock_at(a,100,&t)&&t.utc_ms==10000&&t.uncertainty_ms==251);
    for(unsigned i=0;i<10000;i++)assert(edge_clock_at(a,101,&t)&&t.uncertainty_ms==252);
    assert(edge_clock_at(a,2100,&t)&&t.utc_ms==12000&&t.uncertainty_ms==252);
    assert(edge_clock_at(a,2101,&t)&&t.uncertainty_ms==253);
    assert(!edge_clock_at(a,100+10000000,&t));
    a.utc_ms=UINT64_MAX;assert(!edge_clock_at(a,101,&t));a.utc_ms=10000;a.clock_epoch=0;assert(!edge_clock_at(a,100,&t));
    uint64_t expiry;t=(cp_v3_temporal_time_t){.utc_ms=100000,.mono_ms=20000,.uncertainty_ms=200,.utc_known=true};
    assert(edge_retention_expiry(t,10000,1,&expiry)&&expiry==3689800);
    assert(!edge_retention_expiry(t,100001,1,&expiry));t.utc_known=false;assert(!edge_retention_expiry(t,0,1,&expiry));
    t.utc_known=true;assert(!edge_retention_expiry(t,0,0,&expiry));
    t.utc_ms=1000;t.uncertainty_ms=100;assert(edge_time_aged(t,900)&&!edge_time_aged(t,901));
    t.utc_known=false;assert(!edge_time_aged(t,0));
    uint64_t u;
    assert(upper("{\"k\":\"window_statistics\",\"x\":[{\"t\":[10,1000,1,200]}]}",&u)&&u==1200);
    assert(upper("{\"k\":\"node_status\",\"x\":[{\"t\":[10,1000,1,200]}]}",&u)&&u==1200);
    assert(!upper("{\"k\":\"node_status\",\"x\":[{\"t\":[10,null,1,null]}]}",&u));
    assert(!upper("{\"k\":\"node_status\",\"x\":[{\"t\":[10,1e999,1,0]}]}",&u));
    assert(!upper("{\"k\":\"node_status\",\"x\":[{\"t\":[10,1000.5,1,0]}]}",&u));
    assert(!upper("{\"k\":\"node_status\",\"x\":[{\"t\":[10,1000,1,5001]}]}",&u));
    assert(upper("{\"k\":\"candidate_events\",\"x\":[{\"a\":[1,1000,1,5],\"l\":[2,2000,1,10],\"u\":[2,2000,1,10],\"e\":[3,3000,1,20]}]}",&u)&&u==3020);
    assert(upper("{\"k\":\"candidate_events\",\"x\":[{\"a\":[1,1000,1,5],\"l\":[2,2000,1,10],\"u\":[3,3000,1,20],\"e\":null}]}",&u)&&u==3020);
    assert(!upper("{\"k\":\"candidate_events\",\"x\":[{\"a\":[1,1000,1,5],\"l\":[2,2000,1,10]}]}",&u));
    assert(!upper("{\"k\":\"node_status\",\"x\":[{\"t\":[10,1000,1,200]}]}junk",&u));
    assert(edge_storage_resume_ready(true,false,false,5,5,0,0));
    assert(!edge_storage_resume_ready(true,false,false,4,5,0,0));
    assert(!edge_storage_resume_ready(true,false,false,5,5,1,0));
    assert(!edge_storage_resume_ready(true,false,false,5,5,0,1));
    assert(!edge_storage_resume_ready(false,false,false,5,5,0,0));
    assert(!edge_storage_resume_ready(true,true,false,5,5,0,0));
    assert(!edge_storage_resume_ready(true,false,true,5,5,0,0));
    assert(!edge_storage_resume_ready(true,false,false,UINT32_MAX,UINT32_MAX,0,0));
    bool retryable=false;const char *failure="{\"error\":{\"code\":\"v3_statistics_capture_unauthorized\",\"message\":\"private text\",\"retryable\":false}}";
    assert(!strcmp(edge_error_code(failure,strlen(failure),&retryable),"v3_statistics_capture_unauthorized")&&!retryable);
    failure="{\"error\":{\"code\":\"private_arbitrary_text\",\"retryable\":false}}";
    assert(!strcmp(edge_error_code(failure,strlen(failure),&retryable),"unavailable")&&retryable);
    failure="{\"error\":{\"code\":\"v3_statistics_capture_unauthorized\"}}junk";
    assert(!strcmp(edge_error_code(failure,strlen(failure),&retryable),"unavailable")&&retryable);
    failure="{\"error\":{\"code\":\"v3_statistics_capture_unauthorized\",\"retryable\":true}}";
    assert(!strcmp(edge_error_code(failure,strlen(failure),&retryable),"v3_statistics_capture_unauthorized")&&retryable);
    puts("Immutable clock, retention, frozen window/event/status aging passed");
}
