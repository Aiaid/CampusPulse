#pragma once
#include "FreeRTOS.h"
typedef void *TaskHandle_t;
typedef enum { eRunning, eReady, eBlocked, eSuspended, eDeleted, eInvalid } eTaskState;
typedef struct {
    TaskHandle_t xHandle;
    const char *pcTaskName;
    UBaseType_t xTaskNumber;
    eTaskState eCurrentState;
    configRUN_TIME_COUNTER_TYPE ulRunTimeCounter;
    uint32_t usStackHighWaterMark;
} TaskStatus_t;
void vTaskSuspendAll(void);
BaseType_t xTaskResumeAll(void);
TaskHandle_t xTaskGetHandle(const char *);
void vTaskGetInfo(TaskHandle_t, TaskStatus_t *, BaseType_t, eTaskState);
