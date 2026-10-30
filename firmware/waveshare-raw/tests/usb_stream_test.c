#include "raw_usb_stream.h"
#include <assert.h>
#include <string.h>

static const char id[] = "12345678-1234-4123-8123-123456789abc";
typedef struct { unsigned commands, setups; raw_command_t last; uint64_t epoch; } result_t;

static void command(void *context, raw_command_t value, const raw_control_t *p) {
    result_t *r = context;
    r->commands++; r->last = value; r->epoch = p->utc_epoch;
}
static void setup(void *context, const char *request_id, const uint8_t *json, size_t length) {
    result_t *r = context;
    assert(!strcmp(request_id, id));
    assert(length == 7 && !memcmp(json, "{\"v\":1}", 7));
    r->setups++;
}
static void feed(raw_usb_stream_t *s, result_t *r, const char *text) {
    raw_usb_stream_feed(s, text, strlen(text), command, setup, r);
}
static void assert_empty(const void *bytes, size_t length) {
    const unsigned char *p = bytes;
    for (size_t i = 0; i < length; i++) assert(!p[i]);
}
int main(void) {
    raw_usb_stream_t s;
    result_t r = {0};
    raw_usb_stream_init(&s);
    feed(&s, &r, "TIME 1760000000\r\n");
    assert(r.commands == 1 && r.last == RAW_COMMAND_TIME && r.epoch == 1760000000);
    uint8_t frame[CP_USB_FRAME_MAX]; size_t length;
    assert(cp_usb_frame_encode(id, (const uint8_t *)"{\"v\":1}", 7, frame, sizeof frame, &length));
    /* Every boundary can split a USB frame; raw partial commands are discarded. */
    for (size_t split = 0; split <= length; split++) {
        raw_usb_stream_clear(&s);
        feed(&s, &r, "ST");
        raw_usb_stream_feed(&s, frame, split, command, setup, &r);
        raw_usb_stream_feed(&s, frame + split, length - split, command, setup, &r);
        feed(&s, &r, "OP\n");
    }
    assert(r.setups == length + 1 && r.commands == 1);
    assert_empty(s.setup.json, sizeof s.setup.json);
    assert_empty(s.setup.request_id, sizeof s.setup.request_id);
    feed(&s, &r, "FILES\nREAD 1 512\nCLOSE\nCLOCK\nPAGE\nSTOP\n");
    assert(r.commands == 7 && r.last == RAW_COMMAND_STOP);
    /* Failed prefix/UUID, CR, overflow, and parser resynchronization must not
     * expose payload suffixes as RAW control commands. */
    feed(&s, &r, "\x1e" "BAD\rSTOP\n");
    feed(&s, &r, "\x1e" "CPSETUP/1 invalid STOP\rTIME 1\n");
    feed(&s, &r, "\x1e" "CPSETUP/1 12345678-1234-4123-8123-123456789abc x\rSTOP\n");
    feed(&s, &r, "\x1e" "CPSETUP/1 12345678-1234-4123-8123-123456789abc ");
    for (unsigned i = 0; i <= CP_USB_JSON_MAX; i++) feed(&s, &r, "x");
    feed(&s, &r, "\rSTOP\n");
    assert(r.commands == 7 && !s.setup_line);
    feed(&s, &r, "\x1e" "broken");
    raw_usb_stream_feed(&s, frame, length, command, setup, &r);
    assert(r.setups == length + 2);
    feed(&s, &r, "\x1e" "CPSETUP/1 12345678-1234-4123-8123-123456789abc private");
    raw_usb_stream_clear(&s); /* Disconnect/timeout erases credential fragments. */
    assert_empty(&s.raw, sizeof s.raw);
    assert_empty(s.setup.json, sizeof s.setup.json);
    assert_empty(s.setup.request_id, sizeof s.setup.request_id);
    feed(&s, &r, "STOP\n");
    assert(r.commands == 8);
    /* An absent setup consumer is an explicit dormant service, never RAW. */
    raw_usb_stream_feed(&s, frame, length, command, NULL, &r);
    assert(r.commands == 8 && r.setups == length + 2);
    raw_usb_stream_feed(NULL, NULL, 0, NULL, NULL, NULL);
    raw_usb_stream_feed(&s, NULL, 1, NULL, NULL, NULL);
    raw_usb_stream_clear(NULL);
    return 0;
}
