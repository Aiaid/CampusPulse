#include "cp_usb.h"
#include "cJSON.h"
#include <string.h>
#include <stdlib.h>
static esp_err_t reply(const char *json,uint8_t *out,size_t cap,size_t *length)
{
    size_t n=strlen(json);
    if (n>cap) return ESP_ERR_INVALID_SIZE;
    memcpy(out,json,n);*length=n;return ESP_OK;
}
static void delete_private(cJSON *o)
{
    if (!o) return;
    for (cJSON *v=o->child;v;v=v->next) {
        if (v->valuestring) cp_usb_secure_clear(v->valuestring,strlen(v->valuestring));
        if (v->child) {
            /* Request schema is scalar; this only scrubs rejected bounded input. */
            for (cJSON *c=v->child;c;c=c->next)
                if (c->valuestring) cp_usb_secure_clear(c->valuestring,strlen(c->valuestring));
        }
    }
    cJSON_Delete(o);
}
static cJSON *parse(const uint8_t *bytes,size_t length)
{
    if (!bytes || !length || length>CP_USB_JSON_MAX || !cp_usb_utf8_valid(bytes,length)) return NULL;
    unsigned depth=0;bool quoted=false,escaped=false;
    for (size_t i=0;i<length;++i) {
        unsigned char c=bytes[i];
        if (i+6<=length && !memcmp(bytes+i,"\\u0000",6)) return NULL;
        if (quoted) {if (escaped)escaped=false;else if(c=='\\')escaped=true;else if(c=='"')quoted=false;}
        else if(c=='"')quoted=true;
        else if(c=='{'||c=='['){if(++depth>2)return NULL;}
        else if(c=='}'||c==']'){if(!depth)return NULL;--depth;}
    }
    if (quoted||depth) return NULL;
    const char *end=NULL,*text=(const char *)bytes;
    cJSON *o=cJSON_ParseWithLengthOpts(text,length,&end,false);
    while (end && end<text+length && (*end==' '||*end=='\t')) ++end;
    bool valid=cJSON_IsObject(o)&&end==text+length;
    for (const cJSON *v=o?o->child:NULL;valid&&v;v=v->next) {
        if (!v->string || cJSON_IsArray(v)||cJSON_IsObject(v)) {valid=false;break;}
        for (const cJSON *next=v->next;next;next=next->next)
            if (next->string && !strcmp(v->string,next->string)) {valid=false;break;}
    }
    if (!valid) {delete_private(o);return NULL;}
    return o;
}
esp_err_t cp_usb_control(cp_usb_begin_fn begin,void *context,cp_usb_exchange_fn exchange,
    const uint8_t *request,size_t request_length,uint8_t *out,size_t capacity,size_t *length)
{
    if (length) *length=0;
    if (!begin || !exchange || !out || !length) return ESP_ERR_INVALID_ARG;
    cJSON *o=parse(request,request_length);
    if (!o) return reply("{\"v\":1,\"ok\":false,\"reason\":\"invalid_json\"}",out,capacity,length);
    const cJSON *version=cJSON_GetObjectItemCaseSensitive(o,"v"),*op=cJSON_GetObjectItemCaseSensitive(o,"op");
    bool valid=cJSON_IsNumber(version)&&version->valuedouble==1&&cJSON_IsString(op);
    bool is_begin=valid&&!strcmp(op->valuestring,"begin");
    bool allowed=valid&&(is_begin||!strcmp(op->valuestring,"info")||!strcmp(op->valuestring,"status")||!strcmp(op->valuestring,"configure"));
    if (is_begin && cJSON_GetArraySize(o)!=2) allowed=false;
    delete_private(o);
    if (!allowed) return reply("{\"v\":1,\"ok\":false,\"reason\":\"invalid_operation\"}",out,capacity,length);
    if (is_begin) return reply(begin(context)?"{\"v\":1,\"ok\":true,\"state\":\"starting\"}":
        "{\"v\":1,\"ok\":false,\"reason\":\"supervisor_busy\"}",out,capacity,length);
    uint8_t *response=NULL;size_t response_length=0;
    esp_err_t result=exchange(request,request_length,&response,&response_length);
    if (result==ESP_OK && response && response_length && response_length<=CP_USB_JSON_MAX &&
        response_length<=capacity && cp_usb_utf8_valid(response,response_length)) {
        memcpy(out,response,response_length);*length=response_length;
    } else result=reply("{\"v\":1,\"ok\":false,\"reason\":\"service_unavailable\"}",out,capacity,length);
    if (response) {cp_usb_secure_clear(response,response_length);free(response);}
    return result;
}
