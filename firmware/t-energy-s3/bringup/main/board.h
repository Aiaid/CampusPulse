#pragma once

#include <stdint.h>

#include "esp_err.h"

/*
 * Board facts for LILYGO T-Energy-S3 V1.0.
 *
 * Source: the vendor repository only (pin_config.h, the Original_Test example,
 * boards/esp32s3_flash_16MB.json). Nothing here has been measured on the
 * physical boards. See ../README.md for provenance and acceptance boundaries.
 */

#define BOARD_NAME "T-Energy-S3 V1.0"

/* The only pin the vendor code assigns: BATTERY_VOLTAGE_DATA = 3. */
#define BOARD_BATTERY_ADC_GPIO 3

/* The board halves the pack voltage before the ADC pin. Vendor example reads
 * analogReadMilliVolts(IO3) * 2, so every reading must be doubled. */
#define BOARD_BATTERY_DIVIDER 2

/* Provisional only: the divider resistor values, ADC linearity and the real
 * low-voltage cut-off have not been measured. */
#define BOARD_BATTERY_LOW_MV 3400

/* Configures the battery ADC. Returns ESP_OK once readings are possible. */
esp_err_t board_init(void);

/* Averages samples and returns the pack voltage in millivolts, with the
 * on-board 1/2 divider already compensated. */
esp_err_t board_battery_read_mv(int32_t *out_mv);
