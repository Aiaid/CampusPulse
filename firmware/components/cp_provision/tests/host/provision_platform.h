#pragma once
#include "esp_err.h"
typedef struct {char version[32];}esp_app_desc_t;
static inline const esp_app_desc_t *esp_app_get_description(void){static const esp_app_desc_t desc={"synthetic-sdk-test"};return &desc;}
extern int64_t cp_test_time_us;
static inline int64_t esp_timer_get_time(void){return cp_test_time_us;}
