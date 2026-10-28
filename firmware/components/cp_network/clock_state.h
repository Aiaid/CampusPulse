#ifndef CP_NETWORK_CLOCK_STATE_H
#define CP_NETWORK_CLOCK_STATE_H
#include "cp_network.h"

/* SNTP initializes the system clock for certificate-date validation. Once a
 * same-boot HTTPS server-time estimate exists, periodic SNTP notifications must
 * not replace its monotonic anchor or discard its recorded uncertainty. */
static inline void cp_network_clock_sntp(cp_network_snapshot_t *snapshot,
    uint64_t mono_ms, uint64_t utc_ms)
{
    if (snapshot->clock_estimated) return;
    snapshot->clock_trusted=false;
    snapshot->clock_mono_ms=mono_ms;
    snapshot->clock_utc_ms=utc_ms;
    ++snapshot->clock_epoch;
    snapshot->clock_uncertainty_ms=UINT32_MAX;
}

/* The server timestamp was sampled somewhere in this authenticated request.
 * Midpoint +/- ceil(elapsed/2) covers that unknown position; 1 ms accounts for
 * timestamp quantization. This is a network timing estimate, not a bound on the
 * server's absolute clock error. The codec separately grows drift with age. */
static inline bool cp_network_clock_server(cp_network_snapshot_t *snapshot,
    uint64_t started_ms, uint64_t ended_ms, uint64_t utc_ms)
{
    if (ended_ms<started_ms || !utc_ms || utc_ms>8640000000000000ULL) return false;
    uint64_t elapsed=ended_ms-started_ms;
    uint64_t uncertainty=elapsed/2+elapsed%2+1;
    if (uncertainty>=UINT32_MAX) return false;
    snapshot->clock_mono_ms=started_ms+elapsed/2;
    snapshot->clock_utc_ms=utc_ms;
    ++snapshot->clock_epoch;
    snapshot->clock_uncertainty_ms=(uint32_t)uncertainty;
    snapshot->clock_estimated=true;
    snapshot->clock_trusted=true;
    return true;
}
#endif
