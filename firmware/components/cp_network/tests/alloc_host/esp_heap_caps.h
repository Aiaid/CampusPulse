#pragma once
#include "esp_err.h"
#include <stddef.h>
#include <stdint.h>
typedef void (*esp_alloc_failed_hook_t)(size_t, uint32_t, const char *);
esp_err_t heap_caps_register_failed_alloc_callback(esp_alloc_failed_hook_t);
