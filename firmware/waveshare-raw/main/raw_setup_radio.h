#pragma once
#include "esp_err.h"
#include <stdbool.h>
#include <stdint.h>

/* Snapshot under the recorder lifecycle lock. USB setup requires an idle radio,
 * not destruction of the observer-only NimBLE host. Storage safety and drained
 * callbacks are independent admission conditions. This module has no radio I/O. */
typedef struct {
    bool writer_done, storage_safe, stop_requested;
    bool accepting_reports, scanning, power_requested;
    uint32_t callbacks;
} raw_setup_radio_state_t;

esp_err_t raw_setup_radio_admit(const raw_setup_radio_state_t *);
