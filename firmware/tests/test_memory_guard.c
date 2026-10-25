#include "cp_memory_guard.h"
#include <assert.h>
#include <stdio.h>

static void sample(cp_memory_guard_t *g, uint64_t at, unsigned free, unsigned largest,
                    bool busy, bool collecting) {
    cp_memory_guard_observe(g, at, free * 1024, largest * 1024, busy, collecting);
}
static void transient_and_sustained(void) {
    cp_memory_guard_t g = {0};
    assert(cp_memory_guard_start_allowed(&g, 0, 70 * 1024, 40 * 1024, false));
    sample(&g, 0, 30, 17, false, true);
    sample(&g, 1999, 30, 17, false, true);
    assert(!g.raw_paused && !g.scan_paused);
    sample(&g, 2000, 30, 17, false, true);
    assert(g.raw_paused && !g.scan_paused);
    /* Total free RAM cannot compensate for fragmentation. */
    sample(&g, 3000, 70, 15, false, true);
    sample(&g, 7999, 70, 15, false, true);
    assert(!g.scan_paused);
    sample(&g, 8000, 70, 15, false, true);
    assert(g.scan_paused && g.raw_paused && !g.restart_ready);
    sample(&g, 9000, 70, 40, false, false);
    sample(&g, 19000, 70, 40, false, false);
    assert(!g.restart_ready); /* Ten healthy seconds alone cannot defeat cooldown. */
    sample(&g, 37999, 70, 40, false, false);
    assert(!g.restart_ready);
    sample(&g, 38000, 70, 40, false, false);
    assert(g.restart_ready && cp_memory_guard_start_allowed(&g, 38000, 70*1024, 40*1024, false));
    cp_memory_guard_started(&g);
    assert(!g.scan_paused && !g.raw_paused && !g.restart_ready);
}
static void http_and_hysteresis(void) {
    cp_memory_guard_t g = {0};
    sample(&g, 0, 10, 8, false, true);
    sample(&g, 4000, 10, 8, true, true);
    sample(&g, 15000, 10, 8, true, true);
    assert(!g.scan_paused && !g.raw_paused);
    sample(&g, 16000, 30, 17, false, true);
    sample(&g, 18000, 30, 17, false, true);
    assert(g.raw_paused && !g.scan_paused);
    sample(&g, 20000, 34, 19, false, true);
    sample(&g, 40000, 34, 19, false, true);
    assert(g.raw_paused); /* Between warning and recovery: no flapping. */
    sample(&g, 41000, 40, 24, false, true);
    sample(&g, 50000, 40, 24, false, true);
    assert(g.raw_paused);
    sample(&g, 51000, 40, 24, false, true);
    assert(!g.raw_paused);
    sample(&g, 52000, 23, 24, false, true);
    sample(&g, 57000, 23, 24, false, true);
    assert(g.scan_paused); /* Total-free pressure also stops despite a good block. */
    sample(&g, 60000, 70, 40, false, false);
    sample(&g, 90000, 70, 40, true, false);
    assert(!g.restart_ready);
    sample(&g, 91000, 70, 40, false, false);
    sample(&g, 100999, 70, 40, false, false);
    assert(!g.restart_ready);
    sample(&g, 101000, 70, 40, false, false);
    assert(g.restart_ready);
}
static void startup_and_unsafe_retry(void) {
    cp_memory_guard_t g = {0};
    assert(!cp_memory_guard_start_allowed(&g, 0, 70*1024, 40*1024, true));
    assert(!g.scan_paused); /* Normal HTTP is a deferral, not a memory failure. */
    assert(!cp_memory_guard_start_allowed(&g, 1, 51*1024, 25*1024, false));
    assert(g.scan_paused);
    sample(&g, 30001, 70, 40, false, false);
    sample(&g, 40001, 70, 40, false, false);
    assert(cp_memory_guard_start_allowed(&g, 40001, 70*1024, 40*1024, false));
    cp_memory_guard_init_failed(&g);
    assert(!cp_memory_guard_start_allowed(&g, 999999, 200*1024, 100*1024, false));
    cp_memory_guard_started(&g);
    assert(g.init_fault && !cp_memory_guard_start_allowed(&g, 999999, 200*1024, 100*1024, false));
}
static void recovery_rechecks(void) {
    cp_memory_guard_t g = {0};
    cp_memory_guard_pause(&g, 1); /* A completed network OOM forces a pause. */
    sample(&g, 1000, 70, 40, false, false);
    sample(&g, 31001, 70, 40, false, false);
    assert(g.restart_ready);
    assert(!cp_memory_guard_start_allowed(&g, 31002, 70*1024, 23*1024, false));
    assert(!g.restart_ready);
    sample(&g, 32000, 70, 40, false, false);
    sample(&g, 42000, 70, 40, false, true);
    assert(!g.restart_ready); /* A failed stop cannot be treated as recovered. */
}
static void start_boundaries(void) {
    cp_memory_guard_t g = {0};
    assert(CP_MEMORY_START_FREE == 56u*1024u && CP_MEMORY_START_LARGEST == 24u*1024u);
    assert(cp_memory_guard_start_allowed(&g, 0, 56*1024, 24*1024, false));
    assert(!cp_memory_guard_start_allowed(&g, 1, 56*1024, 24*1024-1, false));
    sample(&g, 2, 56, 24, false, false);
    sample(&g, 30001, 56, 24, false, false);
    assert(g.restart_ready);
    assert(cp_memory_guard_start_allowed(&g, 30001, 56*1024, 24*1024, false));
    cp_memory_guard_started(&g);
    assert(!cp_memory_guard_start_allowed(&g, 30002, 56*1024-1, 24*1024, false));
    assert(g.scan_paused);
}
int main(void) {
    transient_and_sustained();
    http_and_hysteresis();
    startup_and_unsafe_retry();
    recovery_rechecks();
    start_boundaries();
    puts("memory guard: sustained pressure, TLS exclusion, hysteresis, cooldown and init latch passed");
}
