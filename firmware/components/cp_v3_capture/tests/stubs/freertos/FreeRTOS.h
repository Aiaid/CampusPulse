#pragma once
#include <stddef.h>
#include <stdint.h>
typedef unsigned TickType_t;
typedef struct {unsigned unused;} portMUX_TYPE;
#define portMUX_INITIALIZER_UNLOCKED {0}
#define pdTRUE 1
#define pdFALSE 0
#define pdPASS 1
#define portMAX_DELAY 0xffffffffu
#define pdMS_TO_TICKS(n) (n)
void test_lock(void);
void test_unlock(void);
#define portENTER_CRITICAL(m) ((void)(m),test_lock())
#define portEXIT_CRITICAL(m) ((void)(m),test_unlock())
