#pragma once

#include <stdbool.h>
#include "esp_err.h"

/* Call before display, TF, BLE, or any slow startup work. */
esp_err_t raw_power_init(void);
bool raw_power_pressed(void);
bool raw_boot_pressed(void);
/* Caller must stop capture, drain/close/sync/unmount TF, finish display work,
 * and wait for PWR release. Success never returns: battery power is released;
 * USB still feeds VSYS, so the MCU sleeps until PWR. RTC is left running.
 * Any preparation failure returns with GPIO17 still held high. */
esp_err_t raw_power_shutdown(void);
