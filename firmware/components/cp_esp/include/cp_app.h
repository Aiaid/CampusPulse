#pragma once
#include "esp_err.h"
/* One supervisor owns startup. A page never owns the collector lifecycle. */
esp_err_t cp_app_start(void);
