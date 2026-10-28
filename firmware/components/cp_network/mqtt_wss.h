#pragma once
#include "cp_settings.h"
#include "http_response.h"
#include "sdkconfig.h"
#if CONFIG_CP_NETWORK_MQTT_WSS
/* Legacy API names also cover optional native MQTT/TLS. Native credentials are
 * independent private build settings; runtime Cloudflare settings are retained. */
/* All functions are owner-task only under network.c's shared memory gate. */
esp_err_t cp_mqtt_wss_request(const cp_settings_t *settings,const char *node,const char *boot,
    const char *op,const char *body,size_t length,cp_http_response_t *response,int *status,
    bool (*active)(void));
esp_err_t cp_mqtt_wss_stop(void);
bool cp_mqtt_wss_established(void);
bool cp_mqtt_wss_memory_safe(void);
/* Success owns the IO gate until end_memory_work. No SDK API calls are legal
 * in that interval; upload_ready only samples local state and heap. */
bool cp_mqtt_wss_encode_ready(uint32_t timeout_ms);
bool cp_mqtt_wss_upload_ready(bool allocated);
bool cp_mqtt_wss_allocation_ready(size_t bytes,uint32_t timeout_ms);
void cp_mqtt_wss_end_memory_work(void);
void cp_mqtt_wss_idle(bool usable);
#endif
