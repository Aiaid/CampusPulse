#pragma once
#include <stdbool.h>
#include <stdint.h>
#include "esp_err.h"

typedef struct {
    bool known;
    uint16_t millivolts;
    /* Coarse 3.0–4.2V linear voltage estimate, not a calibrated state of charge.
     * USB/charging/load can bias it. Battery presence and power source are unknown.
     * Never use this value to estimate remaining runtime or to power off. */
    uint8_t estimated_percent;
} raw_battery_sample_t;

/* Sole display task owns initialization and reads; no radio callback use. */
esp_err_t raw_battery_init(void);
esp_err_t raw_battery_read(raw_battery_sample_t *out);
