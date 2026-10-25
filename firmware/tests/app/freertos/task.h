#pragma once
#include "FreeRTOS.h"
typedef void *TaskHandle_t;
int xTaskCreate(void (*entry)(void *), const char *name, unsigned stack,
                void *arg, unsigned priority, TaskHandle_t *out);
void vTaskDelete(TaskHandle_t task);
void vTaskDelay(TickType_t delay);
