#pragma once
#include "FreeRTOS.h"
typedef struct { pthread_mutex_t lock; pthread_cond_t changed; unsigned cap,size,head,tail,count; uint8_t *data; } StaticQueue_t;
typedef StaticQueue_t *QueueHandle_t;
QueueHandle_t xQueueCreateStatic(unsigned, unsigned, uint8_t *, StaticQueue_t *);
BaseType_t xQueueSend(QueueHandle_t, const void *, TickType_t);
BaseType_t xQueueReceive(QueueHandle_t, void *, TickType_t);
unsigned uxQueueMessagesWaiting(QueueHandle_t);
void vQueueDelete(QueueHandle_t);
