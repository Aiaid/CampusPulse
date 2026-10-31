#include "mqtt_native.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
int main(void){
    cp_v3_transport_response_t response;memset(&response,0xa5,sizeof response);char reply[16]="must clear";
    assert(cp_v3_mqtt_configure(NULL,NULL,0)==ESP_ERR_NOT_SUPPORTED);
    assert(cp_v3_mqtt_request(CP_V3_HTTP_POST,"/api/v3/device/capabilities",NULL,0,false,reply,sizeof reply,&response,NULL)==ESP_ERR_NOT_SUPPORTED);
    assert(!reply[0]&&!response.complete&&response.stage==CP_V3_TRANSPORT_IDLE&&!response.mqtt_retained);
    cp_v3_transport_memory_t memory;memset(&memory,0xa5,sizeof memory);
    assert(cp_v3_mqtt_begin_memory(0,&memory)==ESP_ERR_NOT_SUPPORTED&&!memory.mqtt_hot);
    assert(cp_v3_mqtt_stop()==ESP_OK);cp_v3_mqtt_clear();cp_v3_mqtt_end_memory();
    puts("Disabled V3 MQTT: unsupported without SDK/client/wrapper references");
}
