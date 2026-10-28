#pragma once
#include "page_status.h"
#include <stdbool.h>
#include <stdint.h>
#include <string.h>

/* Pure presentation admission: ordinary telemetry never bypasses the cadence.
 * Compare complete bounded fields (the adapter zero-initializes each view).
 * These counters represent new upload/durable-storage failures; high-volume
 * BLE loss counters remain ordinary telemetry so overload cannot drive FPS. */
static inline bool cp_display_urgent(const cp_status_view_t *current,
                                     const cp_status_view_t *previous)
{
    if (current->page != previous->page ||
        current->setup_active != previous->setup_active ||
        current->setup_softap != previous->setup_softap ||
        current->setup_usb != previous->setup_usb ||
        memcmp(current->authentication, previous->authentication,
               sizeof current->authentication) ||
        memcmp(current->collection, previous->collection,
               sizeof current->collection))
        return true;
    if ((current->setup_active || previous->setup_active) &&
        (memcmp(current->setup_name, previous->setup_name, sizeof current->setup_name) ||
         memcmp(current->setup_proof, previous->setup_proof, sizeof current->setup_proof) ||
         memcmp(current->setup_password, previous->setup_password, sizeof current->setup_password) ||
         memcmp(current->setup_state, previous->setup_state, sizeof current->setup_state)))
        return true;
    return current->debug.upload.failures > previous->debug.upload.failures ||
        current->debug.storage_drops > previous->debug.storage_drops ||
        current->debug.windows_dropped > previous->debug.windows_dropped ||
        current->debug.queue_quarantined > previous->debug.queue_quarantined;
}

static inline bool cp_display_should_render(const cp_status_view_t *current,
                                            const cp_status_view_t *previous,
                                            bool have_previous, uint64_t now_ms,
                                            uint64_t previous_ms, uint32_t interval_ms)
{
    if (!current) return false;
    if (!have_previous || !previous) return true;
    if (!memcmp(current, previous, sizeof *current)) return false;
    if (cp_display_urgent(current, previous)) return true;
    // A monotonic rollback must not stall a changed view until the old deadline.
    return now_ms < previous_ms || now_ms - previous_ms >= interval_ms;
}
