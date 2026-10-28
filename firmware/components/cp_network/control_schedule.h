#pragma once
#include <stdbool.h>
#include <stdint.h>

/* One bounded operation per memory-gate claim. Desired policy takes priority
 * over recurring contact once authenticated, including the first boot fetch. */
typedef enum { CP_CONTROL_NONE, CP_CONTROL_CONTACT, CP_CONTROL_POLICY,
               CP_CONTROL_ACTIVATION } cp_control_operation_t;
#define CP_CONTROL_HANDOFF_MS 500u
static inline cp_control_operation_t cp_control_next(uint64_t now, bool registered,
    bool candidate, bool activation_pending, uint64_t contact_at,
    uint64_t policy_at, uint64_t activation_at)
{
    if (registered && !candidate && now>=policy_at) return CP_CONTROL_POLICY;
    if (now>=contact_at) return CP_CONTROL_CONTACT;
    if (registered && !candidate && activation_pending && now>=activation_at)
        return CP_CONTROL_ACTIVATION;
    return CP_CONTROL_NONE;
}
