#include "raw_boot_button.h"
#include <string.h>

raw_boot_action_t raw_boot_button_poll(raw_boot_button_t *button, bool pressed,
                                      uint64_t now, bool setup_available) {
    if (!button) return RAW_BOOT_NONE;
    if (pressed) {
        button->up_samples = 0;
        if (!button->down_samples) button->down_ms = now;
        if (button->down_samples < 3) ++button->down_samples;
        if (setup_available && button->down_samples >= 3 && !button->held &&
            now >= button->down_ms && now - button->down_ms >= 2000) {
            button->held = true;
            return RAW_BOOT_SETUP;
        }
    } else if (button->down_samples) {
        if (++button->up_samples >= 3) {
            bool page = button->down_samples >= 3 && !button->held;
            memset(button, 0, sizeof *button);
            if (page) return RAW_BOOT_PAGE;
        }
    }
    return RAW_BOOT_NONE;
}
