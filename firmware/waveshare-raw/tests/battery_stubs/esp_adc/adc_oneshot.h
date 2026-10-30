#pragma once
#include "esp_err.h"
typedef void *adc_oneshot_unit_handle_t;
enum { ADC_UNIT_1 = 1, ADC_CHANNEL_3 = 3, ADC_ATTEN_DB_12 = 12, ADC_BITWIDTH_12 = 12 };
typedef struct { int unit_id; } adc_oneshot_unit_init_cfg_t;
typedef struct { int atten, bitwidth; } adc_oneshot_chan_cfg_t;
esp_err_t adc_oneshot_new_unit(const adc_oneshot_unit_init_cfg_t *, adc_oneshot_unit_handle_t *);
esp_err_t adc_oneshot_config_channel(adc_oneshot_unit_handle_t, int, const adc_oneshot_chan_cfg_t *);
esp_err_t adc_oneshot_del_unit(adc_oneshot_unit_handle_t);
esp_err_t adc_oneshot_read(adc_oneshot_unit_handle_t, int, int *);
