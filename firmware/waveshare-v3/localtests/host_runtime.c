#include "freertos/task.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "esp_heap_caps.h"
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <errno.h>
#include <assert.h>
static struct timespec until(TickType_t ms) {
    struct timespec t; clock_gettime(CLOCK_REALTIME,&t); t.tv_sec += ms/1000; t.tv_nsec += (long)(ms%1000)*1000000;
    if(t.tv_nsec>=1000000000){t.tv_sec++;t.tv_nsec-=1000000000;} return t;
}
static bool wait_condition(pthread_cond_t *condition,pthread_mutex_t *mutex,TickType_t ticks,struct timespec deadline) {
    if(!ticks)return false;
    int result=ticks==portMAX_DELAY?pthread_cond_wait(condition,mutex):pthread_cond_timedwait(condition,mutex,&deadline);
    return result!=ETIMEDOUT;
}
void *heap_caps_calloc(size_t n,size_t size,unsigned caps){(void)caps;return calloc(n,size);}
void heap_caps_free(void *p){free(p);}
int64_t esp_timer_get_time(void){struct timespec t;clock_gettime(CLOCK_MONOTONIC,&t);return (int64_t)t.tv_sec*1000000+t.tv_nsec/1000;}
SemaphoreHandle_t xSemaphoreCreateBinaryStatic(StaticSemaphore_t *s){memset(s,0,sizeof *s);pthread_mutex_init(&s->lock,0);pthread_cond_init(&s->changed,0);return s;}
SemaphoreHandle_t xSemaphoreCreateMutexStatic(StaticSemaphore_t *s){xSemaphoreCreateBinaryStatic(s);s->count=1;s->mutex=true;return s;}
BaseType_t xSemaphoreTake(SemaphoreHandle_t s,TickType_t ticks){struct timespec t=until(ticks);pthread_mutex_lock(&s->lock);while(!s->count){if(!wait_condition(&s->changed,&s->lock,ticks,t)){pthread_mutex_unlock(&s->lock);return pdFALSE;}}--s->count;pthread_mutex_unlock(&s->lock);return pdTRUE;}
BaseType_t xSemaphoreGive(SemaphoreHandle_t s){pthread_mutex_lock(&s->lock);s->count=1;pthread_cond_signal(&s->changed);pthread_mutex_unlock(&s->lock);return pdTRUE;}
void vSemaphoreDelete(SemaphoreHandle_t s){pthread_mutex_destroy(&s->lock);pthread_cond_destroy(&s->changed);}
QueueHandle_t xQueueCreateStatic(unsigned cap,unsigned size,uint8_t *data,StaticQueue_t *q){memset(q,0,sizeof *q);pthread_mutex_init(&q->lock,0);pthread_cond_init(&q->changed,0);q->cap=cap;q->size=size;q->data=data;return q;}
BaseType_t xQueueSend(QueueHandle_t q,const void *item,TickType_t ticks){(void)ticks;pthread_mutex_lock(&q->lock);if(q->count==q->cap){pthread_mutex_unlock(&q->lock);return pdFALSE;}memcpy(q->data+q->tail*q->size,item,q->size);q->tail=(q->tail+1)%q->cap;q->count++;pthread_cond_signal(&q->changed);pthread_mutex_unlock(&q->lock);return pdTRUE;}
BaseType_t xQueueReceive(QueueHandle_t q,void *item,TickType_t ticks){struct timespec t=until(ticks);pthread_mutex_lock(&q->lock);while(!q->count){if(!wait_condition(&q->changed,&q->lock,ticks,t)){pthread_mutex_unlock(&q->lock);return pdFALSE;}}memcpy(item,q->data+q->head*q->size,q->size);q->head=(q->head+1)%q->cap;q->count--;pthread_mutex_unlock(&q->lock);return pdTRUE;}
unsigned uxQueueMessagesWaiting(QueueHandle_t q){pthread_mutex_lock(&q->lock);unsigned n=q->count;pthread_mutex_unlock(&q->lock);return n;}
void vQueueDelete(QueueHandle_t q){pthread_mutex_destroy(&q->lock);pthread_cond_destroy(&q->changed);}
struct host_task{pthread_t thread;pthread_mutex_t lock;pthread_cond_t changed;unsigned notified;void(*fn)(void*);void*ctx;};
static _Thread_local TaskHandle_t current;
static void *entry(void *ctx){current=ctx;current->fn(current->ctx);abort();}
BaseType_t xTaskCreate(void(*fn)(void*),const char *name,unsigned stack,void *ctx,unsigned priority,TaskHandle_t *out){(void)name;(void)stack;(void)priority;TaskHandle_t t=calloc(1,sizeof *t);if(!t)return pdFALSE;pthread_mutex_init(&t->lock,0);pthread_cond_init(&t->changed,0);t->fn=fn;t->ctx=ctx;*out=t;if(pthread_create(&t->thread,0,entry,t)){free(t);return pdFALSE;}return pdPASS;}
void xTaskNotifyGive(TaskHandle_t t){pthread_mutex_lock(&t->lock);t->notified++;pthread_cond_signal(&t->changed);pthread_mutex_unlock(&t->lock);}
unsigned ulTaskNotifyTake(BaseType_t clear,TickType_t ticks){struct timespec end=until(ticks);pthread_mutex_lock(&current->lock);while(!current->notified){if(!wait_condition(&current->changed,&current->lock,ticks,end)){pthread_mutex_unlock(&current->lock);return 0;}}unsigned n=current->notified;if(clear)current->notified=0;else current->notified--;pthread_mutex_unlock(&current->lock);return n;}
void vTaskDelete(TaskHandle_t task){assert(!task);TaskHandle_t t=current;pthread_detach(pthread_self());pthread_mutex_destroy(&t->lock);pthread_cond_destroy(&t->changed);free(t);pthread_exit(0);}
void vTaskDelay(TickType_t ticks){struct timespec t={.tv_sec=ticks/1000,.tv_nsec=(long)(ticks%1000)*1000000};nanosleep(&t,0);}
