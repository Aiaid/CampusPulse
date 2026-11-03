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
    cJSON_AddStringToObject(root,"node_id","cp_001122334455");
    cJSON_AddStringToObject(root,"boot_id","12345678-1234-4123-8123-123456789abc");
    cJSON_AddStringToObject(root,"origin",origin);
    cJSON_AddStringToObject(root,"uplink_transport","https");
    cJSON_AddStringToObject(root,"device_token","synthetic-private-token-thirty-two-bytes");
    cJSON_AddStringToObject(root,"ssid","synthetic-network");
    cJSON_AddStringToObject(root,"password","synthetic-password");
    cJSON_AddStringToObject(root,"security","personal");
    cJSON_AddNumberToObject(root,"utc_ms",1800000000000.);
    cJSON_AddNumberToObject(root,"uncertainty_ms",10);
    cJSON_AddNumberToObject(root,"anchor_mono_ms",1000);
    cJSON_AddNumberToObject(root,"max_windows",1);
    return root;
}
static bool send_named(cJSON *root,const char *expected_node) {
    char *json = cJSON_PrintUnformatted(root); assert(json); cJSON_Delete(root);
    trial_bootstrap_t out; memset(&out,0xa5,sizeof out);
    bool ok=parse(json,expected_node,"12345678-1234-4123-8123-123456789abc",&out);
    if(!ok)for(size_t i=0;i<sizeof out;i++) assert(!((unsigned char *)&out)[i]);
    trial_bootstrap_clear(&out); free(json); return ok;
}
static bool send_input(cJSON *root){return send_named(root,"cp_001122334455");}
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
#ifdef CP_V3_BOOTSTRAP_CONTINUOUS
static cJSON *saved_input(void){
    cJSON *r=mqtt_input();
    cJSON_SetValuestring(cJSON_GetObjectItem(r,"node_id"),"cp_aabbccddeeff");
    cJSON_SetValuestring(cJSON_GetObjectItem(r,"device_token"),"synthetic_startup_token_0123456789abcdef");
    cJSON_SetNumberValue(cJSON_GetObjectItem(r,"max_windows"),0);
    cJSON_AddBoolToObject(r,"save_startup",true);cJSON_AddBoolToObject(r,"startup_reconfigure",false);
    cJSON_AddStringToObject(r,"clock_key_id","synthetic-key-1");
    /* Canonical SPKI for the public NIST P256 generator point. */
    cJSON_AddStringToObject(r,"clock_public_spki","MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEaxfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpZP40Li_hp_m47n60p8D54WK84zV2sxXs7LtkBoN79R9Q");
    return r;
}
#endif
static char *read_pem(const char *path){
    FILE *file=fopen(path,"rb");assert(file);char *out=calloc(4097,1);assert(out);
    size_t size=fread(out,1,4097,file);assert(size>0&&size<4097);fclose(file);return out;
}
static cJSON *peap_input(cJSON *r,const char *ca){
    cJSON_SetValuestring(cJSON_GetObjectItem(r,"security"),"enterprise_peap");
    cJSON_SetValuestring(cJSON_GetObjectItem(r,"password"),"");
    cJSON_AddStringToObject(r,"eap_username","synthetic-user");cJSON_AddStringToObject(r,"eap_identity","synthetic-identity");
    cJSON_AddStringToObject(r,"eap_password","synthetic-eap-secret");cJSON_AddStringToObject(r,"eap_ca_pem",ca);
    cJSON_AddStringToObject(r,"eap_domain","radius.example");return r;
}
static void reject_nul_suffix(cJSON *root,const char *key){
    char *json=cJSON_PrintUnformatted(root);assert(json);cJSON_Delete(root);
    char marker[64];snprintf(marker,sizeof marker,"\"%s\":\"",key);
    char *start=strstr(json,marker);assert(start);start+=strlen(marker);
    char *end=strchr(start,'"');assert(end);
    size_t prefix=(size_t)(end-json);char *changed=malloc(strlen(json)+16);assert(changed);
    memcpy(changed,json,prefix);strcpy(changed+prefix,"\\u0000junk");strcat(changed+prefix,end);
    trial_bootstrap_t out;memset(&out,0xa5,sizeof out);
    assert(!parse(changed,"cp_001122334455","12345678-1234-4123-8123-123456789abc",&out));
    for(size_t j=0;j<sizeof out;j++)assert(!((unsigned char *)&out)[j]);
    free(changed);free(json);
}
static void wifi_modes(const char *ca,const char *leaf){
    cJSON *r=input("https://isolated.example");cJSON_SetValuestring(cJSON_GetObjectItem(r,"security"),"open");
    cJSON_SetValuestring(cJSON_GetObjectItem(r,"password"),"");assert(send_input(r));
    r=input("https://isolated.example");cJSON_SetValuestring(cJSON_GetObjectItem(r,"security"),"open");assert(!send_input(r));
    const char *fields[]={"eap_username","eap_identity","eap_password","eap_ca_pem","eap_domain"};
    for(unsigned i=0;i<5;i++){
        reject_nul_suffix(peap_input(input("https://isolated.example"),ca),fields[i]);
        r=input("https://isolated.example");cJSON_AddStringToObject(r,fields[i],"");assert(!send_input(r));
        r=input("https://isolated.example");cJSON_SetValuestring(cJSON_GetObjectItem(r,"security"),"open");cJSON_SetValuestring(cJSON_GetObjectItem(r,"password"),"");cJSON_AddStringToObject(r,fields[i],"");assert(!send_input(r));
        r=peap_input(input("https://isolated.example"),ca);cJSON_DeleteItemFromObject(r,fields[i]);assert(!send_input(r));
        r=peap_input(input("https://isolated.example"),ca);cJSON_SetValuestring(cJSON_GetObjectItem(r,fields[i]),"");assert(!send_input(r));
        r=peap_input(input("https://isolated.example"),ca);cJSON_AddStringToObject(r,fields[i],"duplicate");assert(!send_input(r));
    }
    reject_nul_suffix(input("https://isolated.example"),"password");
    reject_nul_suffix(input("https://isolated.example"),"ssid");
    r=peap_input(input("https://isolated.example"),ca);cJSON_SetValuestring(cJSON_GetObjectItem(r,"eap_username"),"literal\\u0000");assert(send_input(r));
    r=peap_input(input("https://isolated.example"),ca);
    char *json=cJSON_PrintUnformatted(r);assert(json);cJSON_Delete(r);trial_bootstrap_t out;
    assert(parse(json,"cp_001122334455","12345678-1234-4123-8123-123456789abc",&out));free(json);
    assert(out.settings.wifi_security==CP_WIFI_ENTERPRISE_PEAP&&!out.settings.password[0]);
    assert(!strcmp(out.settings.eap_username,"synthetic-user")&&!strcmp(out.settings.eap_identity,"synthetic-identity"));
    assert(!strcmp(out.settings.eap_password,"synthetic-eap-secret")&&!strcmp(out.eap_ca_pem,ca)&&!strcmp(out.eap_domain,"radius.example"));
    trial_bootstrap_clear(&out);
    assert(!send_input(peap_input(input("https://isolated.example"),leaf)));
    assert(!send_input(peap_input(input("https://isolated.example"),"-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n")));
    const char *domains[]={"https://radius.example","192.0.2.1","127.1","1234","*.example","a..example","-a.example","a-.example","a.example.","a.example;b.example","a.example b.example"};
    for(unsigned i=0;i<sizeof domains/sizeof *domains;i++){r=peap_input(input("https://isolated.example"),ca);cJSON_SetValuestring(cJSON_GetObjectItem(r,"eap_domain"),domains[i]);assert(!send_input(r));}
    r=peap_input(input("https://isolated.example"),ca);cJSON_SetValuestring(cJSON_GetObjectItem(r,"eap_domain"),"radius");assert(send_input(r));
    r=peap_input(input("https://isolated.example"),ca);cJSON_SetValuestring(cJSON_GetObjectItem(r,"password"),"synthetic-pass");assert(!send_input(r));
    r=peap_input(input("https://isolated.example"),ca);cJSON_SetNumberValue(cJSON_GetObjectItem(r,"anchor_mono_ms"),1101);assert(!send_input(r));
    r=peap_input(input("https://isolated.example"),ca);cJSON_SetNumberValue(cJSON_GetObjectItem(r,"uncertainty_ms"),2000);assert(!send_input(r));
    const char *keys[]={"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","z123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"};
    for(unsigned i=0;i<2;i++){r=input("https://isolated.example");cJSON_SetValuestring(cJSON_GetObjectItem(r,"password"),keys[i]);assert(send_input(r)==(i==0));}
#ifdef CP_V3_BOOTSTRAP_CONTINUOUS
    assert(send_input(peap_input(mqtt_input(),ca)));
    r=peap_input(mqtt_input(),ca);cJSON_AddStringToObject(r,"server_ca_pem",ca);assert(!send_input(r));
    assert(!send_named(peap_input(saved_input(),ca),"cp_aabbccddeeff"));
    r=saved_input();cJSON_SetValuestring(cJSON_GetObjectItem(r,"security"),"open");cJSON_SetValuestring(cJSON_GetObjectItem(r,"password"),"");assert(send_named(r,"cp_aabbccddeeff"));
#endif
}
int main(int argc,char **argv) {
    assert(argc==3);char *ca=read_pem(argv[1]),*leaf=read_pem(argv[2]);wifi_modes(ca,leaf);
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
    assert(!check("https://192.168.1.2:8799","-----BEGIN CERTIFICATE-----\nsynthetic\n-----END CERTIFICATE-----",true));
    assert(check("https://192.168.1.2:8799",ca,true));
    assert(!check("https://192.168.1.2:8799",leaf,true));
    assert(send_input(mqtt_input()));
    assert(send_named(saved_input(),"cp_aabbccddeeff"));
    cJSON *candidate=saved_input();cJSON_DeleteItemFromObject(candidate,"startup_reconfigure");cJSON_AddBoolToObject(candidate,"startup_reconfigure",true);assert(send_named(candidate,"cp_aabbccddeeff"));
    const char *missing[]={"save_startup","clock_key_id","clock_public_spki"};
    for(unsigned i=0;i<3;i++){candidate=saved_input();cJSON_DeleteItemFromObject(candidate,missing[i]);assert(!send_named(candidate,"cp_aabbccddeeff"));}
    candidate=saved_input();cJSON_DeleteItemFromObject(candidate,"save_startup");cJSON_AddBoolToObject(candidate,"save_startup",false);assert(!send_named(candidate,"cp_aabbccddeeff"));
    candidate=saved_input();cJSON_SetValuestring(cJSON_GetObjectItem(candidate,"clock_public_spki"),"invalid");assert(!send_named(candidate,"cp_aabbccddeeff"));
    candidate=saved_input();cJSON_SetValuestring(cJSON_GetObjectItem(candidate,"clock_key_id"),"bad/key");assert(!send_named(candidate,"cp_aabbccddeeff"));
    candidate=saved_input();cJSON_AddNullToObject(candidate,"save_startup");assert(!send_named(candidate,"cp_aabbccddeeff"));
    candidate=input("https://isolated.example");cJSON_AddBoolToObject(candidate,"save_startup",true);assert(!send_input(candidate));
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
    free(ca);free(leaf);
    puts("Waveshare exact bootstrap Wi-Fi, origin and production bundle boundaries passed");
    return 0;
}
