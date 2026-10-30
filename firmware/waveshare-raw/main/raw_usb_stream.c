#include "raw_usb_stream.h"
#include <string.h>

typedef struct {
    cp_usb_frame_fn receive;
    void *context;
} setup_target_t;

static void receive_setup(void *context, const char request_id[CP_USB_UUID_SIZE],
                          const uint8_t *json, size_t length) {
    setup_target_t *target = context;
    if (target->receive) target->receive(target->context, request_id, json, length);
}

void raw_usb_stream_init(raw_usb_stream_t *stream) {
    if (stream) memset(stream, 0, sizeof *stream);
}

void raw_usb_stream_clear(raw_usb_stream_t *stream) {
    if (!stream) return;
    cp_usb_frame_clear(&stream->setup);
    cp_usb_secure_clear(&stream->raw, sizeof stream->raw);
    stream->setup_line = false;
}

void raw_usb_stream_feed(raw_usb_stream_t *stream, const void *bytes, size_t length,
                         raw_usb_command_fn command, cp_usb_frame_fn setup,
                         void *context) {
    if (!stream || (!bytes && length)) return;
    const uint8_t *input = bytes;
    setup_target_t target = {.receive = setup, .context = context};
    for (size_t i = 0; i < length; i++) {
        uint8_t ch = input[i];
        if (ch == 0x1e) {
            cp_usb_secure_clear(&stream->raw, sizeof stream->raw);
            stream->setup_line = true;
        }
        if (stream->setup_line) {
            cp_usb_frame_feed(&stream->setup, &ch, 1, receive_setup, &target);
            if (ch == '\n') {
                /* Framing failures can clear its parser before the line ends.
                 * Keep the entire rejected line quarantined regardless. */
                cp_usb_frame_clear(&stream->setup);
                stream->setup_line = false;
            }
        } else {
            raw_command_t parsed = raw_control_command(&stream->raw, ch);
            if (parsed != RAW_COMMAND_NONE && command)
                command(context, parsed, &stream->raw);
        }
    }
}
