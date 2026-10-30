#pragma once
#include <stdint.h>
#include "esp_err.h"
#define ESP_PD_DOMAIN_RTC_PERIPH 1
#define ESP_PD_OPTION_ON 1
#define ESP_EXT1_WAKEUP_ANY_LOW 0
esp_err_t esp_sleep_pd_config(int, int);
esp_err_t esp_sleep_enable_ext1_wakeup_io(uint64_t, int);
void esp_deep_sleep_start(void);
