#pragma once
#include <stdint.h>
#include "esp_err.h"

#include "raw_ui.h"

esp_err_t raw_display_init(void);
esp_err_t raw_display_present(const raw_display_snapshot_t *snapshot);
esp_err_t raw_display_sleep(void);
