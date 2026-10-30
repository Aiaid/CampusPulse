#pragma once

#include "cp_usb_frame.h"
#include "raw_control.h"

/* Pure, allocation-free routing for one USB reader. It does not install a USB
 * driver or start provisioning. A supervisor must provide the setup callback
 * (normally calling cp_usb_control) only after its lifecycle is implemented.
 * Callbacks borrow parser storage until return and must not reenter the stream.
 * No bytes from an RS-prefixed setup line can reach the RAW command parser,
 * including malformed/overflow setup input. Clear on disconnect or timeout. */
typedef void (*raw_usb_command_fn)(void *context, raw_command_t command,
                                   const raw_control_t *parameters);
typedef struct {
    raw_control_t raw;
    cp_usb_frame_parser_t setup;
    bool setup_line;
} raw_usb_stream_t;

void raw_usb_stream_init(raw_usb_stream_t *stream);
void raw_usb_stream_clear(raw_usb_stream_t *stream);
void raw_usb_stream_feed(raw_usb_stream_t *stream, const void *bytes, size_t length,
                         raw_usb_command_fn command, cp_usb_frame_fn setup,
                         void *context);
