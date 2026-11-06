#pragma once
#include "cp_v3_control.h"

typedef enum { TE_POLICY_PENDING,TE_POLICY_RESPONSE,TE_POLICY_TERMINAL } te_small_policy_poll_t;
typedef enum {
    TE_POLICY_OFFERED,TE_POLICY_EXPIRED,TE_POLICY_CLOCK_INVALID,
    TE_POLICY_CANCELLED,TE_POLICY_REQUEST_FAILED
} te_small_policy_wait_result_t;
typedef struct {
    void *context;
    bool (*stopped)(void *);
    bool (*current)(void *,cp_v3_time_t *);
    te_small_policy_poll_t (*poll)(void *);
    bool (*offer)(void *,cp_v3_time_t);
    bool (*wait)(void *,uint32_t);
} te_small_policy_wait_io_t;
/* No new capability, authority extension, or attempt-count timeout. A slow GET
 * must pass another fresh clock check before its bytes can enter control. */
static inline te_small_policy_wait_result_t te_small_policy_wait(
    const te_small_policy_wait_io_t *io,const cp_v3_control_t *control){
    if(!io||!control||!io->stopped||!io->current||!io->poll||!io->offer||!io->wait)
        return TE_POLICY_CLOCK_INVALID;
    uint64_t last_mono=control->last_mono_ms,lower=control->trusted_utc_lower_ms;
    bool completed=false;unsigned idle=0;te_small_policy_poll_t result=TE_POLICY_PENDING;
    for(;;){
        if(io->stopped(io->context))return TE_POLICY_CANCELLED;
        cp_v3_time_t t={0};
        if(!io->current(io->context,&t)||!t.clock_epoch||t.clock_epoch!=control->clock_epoch||
           t.mono_ms<last_mono||t.mono_ms>UINT64_C(9007199254740991)||
           t.uncertainty_ms>5000||t.utc_ms<t.uncertainty_ms||t.utc_ms>UINT64_C(8640000000000000)||
           t.utc_ms-t.uncertainty_ms<lower||t.utc_ms-t.uncertainty_ms<control->capability_issued_utc_ms)
            return TE_POLICY_CLOCK_INVALID;
        last_mono=t.mono_ms;lower=t.utc_ms-t.uncertainty_ms;
        if(t.utc_ms+t.uncertainty_ms>=control->capability_expires_utc_ms)return TE_POLICY_EXPIRED;
        if(completed){
            completed=false;
            if(result==TE_POLICY_TERMINAL)return TE_POLICY_REQUEST_FAILED;
            if(result==TE_POLICY_RESPONSE&&io->offer(io->context,t))return TE_POLICY_OFFERED;
            idle=10;
        }
        if(idle){
            if(!io->wait(io->context,100))return TE_POLICY_CANCELLED;
            idle--;continue;
        }
        result=io->poll(io->context);completed=true;
        /* Always resample after IO, including transient failures. */
    }
}
