#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include "cp_settings.h"

/* Destination selection only; the transport still validates origin and TLS.
 * Never extend an isolated/alias origin's timeout by substring matching. */
static inline uint32_t edge_request_timeout_ms(const char *origin) {
    return origin && !strcmp(origin,CP_API_ORIGIN) ? 30000u : 15000u;
}

/* Startup only: preserve the caller's one frozen registration body. Every
 * attempt still passes through the ordinary charged, strict-TLS request path.
 * At most three attempts retain the selected request deadline, with1s/2s
 * backoff. SDK socket select may overrun that deadline; this is not a hard wall
 * guarantee. No new policy, capability, boot, sequence or uptime is generated. */
typedef struct {
    void *context;
    bool (*stopped)(void *);
    bool (*attempt)(void *, const void *, size_t, unsigned, bool *retryable);
    bool (*wait)(void *, uint32_t);
} edge_registration_io_t;

static inline bool edge_registration_exchange(const edge_registration_io_t *io,
                                               const void *body, size_t bytes) {
    if (!io || !io->stopped || !io->attempt || !io->wait || !body || !bytes) return false;
    for (unsigned attempt=0; attempt<3; ++attempt) {
        if (io->stopped(io->context)) return false;
        bool retryable=false;
        if (io->attempt(io->context,body,bytes,attempt,&retryable)) return true;
        if (!retryable || attempt==2 || io->stopped(io->context)) return false;
        if (!io->wait(io->context,(attempt+1)*1000u)) return false;
    }
    return false;
}
