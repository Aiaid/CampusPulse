#pragma once
#include "cp_v3_evidence.h"
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define CP_V3_CLOCK_SPKI_BYTES 91u
#define CP_V3_CLOCK_RESPONSE_MAX 1024u
#define CP_V3_CLOCK_RTT_MAX_MS 6000u
#define CP_V3_CLOCK_UNCERTAINTY_MAX_MS 4000u

/* Implementations verify SHA-256/ECDSA P-256 over transcript with the pinned
 * SPKI key and raw IEEE-P1363 (r||s) signature. No key is accepted from JSON. */
typedef bool (*cp_v3_clock_verify_fn)(void *, const uint8_t spki[91],
    const uint8_t signature[64], const void *transcript, size_t bytes);

/* Exact single-response, single-fresh-nonce verification. The caller generates
 * 32 random bytes before request_start, never reuses a nonce, and
 * consumes it after this attempt whether successful or not. Mono timestamps
 * must bound nonce body transmission through complete response, including all
 * network/server delay. Prior DNS/TLS/nonce-free headers may be excluded. Output is zero
 * on any failure. A successful result is a clock anchor, never policy authority.
 * Server max_error_ms is a signed operator assumption, not a measured guarantee. */
bool cp_v3_clock_verify(const char *response, size_t bytes,
    const uint8_t pinned_spki[91], const char *key_id, const char nonce[65],
    uint64_t request_start_mono, uint64_t response_end_mono, uint32_t clock_epoch,
    cp_v3_clock_verify_fn verify, void *context, cp_v3_time_t *out);
