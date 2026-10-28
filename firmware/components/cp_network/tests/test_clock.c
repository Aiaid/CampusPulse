#include "clock_state.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

static void bootstrap_and_authenticated_anchor(void)
{
    cp_network_snapshot_t clock={.clock_uncertainty_ms=UINT32_MAX};
    cp_network_clock_sntp(&clock,1000,1792843200000ULL);
    assert(!clock.clock_trusted && !clock.clock_estimated);
    assert(clock.clock_uncertainty_ms==UINT32_MAX && clock.clock_epoch==1);
    /* A successful TLS exchange alone cannot measure SNTP's uncertainty. */
    clock.clock_trusted=true;
    assert(clock.clock_uncertainty_ms==UINT32_MAX);
    assert(cp_network_clock_server(&clock,1200,1401,1792843200300ULL));
    assert(clock.clock_trusted && clock.clock_estimated);
    assert(clock.clock_mono_ms==1300 && clock.clock_utc_ms==1792843200300ULL);
    assert(clock.clock_uncertainty_ms==102 && clock.clock_epoch==2);

    /* Regression: a callback drained after a config response used to erase the
     * usable anchor, causing unknown timestamps/uncertainty and collector stop. */
    cp_network_snapshot_t anchored=clock;
    for (unsigned i=0;i<4;++i) {
        cp_network_clock_sntp(&clock,3600000ULL*(i+1),1792846800000ULL+3600000ULL*i);
        assert(!memcmp(&clock,&anchored,sizeof(clock)));
    }
    /* Same-boot network restart clears trust until fresh HTTPS succeeds, but
     * must preserve the prior estimate for drift aging rather than use SNTP. */
    clock.clock_trusted=false;
    cp_network_clock_sntp(&clock,15000000,1792858200000ULL);
    assert(!clock.clock_trusted && clock.clock_estimated);
    assert(clock.clock_uncertainty_ms==102 && clock.clock_mono_ms==1300);
    assert(cp_network_clock_server(&clock,15000100,15000100,1792858200100ULL));
    assert(clock.clock_trusted && clock.clock_uncertainty_ms==1 && clock.clock_epoch==3);
}

static void malformed_intervals_preserve_anchor(void)
{
    cp_network_snapshot_t clock={0};
    assert(cp_network_clock_server(&clock,100,200,1792843200000ULL));
    cp_network_snapshot_t anchored=clock;
    assert(!cp_network_clock_server(&clock,201,200,1792843200000ULL));
    assert(!cp_network_clock_server(&clock,0,UINT64_MAX,1792843200000ULL));
    assert(!cp_network_clock_server(&clock,0,2ULL*(UINT32_MAX-1),1792843200000ULL));
    assert(!cp_network_clock_server(&clock,100,200,0));
    assert(!cp_network_clock_server(&clock,100,200,8640000000000001ULL));
    assert(!memcmp(&clock,&anchored,sizeof(clock)));
    assert(cp_network_clock_server(&clock,UINT64_MAX-100,UINT64_MAX,1792843200000ULL));
    assert(clock.clock_mono_ms==UINT64_MAX-50 && clock.clock_uncertainty_ms==51);
}

int main(void)
{
    bootstrap_and_authenticated_anchor();
    malformed_intervals_preserve_anchor();
    puts("network clock: SNTP bootstrap, retained HTTPS anchors, same-boot restart and bounded intervals passed");
}
