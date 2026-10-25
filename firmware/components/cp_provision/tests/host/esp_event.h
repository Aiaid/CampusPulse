#pragma once
#include "esp_err.h"
typedef const char *esp_event_base_t;
#define ESP_EVENT_DECLARE_BASE(name) extern esp_event_base_t name
#define ESP_EVENT_DEFINE_BASE(name) esp_event_base_t name = #name
#define portMAX_DELAY 0xffffffffu
static inline int esp_event_post(esp_event_base_t b,int32_t id,const void *p,size_t n,unsigned wait){(void)b;(void)id;(void)p;(void)n;(void)wait;return ESP_OK;}
static inline int esp_event_loop_create_default(void){return ESP_OK;}
