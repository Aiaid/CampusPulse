#pragma once
#include "FreeRTOS.h"
typedef struct {uint8_t *data;unsigned capacity,size,head,count;} StaticQueue_t;
typedef StaticQueue_t *QueueHandle_t;
QueueHandle_t xQueueCreateStatic(unsigned,unsigned,uint8_t *,StaticQueue_t *);
int xQueueReceive(QueueHandle_t,void *,TickType_t);
int xQueueSend(QueueHandle_t,const void *,TickType_t);
unsigned uxQueueMessagesWaiting(QueueHandle_t);
