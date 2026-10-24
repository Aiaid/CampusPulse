#ifndef CP_USB_H
#define CP_USB_H
#include "cp_usb_frame.h"
#include "esp_err.h"
typedef bool (*cp_usb_begin_fn)(void *context);
typedef esp_err_t (*cp_usb_exchange_fn)(const uint8_t *request,size_t request_length,
                                      uint8_t **response,size_t *response_length);
/* Pure controller: begin only queues a mode change; other valid v1 requests use
 * the shared provisioning endpoint. Output never contains request fragments. */
esp_err_t cp_usb_control(cp_usb_begin_fn begin,void *context,cp_usb_exchange_fn exchange,
    const uint8_t *request,size_t request_length,uint8_t *out,size_t capacity,size_t *length);
/* ESP backend owns a single USB Serial/JTAG reader and bounded whole-frame TX.
 * Starting the task/cable connection does not begin a provisioning session. */
esp_err_t cp_usb_start(cp_usb_begin_fn begin,void *context);
#endif
