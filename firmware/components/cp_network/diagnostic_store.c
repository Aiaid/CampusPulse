#include "cp_network_diag.h"
#include "nvs.h"
#include <string.h>
#define RECORD_SIZE 120u
static void put32(uint8_t *p,uint32_t n){for(unsigned i=0;i<4;++i)p[i]=(uint8_t)(n>>(8*i));}
static uint32_t get32(const uint8_t *p){return (uint32_t)p[0]|(uint32_t)p[1]<<8|(uint32_t)p[2]<<16|(uint32_t)p[3]<<24;}
esp_err_t cp_network_attempt_load(cp_network_attempt_t *out)
{
    if(!out)return ESP_ERR_INVALID_ARG;
    memset(out,0,sizeof(*out));nvs_handle_t handle;
    esp_err_t e=nvs_open("cp_diag",NVS_READONLY,&handle);
    if(e==ESP_ERR_NVS_NOT_FOUND)return ESP_ERR_NOT_FOUND;
    if(e!=ESP_OK)return e;
    uint8_t bytes[RECORD_SIZE]={0};size_t size=sizeof(bytes);
    e=nvs_get_blob(handle,"last_attempt",bytes,&size);nvs_close(handle);
    if(e==ESP_OK && (size!=sizeof(bytes)||memcmp(bytes,"CPD1",4)))e=ESP_ERR_INVALID_STATE;
    if(e==ESP_OK){
        out->version=get32(bytes+4);out->state=(cp_attempt_state_t)get32(bytes+8);
        memcpy(out->attempt_id,bytes+12,37);memcpy(out->boot_id,bytes+49,37);
        cp_network_diagnostic_t *d=&out->diagnostic;
        d->stage=(cp_diag_stage_t)get32(bytes+86);d->code=(cp_diag_code_t)get32(bytes+90);
        d->esp_err=(int32_t)get32(bytes+94);d->http_status=(int32_t)get32(bytes+98);
        d->wifi_reason=(int32_t)get32(bytes+102);d->tls_code=(int32_t)get32(bytes+106);
        d->tls_flags=get32(bytes+110);d->elapsed_ms=get32(bytes+114);
        d->retryable=bytes[118];d->terminal=bytes[119];
        if(!cp_network_attempt_valid(out))e=ESP_ERR_INVALID_STATE;
    }
    if(e!=ESP_OK)memset(out,0,sizeof(*out));
    return e==ESP_ERR_NVS_NOT_FOUND?ESP_ERR_NOT_FOUND:e;
}
esp_err_t cp_network_attempt_save(const cp_network_attempt_t *a)
{
    if(!cp_network_attempt_valid(a))return ESP_ERR_INVALID_ARG;
    /* Explicit wire encoding has no struct padding or unrelated stack bytes. */
    uint8_t bytes[RECORD_SIZE]={0};memcpy(bytes,"CPD1",4);put32(bytes+4,a->version);put32(bytes+8,a->state);
    memcpy(bytes+12,a->attempt_id,37);memcpy(bytes+49,a->boot_id,37);
    const cp_network_diagnostic_t *d=&a->diagnostic;
    put32(bytes+86,d->stage);put32(bytes+90,d->code);put32(bytes+94,(uint32_t)d->esp_err);
    put32(bytes+98,(uint32_t)d->http_status);put32(bytes+102,(uint32_t)d->wifi_reason);
    put32(bytes+106,(uint32_t)d->tls_code);put32(bytes+110,d->tls_flags);put32(bytes+114,d->elapsed_ms);
    bytes[118]=d->retryable;bytes[119]=d->terminal;
    nvs_handle_t handle;esp_err_t e=nvs_open("cp_diag",NVS_READWRITE,&handle);
    if(e!=ESP_OK)return e;
    e=nvs_set_blob(handle,"last_attempt",bytes,sizeof(bytes));if(e==ESP_OK)e=nvs_commit(handle);
    nvs_close(handle);return e;
}
