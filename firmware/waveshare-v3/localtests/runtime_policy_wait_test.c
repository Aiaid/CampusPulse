#include "runtime_policy_wait.h"
#include <assert.h>
#include <stdio.h>

typedef enum {
    CLOCK_OK, CLOCK_UNAVAILABLE, CLOCK_EPOCH, CLOCK_MONO_BACK,
    CLOCK_UTC_BACK, CLOCK_UNCERTAINTY, CLOCK_UNDERFLOW,
    CLOCK_OVERFLOW, CLOCK_UTC_RANGE, CLOCK_MONO_RANGE, CLOCK_EXPIRED
} clock_fault_t;
typedef struct {
    cp_v3_time_t time;
    unsigned attempts, waits, clocks, ready_at, fault_at;
    uint64_t request_ms, waited_ms;
    edge_policy_poll_result_t pending;
    clock_fault_t fault;
    bool stop, deny, stop_after_attempt, deny_after_attempt;
    bool stop_in_wait, deny_in_wait;
    unsigned stop_at_clock, deny_at_clock;
} fake_t;

static bool stopped(void *ctx) { return ((fake_t *)ctx)->stop; }
static bool denied(void *ctx) { return ((fake_t *)ctx)->deny; }
static bool clock_now(void *ctx, cp_v3_time_t *out) {
    fake_t *f = ctx;
    *out = f->time;
    f->clocks++;
    if (f->clocks == f->stop_at_clock) f->stop = true;
    if (f->clocks == f->deny_at_clock) f->deny = true;
    if (f->clocks != f->fault_at) return true;
    switch (f->fault) {
    case CLOCK_UNAVAILABLE: return false;
    case CLOCK_EPOCH: out->clock_epoch++; break;
    case CLOCK_MONO_BACK: out->mono_ms--; break;
    case CLOCK_UTC_BACK: out->utc_ms--; break;
    case CLOCK_UNCERTAINTY: out->uncertainty_ms = 5001; break;
    case CLOCK_UNDERFLOW: out->utc_ms = 9; break;
    case CLOCK_OVERFLOW: out->utc_ms = UINT64_MAX; break;
    case CLOCK_UTC_RANGE: out->utc_ms = UINT64_C(8640000000000001); break;
    case CLOCK_MONO_RANGE: out->mono_ms = UINT64_C(9007199254740992); break;
    case CLOCK_EXPIRED: out->utc_ms = 1900000; break;
    case CLOCK_OK: break;
    }
    return true;
}
static edge_policy_poll_result_t attempt(void *ctx) {
    fake_t *f = ctx;
    f->attempts++;
    f->time.mono_ms += f->request_ms;
    f->time.utc_ms += f->request_ms;
    if (f->stop_after_attempt) f->stop = true;
    if (f->deny_after_attempt) f->deny = true;
    return f->ready_at && f->attempts >= f->ready_at ? EDGE_POLICY_POLL_READY : f->pending;
}
static bool wait_ms(void *ctx, uint32_t delay) {
    fake_t *f = ctx;
    assert(delay == 1000);
    f->waits++;
    /* Model the production caller's 100ms cancellable delay without sleeping. */
    for (uint32_t elapsed = 0; elapsed < delay; elapsed += 100) {
        f->time.mono_ms += 100;
        f->time.utc_ms += 100;
        f->waited_ms += 100;
        if (f->stop_in_wait) f->stop = true;
        if (f->deny_in_wait) f->deny = true;
        if (f->stop || f->deny) return false;
    }
    return true;
}
static fake_t fresh(void) {
    return (fake_t){.time = {.mono_ms = 1000, .utc_ms = 100000,
        .clock_epoch = 1, .uncertainty_ms = 10}, .pending = EDGE_POLICY_POLL_WAIT};
}
static edge_policy_wait_limits_t limits(void) {
    return (edge_policy_wait_limits_t){.issued_utc_ms = 90000,
        .expires_utc_ms = 1900000, .minimum_mono_ms = 1000, .clock_epoch = 1};
}
static edge_policy_wait_result_t run(fake_t *f, edge_policy_wait_limits_t l) {
    edge_policy_wait_io_t io = {f, stopped, denied, clock_now, attempt, wait_ms};
    return edge_policy_wait_exchange(&io, &l);
}

int main(void) {
    edge_policy_wait_limits_t l = limits();
    fake_t f = fresh(); f.ready_at = 182;
    assert(run(&f, l) == EDGE_POLICY_WAIT_READY);
    assert(f.attempts == 182 && f.waits == 181 && f.waited_ms == 181000);
    assert(f.clocks == f.attempts * 2);

    /* A future activation continues returning WAIT and is not ready authority.
     * A transient transport RETRY uses the same lifetime/cancellation bounds. */
    for (unsigned retry = 0; retry < 2; retry++) {
        f = fresh(); f.ready_at = 186;
        f.pending = retry ? EDGE_POLICY_POLL_RETRY : EDGE_POLICY_POLL_WAIT;
        assert(run(&f, l) == EDGE_POLICY_WAIT_READY && f.attempts == 186 && f.waits == 185);
    }

    /* Expiry during either null-config WAIT or READY rejects that response.
     * UTC upper == expiry is already outside the half-open capability range. */
    for (unsigned ready = 0; ready < 2; ready++) {
        f = fresh(); f.ready_at = ready; f.request_ms = 100000;
        edge_policy_wait_limits_t short_l = l; short_l.expires_utc_ms = 200010;
        assert(run(&f, short_l) == EDGE_POLICY_WAIT_EXPIRED);
        assert(f.attempts == 1 && !f.waits && f.clocks == 2);
    }
    f = fresh(); l.expires_utc_ms = 100010;
    assert(run(&f, l) == EDGE_POLICY_WAIT_EXPIRED && !f.attempts);
    l = limits(); f = fresh(); l.expires_utc_ms = 101010;
    assert(run(&f, l) == EDGE_POLICY_WAIT_EXPIRED && f.attempts == 1 && f.waits == 1);

    /* Time must be fresh on both sides of every request, even READY. */
    const clock_fault_t faults[] = {CLOCK_UNAVAILABLE, CLOCK_EPOCH, CLOCK_MONO_BACK,
        CLOCK_UTC_BACK, CLOCK_UNCERTAINTY, CLOCK_UNDERFLOW, CLOCK_OVERFLOW,
        CLOCK_UTC_RANGE, CLOCK_MONO_RANGE};
    l = limits();
    for (unsigned i = 0; i < sizeof faults / sizeof *faults; i++) {
        f = fresh(); f.ready_at = 1; f.fault_at = 2; f.fault = faults[i];
        assert(run(&f, l) == EDGE_POLICY_WAIT_INVALID_TIME && f.attempts == 1 && !f.waits);
    }
    f = fresh(); f.fault_at = 1; f.fault = CLOCK_UNAVAILABLE;
    assert(run(&f, l) == EDGE_POLICY_WAIT_INVALID_TIME && !f.attempts);
    f = fresh(); f.time.utc_ms = 90009;
    assert(run(&f, l) == EDGE_POLICY_WAIT_INVALID_TIME && !f.attempts);
    f = fresh(); f.time.uncertainty_ms = 5000; f.ready_at = 1;
    assert(run(&f, l) == EDGE_POLICY_WAIT_READY);

    f = fresh(); f.stop = true;
    assert(run(&f, l) == EDGE_POLICY_WAIT_CANCELLED && !f.attempts && !f.clocks);
    f = fresh(); f.deny = true;
    assert(run(&f, l) == EDGE_POLICY_WAIT_DENIED && !f.attempts && !f.clocks);
    f = fresh(); f.ready_at = 1; f.stop_after_attempt = true;
    assert(run(&f, l) == EDGE_POLICY_WAIT_CANCELLED && f.attempts == 1 && !f.waits);
    f = fresh(); f.ready_at = 1; f.deny_after_attempt = true;
    assert(run(&f, l) == EDGE_POLICY_WAIT_DENIED && f.attempts == 1 && !f.waits);
    for (unsigned after = 0; after < 2; after++) {
        f = fresh(); f.ready_at = 1; f.stop_at_clock = after + 1;
        assert(run(&f, l) == EDGE_POLICY_WAIT_CANCELLED && f.attempts == after && !f.waits);
        f = fresh(); f.ready_at = 1; f.deny_at_clock = after + 1;
        assert(run(&f, l) == EDGE_POLICY_WAIT_DENIED && f.attempts == after && !f.waits);
    }
    /* A stop can invalidate transport time, or arrive at the exact capability
     * cutoff. On either pre/post-request clock read: stop wins over denial,
     * and denial wins over both unavailable and expired clock outcomes. */
    const clock_fault_t combined[] = {CLOCK_UNAVAILABLE, CLOCK_EXPIRED, CLOCK_EPOCH};
    for (unsigned after = 0; after < 2; after++) {
        for (unsigned i = 0; i < sizeof combined / sizeof *combined; i++) {
            for (unsigned mode = 0; mode < 3; mode++) {
                f = fresh(); f.ready_at = 1;
                f.fault_at = after + 1; f.fault = combined[i];
                if (mode != 1) f.stop_at_clock = after + 1;
                if (mode != 0) f.deny_at_clock = after + 1;
                assert(run(&f, l) == (mode == 1 ? EDGE_POLICY_WAIT_DENIED : EDGE_POLICY_WAIT_CANCELLED));
                assert(f.attempts == after && f.clocks == after + 1 && !f.waits);
            }
        }
    }
    f = fresh(); f.stop_in_wait = true;
    assert(run(&f, l) == EDGE_POLICY_WAIT_CANCELLED && f.attempts == 1 && f.waited_ms == 100);
    f = fresh(); f.deny_in_wait = true;
    assert(run(&f, l) == EDGE_POLICY_WAIT_DENIED && f.attempts == 1 && f.waited_ms == 100);

    /* Bad caller bounds/callbacks cannot produce READY or start polling. */
    f = fresh(); f.ready_at = 1; l = limits(); l.clock_epoch = 0;
    assert(run(&f, l) == EDGE_POLICY_WAIT_INVALID_ARGUMENT && !f.attempts);
    l = limits(); l.issued_utc_ms = l.expires_utc_ms;
    assert(run(&f, l) == EDGE_POLICY_WAIT_INVALID_ARGUMENT);
    l = limits(); l.expires_utc_ms = UINT64_MAX;
    assert(run(&f, l) == EDGE_POLICY_WAIT_INVALID_ARGUMENT);
    l = limits(); l.minimum_mono_ms = UINT64_MAX;
    assert(run(&f, l) == EDGE_POLICY_WAIT_INVALID_ARGUMENT);
    edge_policy_wait_io_t io = {&f, stopped, denied, clock_now, attempt, wait_ms};
    l = limits();
    assert(edge_policy_wait_exchange(NULL, &l) == EDGE_POLICY_WAIT_INVALID_ARGUMENT);
    assert(edge_policy_wait_exchange(&io, NULL) == EDGE_POLICY_WAIT_INVALID_ARGUMENT);
    io.clock = NULL;
    assert(edge_policy_wait_exchange(&io, &l) == EDGE_POLICY_WAIT_INVALID_ARGUMENT);
    f = fresh(); f.pending = (edge_policy_poll_result_t)99;
    assert(run(&f, l) == EDGE_POLICY_WAIT_INVALID_ARGUMENT && f.attempts == 1 && !f.waits);
    puts("Policy wait: delayed delivery, strict capability/time bounds, cancellation and denial passed");
    return 0;
}
