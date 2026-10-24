#ifndef CP_USB_FRAME_H
#define CP_USB_FRAME_H
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#define CP_USB_JSON_MAX 1024u
#define CP_USB_UUID_SIZE 37u
#define CP_USB_PREFIX "\x1e" "CPSETUP/1 "
#define CP_USB_FRAME_MAX ((sizeof(CP_USB_PREFIX)-1u)+36u+1u+CP_USB_JSON_MAX+1u)
typedef void (*cp_usb_frame_fn)(void *context,const char request_id[CP_USB_UUID_SIZE],
                               const uint8_t *json,size_t length);
typedef struct {
    uint8_t state, prefix_used, id_used;
    size_t json_used;
    char request_id[CP_USB_UUID_SIZE];
    uint8_t json[CP_USB_JSON_MAX+1u];
    uint32_t malformed_frames, completed_frames;
} cp_usb_frame_parser_t;
/* No allocation, device IO, JSON interpretation or logging. A new RS restarts
 * framing even inside malformed/overflow input. Callback borrows bytes only
 * until return; credential-bearing buffers are cleared before reuse. */
void cp_usb_frame_init(cp_usb_frame_parser_t *parser);
void cp_usb_frame_feed(cp_usb_frame_parser_t *parser,const void *bytes,size_t length,
                       cp_usb_frame_fn receive,void *context);
void cp_usb_frame_clear(cp_usb_frame_parser_t *parser);
bool cp_usb_uuid_v4(const char *text);
bool cp_usb_utf8_valid(const uint8_t *bytes,size_t length);
/* One complete bounded frame for a single transport write; never truncates. */
bool cp_usb_frame_encode(const char *request_id,const uint8_t *json,size_t length,
                         uint8_t *out,size_t capacity,size_t *written);
void cp_usb_secure_clear(void *memory,size_t length);
#endif
