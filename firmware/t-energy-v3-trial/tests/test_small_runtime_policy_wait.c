/* The device's real wait loop with virtual time/network. No serial or NVS. */
#include "small_runtime_policy_wait.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
typedef struct {
    cp_v3_control_t control;
    cp_v3_time_t now;
    uint64_t offer_at,request_ms;
    unsigned requests,offers,waits,samples;
    bool stop,stop_in_request,stop_in_wait,clock_bad,regress,epoch_change;
    te_small_policy_poll_t result;
} fixture_t;
static fixture_t fresh(void){
    fixture_t f={0};
    f.control.clock_epoch=1;f.control.capability_issued_utc_ms=1800000000000ULL;
    f.control.capability_expires_utc_ms=f.control.capability_issued_utc_ms+1800000;
    f.control.trusted_utc_lower_ms=f.control.capability_issued_utc_ms;
    f.now=(cp_v3_time_t){.utc_ms=f.control.capability_issued_utc_ms+10,.uncertainty_ms=10,.clock_epoch=1};
    f.offer_at=600000;f.result=TE_POLICY_RESPONSE;return f;
}
static bool stopped(void *p){return ((fixture_t *)p)->stop;}
static bool current(void *p,cp_v3_time_t *t){
    fixture_t *f=p;f->samples++;*t=f->now;
    if(f->requests&&f->regress)t->mono_ms=0;
    if(f->requests&&f->epoch_change)t->clock_epoch++;
    return !f->clock_bad;
}
static void advance(fixture_t *f,uint64_t ms){f->now.mono_ms+=ms;f->now.utc_ms+=ms;}
static te_small_policy_poll_t poll(void *p){
    fixture_t *f=p;f->requests++;advance(f,f->request_ms);if(f->stop_in_request)f->stop=true;return f->result;
}
static bool offer(void *p,cp_v3_time_t t){
    fixture_t *f=p;f->offers++;assert(t.utc_ms+t.uncertainty_ms<f->control.capability_expires_utc_ms);
    return t.mono_ms>=f->offer_at;
}
static bool wait_ms(void *p,uint32_t ms){
    fixture_t *f=p;assert(ms==100);f->waits++;advance(f,ms);if(f->stop_in_wait)f->stop=true;return !f->stop;
}
static te_small_policy_wait_result_t run(fixture_t *f){
    te_small_policy_wait_io_t io={f,stopped,current,poll,offer,wait_ms};return te_small_policy_wait(&io,&f->control);
}
int main(void){
    fixture_t f=fresh();assert(run(&f)==TE_POLICY_OFFERED&&f.now.mono_ms==600000&&f.requests==601);
    /* There is no 180-request limit, even when every response is retryable. */
    f=fresh();f.result=TE_POLICY_PENDING;assert(run(&f)==TE_POLICY_EXPIRED&&f.requests>180&&!f.offers);
    f=fresh();f.request_ms=1800000;assert(run(&f)==TE_POLICY_EXPIRED&&f.requests==1&&!f.offers&&!f.waits);
    f=fresh();f.now.utc_ms=f.control.capability_expires_utc_ms-10;assert(run(&f)==TE_POLICY_EXPIRED&&!f.requests);
    f=fresh();f.request_ms=100;f.control.capability_expires_utc_ms=f.now.utc_ms+101;
    assert(run(&f)==TE_POLICY_EXPIRED&&!f.offers); /* uncertainty consumes remaining authority */
    f=fresh();f.clock_bad=true;assert(run(&f)==TE_POLICY_CLOCK_INVALID&&!f.requests);
    f=fresh();f.now.mono_ms=100;f.regress=true;assert(run(&f)==TE_POLICY_CLOCK_INVALID&&f.requests==1&&!f.offers);
    f=fresh();f.epoch_change=true;assert(run(&f)==TE_POLICY_CLOCK_INVALID&&!f.offers);
    f=fresh();f.now.uncertainty_ms=5001;assert(run(&f)==TE_POLICY_CLOCK_INVALID&&!f.requests);
    f=fresh();f.result=TE_POLICY_TERMINAL;assert(run(&f)==TE_POLICY_REQUEST_FAILED&&f.requests==1&&!f.offers&&!f.waits);
    f=fresh();f.stop=true;assert(run(&f)==TE_POLICY_CANCELLED&&!f.requests);
    f=fresh();f.stop_in_request=true;assert(run(&f)==TE_POLICY_CANCELLED&&f.requests==1&&!f.offers);
    f=fresh();f.stop_in_wait=true;assert(run(&f)==TE_POLICY_CANCELLED&&f.requests==1&&f.waits==1);
    puts("policy wait: actual capability expiry, late offer, slow response, clock integrity and cancellation passed");
}
