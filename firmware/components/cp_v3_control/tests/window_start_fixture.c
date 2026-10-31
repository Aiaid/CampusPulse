#include "../internal.h"
#include <assert.h>
#include <stdio.h>

static cp_v3_control_t prepared(uint32_t window,uint64_t applied,uint64_t span,cp_v3_time_t now,bool small) {
    cp_v3_control_t c={.state=CP_V3_CONTROL_APPLIED,.small_statistics=small,.applied_at_utc_ms=applied,
        .capture_span_start_utc_ms=span,.clock_epoch=now.clock_epoch,.last_mono_ms=now.mono_ms};
    c.policy.window_ms=window;c.policy.drain_frozen=true;c.policy.accept_until_utc_ms=now.utc_ms+3600000;
    c.deadline_utc_ms=now.utc_ms+600000;c.deadline_mono_ms=v3_deadline_mono(now,c.deadline_utc_ms);
    return c;
}
int main(void) {
    const uint64_t applied=1793318460000ULL;
    const uint32_t windows[]={30000,60000};
    for(unsigned wi=0;wi<2;++wi)for(unsigned new_span=0;new_span<2;++new_span){
        uint32_t window=windows[wi];uint64_t span=applied+(new_span?300000:0),guard=(window+1999)/2000+1;
        /* Enumerate every phase of the rounded 500ppm clock uncertainty. */
        for(unsigned phase=0;phase<2000;++phase){
            cp_v3_time_t at={.mono_ms=60000+phase,.clock_epoch=1};
            at.uncertainty_ms=500+(uint32_t)((at.mono_ms+1999)/2000);
            at.utc_ms=span+at.uncertainty_ms+guard;
            cp_v3_time_t early=at;--early.utc_ms;
            cp_v3_control_t c=prepared(window,applied,span,early,true);
            cp_v3_control_permissions_t denied=cp_v3_control_permissions(&c,early);
            assert(!denied.collection&&denied.reason==CP_V3_CONTROL_WAIT&&denied.uplink&&denied.frozen_only);
            c=prepared(window,applied,span,at,true);
            assert(cp_v3_control_permissions(&c,at).collection);
            /* Worst integral-boundary retreat of1ms, then a complete window.
             * End uncertainty is derived from the same original clock anchor. */
            uint64_t end_mono=at.mono_ms-1+window,end_utc=at.utc_ms-1+window;
            uint64_t end_error=500+(end_mono+1999)/2000;
            assert(end_utc-end_error-window>=span);
        }
    }
    /* max(applied,span) also handles an absent/earlier span field defensively. */
    cp_v3_time_t at={.mono_ms=60000,.utc_ms=applied+500+30,.clock_epoch=1,.uncertainty_ms=500};
    cp_v3_control_t small=prepared(60000,applied,applied-1000,at,true);
    assert(!cp_v3_control_permissions(&small,at).collection);
    /* Legacy feature control retains its original point-time admission. */
    at.utc_ms=applied+at.uncertainty_ms;
    cp_v3_control_t legacy=prepared(60000,applied,applied+300000,at,false);
    assert(cp_v3_control_permissions(&legacy,at).collection);
    puts("small first-window admission: 30/60s, all drift phases, rounding, new spans and legacy isolation passed");
    return 0;
}
