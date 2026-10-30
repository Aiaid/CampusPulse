#pragma once
#include <stdbool.h>
#include <stdint.h>

typedef enum { RAW_BOOT_NONE, RAW_BOOT_PAGE, RAW_BOOT_SETUP } raw_boot_action_t;
typedef struct {
    uint64_t down_ms;
    unsigned down_samples, up_samples;
    bool held;
} raw_boot_button_t;

/* Poll from the existing key task. Debounce both edges, fire short press only
 * on release, and emit one setup request after 2s when the capability exists. */
raw_boot_action_t raw_boot_button_poll(raw_boot_button_t *, bool pressed,
                                      uint64_t now_ms, bool setup_available);
