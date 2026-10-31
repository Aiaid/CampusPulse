#pragma once
#include "FreeRTOS.h"
typedef struct host_task *TaskHandle_t;
BaseType_t xTaskCreate(void (*)(void *), const char *, unsigned, void *, unsigned, TaskHandle_t *);
void xTaskNotifyGive(TaskHandle_t);
unsigned ulTaskNotifyTake(BaseType_t, TickType_t);
void vTaskDelete(TaskHandle_t);
void vTaskDelay(TickType_t);
