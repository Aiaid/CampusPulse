#include "board_runtime.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

typedef struct {
    te_runtime_phase_t log[128], fail;
    unsigned n, pauses, recovery, windows;
    bool fail_enabled, pause_ok;
    te_runtime_result_t forced;
} fixture;
static te_runtime_result_t perform(void *v, te_runtime_phase_t p) {
    fixture *f=v; assert(f->n < 128); f->log[f->n++]=p;
    if (f->fail_enabled && p==f->fail) return f->forced;
    if (p==TE_RT_RECOVER) return f->recovery-- ? TE_RT_OK : (f->recovery=0, TE_RT_EMPTY);
    if (p==TE_RT_PEEK) return f->windows-- ? TE_RT_OK : (f->windows=0, TE_RT_EMPTY);
    return TE_RT_OK;
}
static bool pause_capture(void *v) { fixture *f=v; ++f->pauses; return f->pause_ok; }
static void tick(te_runtime_t *r, te_runtime_ops_t *o, unsigned n) {
    while (n--) assert(te_runtime_step(r,o)!=TE_RT_STOPPED);
}
static void test_order(void) {
    fixture f={.recovery=2,.windows=1,.pause_ok=true}; te_runtime_t r={0};
    te_runtime_ops_t o={perform,pause_capture,&f};
    const te_runtime_phase_t expected[]={TE_RT_CONNECT,TE_RT_REGISTER,TE_RT_VALIDATE,
        TE_RT_RECOVER,TE_RT_RECOVER,TE_RT_RECOVER,TE_RT_ACK_FREEZE,TE_RT_ACK_STORE,
        TE_RT_ACK_SEND,TE_RT_LEASE,TE_RT_START,TE_RT_MONITOR,TE_RT_PEEK,
        TE_RT_MONITOR,TE_RT_FREEZE,TE_RT_MONITOR,TE_RT_STORE,TE_RT_MONITOR,
        TE_RT_RELEASE,TE_RT_MONITOR,TE_RT_SEND,TE_RT_MONITOR,TE_RT_PEEK};
    tick(&r,&o,sizeof expected/sizeof *expected);
    assert(f.n==sizeof expected/sizeof *expected);
    assert(!memcmp(f.log,expected,sizeof expected)); assert(f.pauses==0);
}
static void test_each_failure(void) {
    for (int p=TE_RT_CONNECT;p<=TE_RT_SEND;++p) {
        fixture f={.windows=1,.fail_enabled=true,.fail=(te_runtime_phase_t)p,
                   .forced=TE_RT_FAIL,.pause_ok=true};
        te_runtime_t r={0}; te_runtime_ops_t o={perform,pause_capture,&f};
        unsigned limit=100;
        while (r.phase!=TE_RT_HALTED && limit--) te_runtime_step(&r,&o);
        assert(limit && r.failed_phase==(te_runtime_phase_t)p && !r.active && r.pause_confirmed && f.pauses==1);
        unsigned calls=f.n;
        assert(te_runtime_step(&r,&o)==TE_RT_STOPPED && f.n==calls && f.pauses==1);
    }
}
static void test_invalid_and_ambiguous(void) {
    fixture f={.fail_enabled=true,.fail=TE_RT_ACK_SEND,.forced=TE_RT_EMPTY,.pause_ok=false};
    te_runtime_t r={0}; te_runtime_ops_t o={perform,pause_capture,&f};
    while (r.phase!=TE_RT_HALTED) te_runtime_step(&r,&o);
    assert(r.failed_phase==TE_RT_ACK_SEND && !r.pause_confirmed);
    assert(te_runtime_step(NULL,&o)==TE_RT_INVALID);
    te_runtime_t busy={.busy=true}; assert(te_runtime_step(&busy,&o)==TE_RT_INVALID);
    te_runtime_ops_t bad={0}; assert(te_runtime_step(&r,&bad)==TE_RT_INVALID);
}
int main(void) { test_order(); test_each_failure(); test_invalid_and_ambiguous(); puts("board runtime ordering tests passed"); }
