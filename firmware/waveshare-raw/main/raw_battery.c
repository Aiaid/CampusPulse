#include "raw_battery.h"
#include "esp_adc/adc_oneshot.h"
#include "esp_adc/adc_cali.h"
#include "esp_adc/adc_cali_scheme.h"
#include <string.h>

/* Exact ESP32-S3-ePaper-1.54 V2 (PICO N8R8), not the 1.54G:
 * official aaf395c1... V2/01_ADC_Test selects ADC1 channel3 (GPIO4).
 * Its schematic has R21=200k1% and R38=200k1%: VBAT = 2 * ADC millivolts.
 * No vendor implementation is copied. Calibration availability is mandatory. */
static adc_oneshot_unit_handle_t s_adc;
static adc_cali_handle_t s_calibration;

esp_err_t raw_battery_init(void) {
    if (s_adc && s_calibration) return ESP_OK;
    adc_oneshot_unit_init_cfg_t unit = {.unit_id = ADC_UNIT_1};
    esp_err_t result = adc_oneshot_new_unit(&unit, &s_adc);
    if (result != ESP_OK) { s_adc = NULL; return result; }
    adc_oneshot_chan_cfg_t channel = {.atten = ADC_ATTEN_DB_12, .bitwidth = ADC_BITWIDTH_12};
    result = adc_oneshot_config_channel(s_adc, ADC_CHANNEL_3, &channel);
    if (result == ESP_OK) {
        adc_cali_curve_fitting_config_t calibration = {
            .unit_id = ADC_UNIT_1, .chan = ADC_CHANNEL_3,
            .atten = ADC_ATTEN_DB_12, .bitwidth = ADC_BITWIDTH_12
        };
        result = adc_cali_create_scheme_curve_fitting(&calibration, &s_calibration);
    }
    if (result != ESP_OK) {
        if (s_calibration) (void)adc_cali_delete_scheme_curve_fitting(s_calibration);
        s_calibration = NULL;
        (void)adc_oneshot_del_unit(s_adc); s_adc = NULL;
    }
    return result;
}

esp_err_t raw_battery_read(raw_battery_sample_t *out) {
    if (!out) return ESP_ERR_INVALID_ARG;
    memset(out, 0, sizeof *out);
    if (!s_adc || !s_calibration) return ESP_ERR_INVALID_STATE;
    uint32_t sum = 0;
    for (unsigned i = 0; i < 16; i++) {
        int raw = 0, millivolts = 0;
        esp_err_t result = adc_oneshot_read(s_adc, ADC_CHANNEL_3, &raw);
        if (result != ESP_OK) return result;
        if (raw <= 0 || raw >= 4095) return ESP_ERR_INVALID_RESPONSE;
        result = adc_cali_raw_to_voltage(s_calibration, raw, &millivolts);
        if (result != ESP_OK) return result;
        /* Broad plausible single-cell range; absent/floating batteries cannot
         * be positively identified from this circuit, even with plausible VBAT. */
        if (millivolts < 1300 || millivolts > 2250) return ESP_ERR_INVALID_RESPONSE;
        sum += (uint32_t)millivolts * 2u;
    }
    uint32_t voltage = (sum + 8u) / 16u;
    out->millivolts = (uint16_t)voltage;
    out->estimated_percent = voltage <= 3000 ? 0 : voltage >= 4200 ? 100
        : (uint8_t)((voltage - 3000u) * 100u / 1200u);
    out->known = true;
    return ESP_OK;
}
