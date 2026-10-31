#include "../internal.h"
#include <assert.h>
#include <stdio.h>

int main(void) {
    cp_v3_time_t now={.mono_ms=60000,.utc_ms=1793318460000ULL,.clock_epoch=1,.uncertainty_ms=500};
    uint64_t upper=now.utc_ms+now.uncertainty_ms;
    const uint64_t horizons[]={0,1,2,3,1999,2000,2001,2002,30000,120000,300000,600000,86400000};
    for(unsigned i=0;i<sizeof horizons/sizeof *horizons;++i){
        uint64_t r=horizons[i],deadline=upper+r,mapped=v3_deadline_mono(now,deadline);
        assert(mapped>=now.mono_ms&&mapped<=now.mono_ms+r);
        uint64_t delta=mapped-now.mono_ms;
        if(r<=1){assert(!delta);continue;}
        assert(upper+delta+(delta+1999)/2000<deadline);
        /* At the returned monotonic cutoff the permission fails even when the
         * currently provided uncertainty is stale: scanner has an independent
         * strict bound, and transport's worst-case future bound still fits. */
        cp_v3_control_t c={.state=CP_V3_CONTROL_APPLIED,.applied_at_utc_ms=now.utc_ms-1000,
            .deadline_utc_ms=deadline,.deadline_mono_ms=mapped,.last_mono_ms=now.mono_ms,.clock_epoch=1};
        cp_v3_time_t at=now;at.mono_ms=mapped;at.utc_ms+=delta;
        assert(!cp_v3_control_permissions(&c,at).collection);
    }
    assert(v3_deadline_mono(now,upper-1)==now.mono_ms);
    cp_v3_time_t near=now;near.mono_ms=V3_SAFE-2;
    assert(v3_deadline_mono(near,upper+600000)==V3_SAFE);
    puts("strict lease cutoff: 500ppm growth, half-open UTC, tiny horizons and overflow bounds passed");
    return 0;
}
