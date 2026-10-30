#include "raw_battery.h"
#include "esp_adc/adc_oneshot.h"
#include "esp_adc/adc_cali_scheme.h"
#include <assert.h>
#include <string.h>

static int fail_stage, reads, raw_value = 2000, calibrated_mv = 1900;
static unsigned deleted_units, new_units;
esp_err_t adc_oneshot_new_unit(const adc_oneshot_unit_init_cfg_t *cfg, adc_oneshot_unit_handle_t *out) {
    assert(cfg->unit_id == ADC_UNIT_1); new_units++;
    if (fail_stage == 1) return ESP_FAIL;
    *out = (void *)1; return ESP_OK;
}
esp_err_t adc_oneshot_config_channel(adc_oneshot_unit_handle_t adc, int channel, const adc_oneshot_chan_cfg_t *cfg) {
    assert(adc && channel == ADC_CHANNEL_3 && cfg->atten == ADC_ATTEN_DB_12 && cfg->bitwidth == ADC_BITWIDTH_12);
    return fail_stage == 2 ? ESP_FAIL : ESP_OK;
}
esp_err_t adc_oneshot_del_unit(adc_oneshot_unit_handle_t adc) {assert(adc); deleted_units++; return ESP_OK;}
esp_err_t adc_cali_create_scheme_curve_fitting(const adc_cali_curve_fitting_config_t *cfg, adc_cali_handle_t *out) {
    assert(cfg->unit_id == ADC_UNIT_1 && cfg->chan == ADC_CHANNEL_3 && cfg->atten == ADC_ATTEN_DB_12 && cfg->bitwidth == ADC_BITWIDTH_12);
    if (fail_stage == 3) return ESP_FAIL;
    *out = (void *)2; return ESP_OK;
}
esp_err_t adc_cali_delete_scheme_curve_fitting(adc_cali_handle_t c) {assert(c); return ESP_OK;}
esp_err_t adc_oneshot_read(adc_oneshot_unit_handle_t adc, int channel, int *out) {
    assert(adc && channel == ADC_CHANNEL_3); reads++;
    if (fail_stage == 4 && reads == 8) return ESP_FAIL;
    *out = raw_value; return ESP_OK;
}
esp_err_t adc_cali_raw_to_voltage(adc_cali_handle_t c, int raw, int *out) {
    assert(c && raw == raw_value);
    if (fail_stage == 5 && reads == 8) return ESP_FAIL;
    *out = calibrated_mv; return ESP_OK;
}
static void unknown(raw_battery_sample_t *s) {
    assert(!s->known && !s->millivolts && !s->estimated_percent);
}
int main(void) {
    raw_battery_sample_t sample;
    assert(raw_battery_read(&sample) == ESP_ERR_INVALID_STATE); unknown(&sample);
    for (fail_stage = 1; fail_stage <= 3; fail_stage++) {
        assert(raw_battery_init() == ESP_FAIL);
        assert(raw_battery_read(&sample) == ESP_ERR_INVALID_STATE); unknown(&sample);
    }
    assert(deleted_units == 2);
    fail_stage = 0; assert(raw_battery_init() == ESP_OK);
    assert(raw_battery_init() == ESP_OK && new_units == 4);
    assert(raw_battery_read(&sample) == ESP_OK);
    assert(sample.known && sample.millivolts == 3800 && sample.estimated_percent == 66 && reads == 16);
    for (fail_stage = 4; fail_stage <= 5; fail_stage++) {
        reads = 0; memset(&sample, 0xff, sizeof sample);
        assert(raw_battery_read(&sample) == ESP_FAIL); unknown(&sample);
    }
    fail_stage = 0;
    const int bad_raw[] = {0, -1, 4095, 4096};
    for (unsigned i = 0; i < sizeof bad_raw / sizeof bad_raw[0]; i++) {
        raw_value = bad_raw[i]; assert(raw_battery_read(&sample) == ESP_ERR_INVALID_RESPONSE); unknown(&sample);
    }
    raw_value = 2000;
    const int bad_mv[] = {-1, 0, 1299, 2251, 65535};
    for (unsigned i = 0; i < sizeof bad_mv / sizeof bad_mv[0]; i++) {
        calibrated_mv = bad_mv[i]; assert(raw_battery_read(&sample) == ESP_ERR_INVALID_RESPONSE); unknown(&sample);
    }
    calibrated_mv = 1300; assert(raw_battery_read(&sample) == ESP_OK && sample.estimated_percent == 0);
    calibrated_mv = 1500; assert(raw_battery_read(&sample) == ESP_OK && sample.estimated_percent == 0);
    calibrated_mv = 2100; assert(raw_battery_read(&sample) == ESP_OK && sample.estimated_percent == 100);
    calibrated_mv = 2250; assert(raw_battery_read(&sample) == ESP_OK && sample.estimated_percent == 100);
    assert(raw_battery_read(NULL) == ESP_ERR_INVALID_ARG);
    return 0;
}
