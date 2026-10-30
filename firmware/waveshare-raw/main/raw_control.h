#pragma once
#include <stdbool.h>
#include <stdint.h>

/* Fixed-size, allocation-free parser. One instance per input stream.
 * Parameters are valid when a command is returned, until the next line starts. */
typedef struct {
    uint8_t length;
    bool overflow;
    char line[64];
    uint32_t file_index, file_offset;
    uint64_t utc_epoch;
} raw_control_t;

void raw_control_init(raw_control_t *control);
typedef enum {
    RAW_COMMAND_NONE, RAW_COMMAND_STOP, RAW_COMMAND_PAGE,
    RAW_COMMAND_FILES, RAW_COMMAND_READ, RAW_COMMAND_CLOSE, RAW_COMMAND_TIME, RAW_COMMAND_CLOCK
} raw_command_t;
raw_command_t raw_control_command(raw_control_t *control, uint8_t ch);
/* Returns true only on the terminator of an exact STOP line. */
bool raw_control_feed(raw_control_t *control, uint8_t ch);
