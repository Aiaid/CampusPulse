#pragma once
#include "esp_err.h"
#include "freertos/FreeRTOS.h"
#include <stdbool.h>
#include <stddef.h>
typedef struct {uint32_t tx_buffer_size,rx_buffer_size;} usb_serial_jtag_driver_config_t;
esp_err_t usb_serial_jtag_driver_install(usb_serial_jtag_driver_config_t*);
esp_err_t usb_serial_jtag_driver_uninstall(void);
bool usb_serial_jtag_is_driver_installed(void);
bool usb_serial_jtag_is_connected(void);
int usb_serial_jtag_read_bytes(void*,uint32_t,TickType_t);
int usb_serial_jtag_write_bytes(const void*,size_t,TickType_t);
esp_err_t usb_serial_jtag_wait_tx_done(TickType_t);
