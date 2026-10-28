#pragma once
#include <stdint.h>
typedef unsigned TickType_t;
typedef int portMUX_TYPE;
typedef int StaticSemaphore_t;
#define portMUX_INITIALIZER_UNLOCKED 0
#define portENTER_CRITICAL(m) ((void)(m))
#define portEXIT_CRITICAL(m) ((void)(m))
#define pdMS_TO_TICKS(ms) (ms)
#define pdTRUE 1
#define pdPASS 1
#define portMAX_DELAY UINT32_MAX
#define tskIDLE_PRIORITY 0
