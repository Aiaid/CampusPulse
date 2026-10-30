/* Reuse the provisioning module's platform/crypto fixture, but send all requests
 * below through the actual USB controller and actual provisioning exchange. */
#define main cp_provision_fixture_main
#include "../../cp_provision/tests/test_module.c"
#undef main
#include "cp_usb.h"

static unsigned usb_exchanges;
static bool usb_begin(void *context) {(void)context;return false;}
static esp_err_t usb_exchange(const uint8_t *body,size_t n,uint8_t **out,size_t *length)
{++usb_exchanges;return cp_provision_usb_exchange(body,n,out,length);}
static cJSON *usb_request(cJSON *q)
{
    char *body=cJSON_PrintUnformatted(q);assert(body);cJSON_Delete(q);
    uint8_t out[CP_USB_JSON_MAX+1];size_t n=0;
    assert(cp_usb_control(usb_begin,NULL,usb_exchange,(const uint8_t *)body,strlen(body),out,CP_USB_JSON_MAX,&n)==ESP_OK);
    free(body);out[n]=0;
    assert(!strstr((char *)out,"synthetic-mqtt-password")&&!strstr((char *)out,"test-password")&&!strstr((char *)out,saved_token));
    cJSON *r=cJSON_ParseWithLength((char *)out,n);assert(r);return r;
}
static void reject(cJSON *q,const char *reason,bool reaches_provision)
{
    unsigned before=usb_exchanges,submitted_before=submitted;
    expect_reason(usb_request(q),reason);
    assert(usb_exchanges==before+(reaches_provision?1u:0u)&&submitted==submitted_before);
}
int main(void)
{
    assert(cp_provision_bind_board("tenergy_s3","esp32s3")==ESP_OK);
    assert(cp_provision_start(CP_PROVISION_BLE,node,master,submit_test,NULL)==ESP_ERR_NOT_SUPPORTED);
    assert(cp_provision_start(CP_PROVISION_SOFTAP,node,master,submit_test,NULL)==ESP_ERR_NOT_SUPPORTED);
    assert(!state.active);
    new_usb_session();
    cJSON *q=cJSON_CreateObject();cJSON_AddNumberToObject(q,"v",1);cJSON_AddStringToObject(q,"op","info");
    cJSON *info=usb_request(q);assert(cJSON_IsTrue(cJSON_GetObjectItem(info,"ok")));
    assert(!strcmp(str(info,"nonce"),nonce));
    assert(!strcmp(str(info,"board"),"tenergy_s3 / esp32s3"));cJSON_Delete(info);
    assert(cp_provision_bind_board("passport","esp32c3")==ESP_ERR_INVALID_STATE);

    q=request("wpa2","test-password");unsigned before=submitted;
    cJSON *r=usb_request(q);assert(cJSON_IsTrue(cJSON_GetObjectItem(r,"ok")));cJSON_Delete(r);
    assert(submitted==before+1&&!strcmp(submitted_candidate.mqtt_uri,CP_MQTT_PRODUCTION_URI));
    assert(!strcmp(submitted_candidate.mqtt_username,"fixture_pool"));
    assert(!strcmp(submitted_candidate.mqtt_namespace,"fixture_pool"));
    assert(!strcmp(submitted_candidate.mqtt_password,"synthetic-mqtt-password"));
    assert(!strcmp(submitted_candidate.password,"test-password")&&!strcmp(submitted_candidate.device_token,saved_token));

    q=request("wpa2","test-password");cJSON *m=cJSON_GetObjectItem(q,"mqtt");
    cJSON_AddStringToObject(m,"password","duplicate");reject(q,"invalid_json",false);
    q=request("wpa2","test-password");cJSON_AddItemToObject(q,"mqtt",cJSON_Parse(MQTT_JSON));reject(q,"invalid_json",false);
    q=request("wpa2","test-password");m=cJSON_GetObjectItem(q,"mqtt");
    cJSON_ReplaceItemInObject(m,"password",cJSON_CreateNull());reject(q,"invalid_json",false);
    q=request("wpa2","test-password");m=cJSON_GetObjectItem(q,"mqtt");
    cJSON_ReplaceItemInObject(m,"password",cJSON_CreateArray());reject(q,"invalid_json",false);
    q=request("wpa2","test-password");m=cJSON_GetObjectItem(q,"mqtt");
    cJSON_ReplaceItemInObject(m,"password",cJSON_CreateObject());reject(q,"invalid_json",false);
    q=request("wpa2","test-password");cJSON_AddItemToObject(q,"other",cJSON_CreateObject());reject(q,"invalid_json",false);
    q=request("wpa2","test-password");m=cJSON_GetObjectItem(q,"mqtt");
    cJSON_ReplaceItemInObject(m,"uri",cJSON_CreateString("mqtts://evil.invalid:8883"));reject(q,"invalid_mqtt_settings",true);
    q=request("wpa2","test-password");m=cJSON_GetObjectItem(q,"mqtt");
    cJSON_AddStringToObject(m,"extra","unsupported");reject(q,"invalid_mqtt_settings",true);
    assert(cp_provision_stop()==ESP_OK);
    puts("Actual USB controller -> provisioning: nested MQTT submit, malformed-object guards, schema validation and secret isolation passed.");
    return 0;
}
