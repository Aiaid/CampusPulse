/* Exact USB parser with synthetic input; no device, DNS, TLS or network. */
#include <assert.h>
#include <stdlib.h>
#include <string.h>
#include "../../waveshare-v3-trial/main/trial_bootstrap.c"

int64_t esp_timer_get_time(void) { return 1100000; }
void vTaskDelay(TickType_t ticks) { (void)ticks; }
#ifdef CP_V3_BOOTSTRAP_CONTINUOUS
void *heap_caps_calloc(size_t count, size_t size, unsigned flags) { (void)flags; return calloc(count,size); }
void heap_caps_free(void *data) { free(data); }
#endif

static cJSON *input(const char *origin) {
    cJSON *root = cJSON_CreateObject(); assert(root);
    cJSON_AddStringToObject(root,"node_id","ws-synthetic");
    cJSON_AddStringToObject(root,"boot_id","12345678-1234-4123-8123-123456789abc");
    cJSON_AddStringToObject(root,"origin",origin);
    cJSON_AddStringToObject(root,"uplink_transport","https");
    cJSON_AddStringToObject(root,"device_token","synthetic-private-token");
    cJSON_AddStringToObject(root,"ssid","synthetic-network");
    cJSON_AddStringToObject(root,"password","synthetic-password");
    cJSON_AddStringToObject(root,"security","personal");
    cJSON_AddNumberToObject(root,"utc_ms",1800000000000.);
    cJSON_AddNumberToObject(root,"uncertainty_ms",10);
    cJSON_AddNumberToObject(root,"anchor_mono_ms",1000);
    cJSON_AddNumberToObject(root,"max_windows",1);
    return root;
}
static bool send_input(cJSON *root) {
    char *json = cJSON_PrintUnformatted(root); assert(json); cJSON_Delete(root);
    trial_bootstrap_t out; memset(&out,0xa5,sizeof out);
    bool ok=parse(json,"ws-synthetic","12345678-1234-4123-8123-123456789abc",&out);
    if(!ok)for(size_t i=0;i<sizeof out;i++) assert(!((unsigned char *)&out)[i]);
    trial_bootstrap_clear(&out); free(json); return ok;
}
static bool check(const char *origin, const char *ca, bool ca_field) {
    cJSON *root=input(origin);
    if(ca_field) {
        if(ca) cJSON_AddStringToObject(root,"server_ca_pem",ca);
        else cJSON_AddNullToObject(root,"server_ca_pem");
    }
    return send_input(root);
}
static cJSON *mqtt_input(void){
    cJSON *root=input(CP_API_ORIGIN);
    cJSON_SetValuestring(cJSON_GetObjectItem(root,"uplink_transport"),"mqtt_tls");
    cJSON_AddStringToObject(root,"mqtt_uri",CP_MQTT_PRODUCTION_URI);
    cJSON_AddStringToObject(root,"mqtt_username","synthetic-user");
    cJSON_AddStringToObject(root,"mqtt_password","synthetic-password");
    cJSON_AddStringToObject(root,"mqtt_namespace","synthetic");return root;
}
int main(void) {
    assert(!check(CP_API_ORIGIN,NULL,false)); /* no production HTTPS */
    assert(check("https://192.168.1.2:8799",NULL,false));
    assert(check("https://isolated.example",NULL,false));
    const char *bad[]={CP_API_ORIGIN ":443", CP_API_ORIGIN ":8443", CP_API_ORIGIN "/",
        CP_API_ORIGIN "?x=1", CP_API_ORIGIN "#x", CP_API_ORIGIN ".", "https://test.pulse.anend.net",
        "http://pulse.anend.net", "https://PULSE.ANEND.NET", "https://user@pulse.anend.net",
        "https://", "https://example.test:0", "https://example.test:65536",
        "https://example.test:0443", "https://example.test\r\nX:1", "https://bad-.test"};
    for(size_t i=0;i<sizeof bad/sizeof *bad;i++) assert(!check(bad[i],NULL,false));
    assert(!check(CP_API_ORIGIN,NULL,true));
    assert(!check(CP_API_ORIGIN,"",true));
    assert(!check(CP_API_ORIGIN,"-----BEGIN CERTIFICATE-----\nsynthetic\n-----END CERTIFICATE-----",true));
#ifdef CP_V3_BOOTSTRAP_CONTINUOUS
    assert(check("https://192.168.1.2:8799","-----BEGIN CERTIFICATE-----\nsynthetic\n-----END CERTIFICATE-----",true));
    assert(send_input(mqtt_input()));
#else
    assert(!send_input(mqtt_input())); /* historical feature app remains isolated HTTPS */
#endif
    const char *required[]={"uplink_transport","mqtt_uri","mqtt_username","mqtt_password","mqtt_namespace"};
    for(unsigned i=0;i<5;i++){cJSON *root=mqtt_input();cJSON_DeleteItemFromObject(root,required[i]);assert(!send_input(root));}
    const char *bad_fields[]={"mqtt_uri","mqtt_username","mqtt_password","mqtt_namespace","uplink_transport","origin"};
    const char *bad_values[]={"mqtts://elsewhere.invalid:8883","","bad password","bad/topic","https","https://isolated.example"};
    for(unsigned i=0;i<6;i++){cJSON *root=mqtt_input();cJSON_SetValuestring(cJSON_GetObjectItem(root,bad_fields[i]),bad_values[i]);assert(!send_input(root));}
    cJSON *root=mqtt_input();cJSON_AddNullToObject(root,"server_ca_pem");assert(!send_input(root));
    root=input("https://isolated.example");cJSON_DeleteItemFromObject(root,"uplink_transport");assert(!send_input(root));
    puts("Waveshare exact bootstrap origin and production bundle boundaries passed");
    return 0;
}
