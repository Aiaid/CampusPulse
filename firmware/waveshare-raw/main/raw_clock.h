#pragma once

#include <stdint.h>
#include "esp_err.h"

/* PCF85063 on Waveshare V2. All timestamps are UTC, never local time.
 * Serialize init/get/set in one task or with an application mutex.
 * init probes without changing any RTC register. INVALID_STATE means unknown
 * time, while the initialized bus remains available for a trusted set(). */
esp_err_t raw_clock_init(void);
esp_err_t raw_clock_get(uint64_t *utc_epoch);
esp_err_t raw_clock_probe(uint64_t *utc_epoch, uint8_t *control, uint8_t *seconds);
/* Only trusted epochs in 2000..2099 are accepted. A failed operation must not
 * be advertised as successful calibration, even if some writes reached RTC. */
esp_err_t raw_clock_set(uint64_t utc_epoch);
