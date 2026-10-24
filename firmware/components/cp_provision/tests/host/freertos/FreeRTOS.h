#pragma once
#include <pthread.h>
#include <stdint.h>
#define pdTRUE 1
#define portMAX_DELAY 0xffffffffu
typedef pthread_mutex_t portMUX_TYPE;
#define portMUX_INITIALIZER_UNLOCKED PTHREAD_MUTEX_INITIALIZER
#define portENTER_CRITICAL(p) ((void)pthread_mutex_lock(p))
#define portEXIT_CRITICAL(p) ((void)pthread_mutex_unlock(p))
