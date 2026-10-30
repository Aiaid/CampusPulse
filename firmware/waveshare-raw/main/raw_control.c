#include "raw_control.h"
#include <limits.h>
#include <stddef.h>
#include <string.h>

void raw_control_init(raw_control_t *control) {
    if (control) memset(control, 0, sizeof(*control));
}

/* Parse an entire nonempty decimal field and reject overflow before arithmetic. */
static bool decimal(const char *s, size_t len, uint64_t max, uint64_t *out) {
    if (!len) return false;
    uint64_t value = 0;
    for (size_t i = 0; i < len; ++i) {
        unsigned char c = (unsigned char)s[i];
        if (c < '0' || c > '9') return false;
        unsigned digit = c - '0';
        if (value > (max - digit) / 10) return false;
        value = value * 10 + digit;
    }
    *out = value;
    return true;
}

static raw_command_t parse_line(raw_control_t *control) {
    const char *s = control->line;
    size_t n = control->length;
    if (n == 4 && !memcmp(s, "STOP", 4)) return RAW_COMMAND_STOP;
    if (n == 4 && !memcmp(s, "PAGE", 4)) return RAW_COMMAND_PAGE;
    if (n == 5 && !memcmp(s, "FILES", 5)) return RAW_COMMAND_FILES;
    if (n == 5 && !memcmp(s, "CLOSE", 5)) return RAW_COMMAND_CLOSE;
    if (n == 5 && !memcmp(s, "CLOCK", 5)) return RAW_COMMAND_CLOCK;
    if (n > 5 && !memcmp(s, "TIME ", 5)) {
        uint64_t epoch;
        if (decimal(s + 5, n - 5, UINT64_MAX, &epoch)) {
            control->utc_epoch = epoch;
            return RAW_COMMAND_TIME;
        }
    }
    if (n > 5 && !memcmp(s, "READ ", 5)) {
        size_t split = 5;
        while (split < n && s[split] != ' ') ++split;
        uint64_t index, offset;
        if (split < n && decimal(s + 5, split - 5, UINT32_MAX, &index) &&
            decimal(s + split + 1, n - split - 1, UINT32_MAX, &offset)) {
            control->file_index = (uint32_t)index;
            control->file_offset = (uint32_t)offset;
            return RAW_COMMAND_READ;
        }
    }
    return RAW_COMMAND_NONE;
}

raw_command_t raw_control_command(raw_control_t *control, uint8_t ch) {
    if (!control) return RAW_COMMAND_NONE;
    if (ch == '\r' || ch == '\n') {
        raw_command_t command = control->overflow ? RAW_COMMAND_NONE : parse_line(control);
        control->length = 0;
        control->overflow = false;
        return command;
    }
    if (!control->length && !control->overflow) {
        control->file_index = 0;
        control->file_offset = 0;
        control->utc_epoch = 0;
    }
    if (!control->overflow) {
        if (control->length < sizeof(control->line))
            control->line[control->length++] = (char)ch;
        else
            control->overflow = true;
    }
    return RAW_COMMAND_NONE;
}

bool raw_control_feed(raw_control_t *control, uint8_t ch) {
    return raw_control_command(control, ch) == RAW_COMMAND_STOP;
}
