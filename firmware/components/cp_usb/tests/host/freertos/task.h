#pragma once
#include "FreeRTOS.h"
typedef void *TaskHandle_t;
int xTaskCreate(void(*entry)(void*),const char*,unsigned,void*,unsigned,TaskHandle_t*);
unsigned uxTaskGetStackHighWaterMark(TaskHandle_t);
