#pragma once
#include "cp_v3_transport.h"
esp_err_t cp_v3_mqtt_configure(const cp_settings_t *,const char *boot,uint32_t timeout_ms);
esp_err_t cp_v3_mqtt_request(cp_v3_http_method_t,const char *,const void *,size_t,bool,
    char *,size_t,cp_v3_transport_response_t *,bool (*active)(void));
esp_err_t cp_v3_mqtt_stop(void);
void cp_v3_mqtt_clear(void);
esp_err_t cp_v3_mqtt_begin_memory(uint32_t,cp_v3_transport_memory_t *);
void cp_v3_mqtt_end_memory(void);
