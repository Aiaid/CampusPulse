/* No MQTT SDK references, callback, client or transport interposition in
 * the default build. Explicit MQTT selection fails before Wi-Fi starts. */
#include "mqtt_native.h"
#include <string.h>
esp_err_t cp_v3_mqtt_configure(const cp_settings_t *s,const char *boot,uint32_t timeout){
    (void)s;(void)boot;(void)timeout;return ESP_ERR_NOT_SUPPORTED;
}
esp_err_t cp_v3_mqtt_request(cp_v3_http_method_t method,const char *path,const void *body,size_t bytes,bool receipt_only,
    char *reply,size_t capacity,cp_v3_transport_response_t *out,bool (*active)(void)){
    (void)method;(void)path;(void)body;(void)bytes;(void)receipt_only;(void)active;
    if(reply&&capacity)reply[0]=0;
    if(out)memset(out,0,sizeof *out);
    return ESP_ERR_NOT_SUPPORTED;
}
esp_err_t cp_v3_mqtt_stop(void){return ESP_OK;}
void cp_v3_mqtt_clear(void){}
esp_err_t cp_v3_mqtt_begin_memory(uint32_t timeout,cp_v3_transport_memory_t *out){
    (void)timeout;
    if(out)memset(out,0,sizeof *out);
    return ESP_ERR_NOT_SUPPORTED;
}
void cp_v3_mqtt_end_memory(void){}
