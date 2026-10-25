#pragma once
#include "protocomm_security.h"
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#define CP_PROVISION_USERNAME "campuspulse"
/* Nonblocking shared-session gate. enter succeeds with a short-lived mutex;
 * leave releases it. SDK SRP arithmetic is the only expensive work inside. */
typedef struct {
    bool (*enter)(void);
    void (*leave)(void);
    void (*failure)(void);
    void (*fatal)(void);
} cp_provision_security_hooks_t;
const protocomm_security_t *cp_provision_security2(const cp_provision_security_hooks_t *hooks);
/* Strict bounded preflight before the pinned SDK dereferences protobuf oneofs. */
bool cp_provision_sec2_frame(const uint8_t *data, size_t length, unsigned *command);

/* RFC5054 verifier using fixed-width salt and standard mbedTLS primitives.
 * Avoids the SDK development helper's minimal-MPI salt-length mismatch. */
bool cp_provision_sec2_verifier(const char pin[9], const uint8_t salt[16], uint8_t verifier[384]);
