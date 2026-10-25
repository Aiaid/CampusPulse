#pragma once
/* Host-only app integration substitutes; no ESP/FreeRTOS scheduling claim. */
typedef int esp_err_t;
#define ESP_OK 0
#define ESP_ERR_NO_MEM 0x101
#define ESP_ERR_INVALID_STATE 0x103
#define ESP_ERR_NOT_SUPPORTED 0x106
const char *esp_err_to_name(esp_err_t error);
