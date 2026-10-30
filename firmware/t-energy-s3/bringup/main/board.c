#include "board.h"

#include <stddef.h>

#include "esp_adc/adc_cali.h"
#include "esp_adc/adc_cali_scheme.h"
#include "esp_adc/adc_oneshot.h"
#include "esp_check.h"
#include "esp_log.h"

static const char *TAG = "board";

/* GPIO3 is the only pin the vendor code defines, and on the ESP32-S3 that pin
 * maps to ADC1 channel 2. Change both together if a schematic says otherwise. */
#define BOARD_ADC_UNIT ADC_UNIT_1
#define BOARD_ADC_CHANNEL ADC_CHANNEL_2

/* Full attenuation covers roughly 0-3.1 V, and a 4.2 V pack through the 1/2
 * divider only reaches 2.1 V, so there is headroom above a full battery. */
#define BOARD_ADC_ATTEN ADC_ATTEN_DB_12
#define BOARD_ADC_WIDTH ADC_BITWIDTH_12
#define BOARD_ADC_SAMPLES 16
#define BOARD_ADC_MAX_RAW 4095
#define BOARD_ADC_FALLBACK_FULL_SCALE_MV 3100

static adc_oneshot_unit_handle_t s_adc;
static adc_cali_handle_t s_cali;

esp_err_t board_init(void)
{
    adc_oneshot_unit_init_cfg_t unit_cfg = {.unit_id = BOARD_ADC_UNIT};
    ESP_RETURN_ON_ERROR(adc_oneshot_new_unit(&unit_cfg, &s_adc), TAG, "adc unit");

    adc_oneshot_chan_cfg_t chan_cfg = {
        .atten = BOARD_ADC_ATTEN,
        .bitwidth = BOARD_ADC_WIDTH,
    };
    ESP_RETURN_ON_ERROR(adc_oneshot_config_channel(s_adc, BOARD_ADC_CHANNEL, &chan_cfg), TAG, "adc channel");

    adc_cali_curve_fitting_config_t cali_cfg = {
        .unit_id = BOARD_ADC_UNIT,
        .chan = BOARD_ADC_CHANNEL,
        .atten = BOARD_ADC_ATTEN,
        .bitwidth = BOARD_ADC_WIDTH,
    };
    if (adc_cali_create_scheme_curve_fitting(&cali_cfg, &s_cali) == ESP_OK) {
        ESP_LOGI(TAG, "battery ADC on GPIO%d ready (curve-fitted)", BOARD_BATTERY_ADC_GPIO);
    } else {
        s_cali = NULL;
        ESP_LOGW(TAG, "battery ADC on GPIO%d ready without calibration; readings are approximate",
                 BOARD_BATTERY_ADC_GPIO);
    }
    return ESP_OK;
}

esp_err_t board_battery_read_mv(int32_t *out_mv)
{
    if (out_mv == NULL) return ESP_ERR_INVALID_ARG;
    if (s_adc == NULL) return ESP_ERR_INVALID_STATE;

    int64_t pin_total_mv = 0;
    int usable = 0;
    for (int i = 0; i < BOARD_ADC_SAMPLES; i++) {
        int raw = 0;
        if (adc_oneshot_read(s_adc, BOARD_ADC_CHANNEL, &raw) != ESP_OK) continue;

        int pin_mv = 0;
        if (s_cali != NULL) {
            if (adc_cali_raw_to_voltage(s_cali, raw, &pin_mv) != ESP_OK) continue;
        } else {
            pin_mv = raw * BOARD_ADC_FALLBACK_FULL_SCALE_MV / BOARD_ADC_MAX_RAW;
        }
        pin_total_mv += pin_mv;
        usable++;
    }
    if (usable == 0) return ESP_FAIL;

    *out_mv = (int32_t)((pin_total_mv / usable) * BOARD_BATTERY_DIVIDER);
    return ESP_OK;
}
