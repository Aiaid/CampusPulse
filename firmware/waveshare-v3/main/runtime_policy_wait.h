#pragma once
#include "cp_v3_evidence.h"
#include <stdbool.h>
#include <stdint.h>

typedef struct {
    uint64_t issued_utc_ms, expires_utc_ms, minimum_mono_ms;
    uint32_t clock_epoch;
} edge_policy_wait_limits_t;

typedef enum {
    EDGE_POLICY_POLL_WAIT, EDGE_POLICY_POLL_RETRY, EDGE_POLICY_POLL_READY
} edge_policy_poll_result_t;

typedef enum {
    EDGE_POLICY_WAIT_READY, EDGE_POLICY_WAIT_EXPIRED,
    EDGE_POLICY_WAIT_INVALID_TIME, EDGE_POLICY_WAIT_CANCELLED,
    EDGE_POLICY_WAIT_DENIED, EDGE_POLICY_WAIT_INVALID_ARGUMENT
} edge_policy_wait_result_t;

/* Waiting is not observation authority. attempt may fetch/offer a policy, but
 * must never apply it, ACK it or start capture. If offer needs a timestamp, the
 * callback obtains fresh trusted time after its request. The helper separately
 * checks time before and after every attempt, including a READY response.
 * clock reads the existing trusted map; it must not refresh/re-anchor that map.
 * wait uses the caller's cancellable delay (normally 100ms stop checks), and
 * false means cancellation. denied includes permanent authentication failures.
 * No request-count timeout: capability expiry is the hard waiting boundary. */
typedef struct {
    void *context;
    bool (*stopped)(void *);
    bool (*denied)(void *);
    bool (*clock)(void *, cp_v3_time_t *);
    edge_policy_poll_result_t (*attempt)(void *);
    bool (*wait)(void *, uint32_t);
} edge_policy_wait_io_t;

static inline edge_policy_wait_result_t edge_policy_wait_check_time(
    const edge_policy_wait_limits_t *limits, cp_v3_time_t now,
    uint64_t *last_mono_ms, uint64_t *last_lower_ms) {
    const uint64_t safe_mono = UINT64_C(9007199254740991);
    const uint64_t max_utc = UINT64_C(8640000000000000);
    if (now.clock_epoch != limits->clock_epoch || now.mono_ms > safe_mono ||
        now.mono_ms < *last_mono_ms || now.uncertainty_ms > 5000 ||
        now.utc_ms < now.uncertainty_ms || now.utc_ms > max_utc ||
        now.utc_ms > UINT64_MAX - now.uncertainty_ms)
        return EDGE_POLICY_WAIT_INVALID_TIME;
    uint64_t lower = now.utc_ms - now.uncertainty_ms;
    if (lower < limits->issued_utc_ms || lower < *last_lower_ms)
        return EDGE_POLICY_WAIT_INVALID_TIME;
    if (now.utc_ms + now.uncertainty_ms >= limits->expires_utc_ms)
        return EDGE_POLICY_WAIT_EXPIRED;
    *last_mono_ms = now.mono_ms;
    *last_lower_ms = lower;
    return EDGE_POLICY_WAIT_READY;
}

static inline edge_policy_wait_result_t edge_policy_wait_exchange(
    const edge_policy_wait_io_t *io, const edge_policy_wait_limits_t *limits) {
    if (!io || !limits || !io->stopped || !io->denied || !io->clock ||
        !io->attempt || !io->wait || !limits->clock_epoch ||
        limits->issued_utc_ms >= limits->expires_utc_ms ||
        limits->expires_utc_ms > UINT64_C(8640000000000000) ||
        limits->minimum_mono_ms > UINT64_C(9007199254740991))
        return EDGE_POLICY_WAIT_INVALID_ARGUMENT;
    uint64_t last_mono = limits->minimum_mono_ms;
    uint64_t last_lower = limits->issued_utc_ms;
    for (;;) {
        if (io->stopped(io->context)) return EDGE_POLICY_WAIT_CANCELLED;
        if (io->denied(io->context)) return EDGE_POLICY_WAIT_DENIED;
        cp_v3_time_t now;
        bool clock_valid = io->clock(io->context, &now);
        /* Cancellation may itself invalidate transport time. Preserve owner
         * stop, then permanent denial, before interpreting clock failure or
         * expiry observed by that same read. */
        if (io->stopped(io->context)) return EDGE_POLICY_WAIT_CANCELLED;
        if (io->denied(io->context)) return EDGE_POLICY_WAIT_DENIED;
        if (!clock_valid) return EDGE_POLICY_WAIT_INVALID_TIME;
        edge_policy_wait_result_t checked = edge_policy_wait_check_time(
            limits, now, &last_mono, &last_lower);
        if (checked != EDGE_POLICY_WAIT_READY) return checked;
        if (io->stopped(io->context)) return EDGE_POLICY_WAIT_CANCELLED;
        if (io->denied(io->context)) return EDGE_POLICY_WAIT_DENIED;
        edge_policy_poll_result_t result = io->attempt(io->context);
        if (io->stopped(io->context)) return EDGE_POLICY_WAIT_CANCELLED;
        if (io->denied(io->context)) return EDGE_POLICY_WAIT_DENIED;
        clock_valid = io->clock(io->context, &now);
        if (io->stopped(io->context)) return EDGE_POLICY_WAIT_CANCELLED;
        if (io->denied(io->context)) return EDGE_POLICY_WAIT_DENIED;
        if (!clock_valid) return EDGE_POLICY_WAIT_INVALID_TIME;
        checked = edge_policy_wait_check_time(limits, now, &last_mono, &last_lower);
        if (checked != EDGE_POLICY_WAIT_READY) return checked;
        if (io->stopped(io->context)) return EDGE_POLICY_WAIT_CANCELLED;
        if (io->denied(io->context)) return EDGE_POLICY_WAIT_DENIED;
        if (result == EDGE_POLICY_POLL_READY) return EDGE_POLICY_WAIT_READY;
        if (result != EDGE_POLICY_POLL_WAIT && result != EDGE_POLICY_POLL_RETRY)
            return EDGE_POLICY_WAIT_INVALID_ARGUMENT;
        if (!io->wait(io->context, 1000)) {
            if (io->denied(io->context) && !io->stopped(io->context))
                return EDGE_POLICY_WAIT_DENIED;
            return EDGE_POLICY_WAIT_CANCELLED;
        }
    }
}
