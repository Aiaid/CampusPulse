#include "online_host.h"
#include "cp_v3_clock_online.h"
#include "cp_settings.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

static esp_http_client_config_t config;
static uint64_t now;
static unsigned init_calls,perform_calls,cleanup_calls,random_calls,verify_calls,headers;
static bool stopped,complete,signature_ok;
static int status;
static const char *fault;
static char request[80],previous_nonce[65];
static uint8_t key[91];
static bool is(const char *s) { return fault && !strcmp(fault,s); }
static bool cancel(void) { return stopped; }
int64_t esp_timer_get_time(void) { return (int64_t)(now*1000); }
void vTaskDelay(unsigned ms) { now+=ms; if(is("cancel_wait")) stopped=true; }
void esp_log_level_set(const char *tag,int level) { (void)tag; assert(level==ESP_LOG_NONE); }
int esp_crt_bundle_attach(void *p) { (void)p; return 0; }
void esp_fill_random(void *p,size_t n) { assert(n==32); memset(p,(int)++random_calls,n); }
esp_http_client_handle_t esp_http_client_init(const esp_http_client_config_t *c) {
    ++init_calls; config=*c;
    assert(!strcmp(c->url,CP_API_ORIGIN "/api/v3/clock"));
    assert(c->method==HTTP_METHOD_POST && c->timeout_ms==1000 && c->is_async);
    assert(c->disable_auto_redirect && !c->skip_cert_common_name_check);
    assert(c->crt_bundle_attach==esp_crt_bundle_attach && c->transport_type==HTTP_TRANSPORT_OVER_SSL);
    assert(c->auth_type==HTTP_AUTH_TYPE_NONE && c->max_authorization_retries==-1);
    assert(!c->username && !c->password && !c->cert_pem && !c->common_name);
    assert(c->buffer_size==1024 && c->buffer_size_tx==512 && c->user_data);
    return is("init") ? NULL : (void *)1;
}
esp_err_t esp_http_client_set_header(esp_http_client_handle_t h,const char *name,const char *value) {
    assert(h==(void *)1); ++headers;
    assert((!strcmp(name,"Content-Type")&&!strcmp(value,"application/json")) ||
        (!strcmp(name,"Accept")&&!strcmp(value,"application/json")) ||
        (!strcmp(name,"Cache-Control")&&!strcmp(value,"no-store")));
    return is("header") ? ESP_FAIL : ESP_OK;
}
esp_err_t esp_http_client_set_post_field(esp_http_client_handle_t h,const char *p,int n) {
    assert(h==(void *)1 && headers==3 && n==76 && !strncmp(p,"{\"nonce\":\"",10));
    assert(!strcmp(p+74,"\"}")); memcpy(request,p,(size_t)n+1);
    assert(memcmp(previous_nonce,p+10,64)); memcpy(previous_nonce,p+10,64); previous_nonce[64]=0;
    return is("post") ? ESP_FAIL : ESP_OK;
}
static void event(int id,char *data,int n,char *name,char *value) {
    esp_http_client_event_t e={.event_id=id,.data=data,.data_len=n,.header_key=name,.header_value=value,.user_data=config.user_data};
    (void)config.event_handler(&e); /* SDK may ignore callback error: final gate must reject. */
}
esp_err_t esp_http_client_perform(esp_http_client_handle_t h) {
    assert(h==(void *)1); ++perform_calls;
    if(is("perform")) return ESP_FAIL;
    if(is("timeout") || is("cancel_wait")) return ESP_ERR_HTTP_EAGAIN;
    now+=20;
    if(is("backward")) now=0;
    if(is("overrun")) now+=6001;
    if(is("cancel_event")) stopped=true;
    if(!is("no_headers")) event(HTTP_EVENT_HEADERS_SENT,NULL,0,NULL,NULL);
    if(is("repeat")) event(HTTP_EVENT_HEADERS_SENT,NULL,0,NULL,NULL);
    if(is("redirect")) event(HTTP_EVENT_REDIRECT,NULL,0,NULL,NULL);
    if(is("encoding")) event(HTTP_EVENT_ON_HEADER,NULL,0,"Content-Encoding","gzip");
    static char body[CP_V3_CLOCK_RESPONSE_MAX+1]; memset(body,'x',sizeof body);
    event(HTTP_EVENT_ON_DATA,NULL,0,NULL,NULL);
    if(is("oversize")) event(HTTP_EVENT_ON_DATA,body,sizeof body,NULL,NULL);
    else if(is("negative")) event(HTTP_EVENT_ON_DATA,body,-1,NULL,NULL);
    else if(is("null_data")) event(HTTP_EVENT_ON_DATA,NULL,3,NULL,NULL);
    else { event(HTTP_EVENT_ON_DATA,"valid",5,NULL,NULL); }
    now+=80;
    if(!is("no_finish")) event(HTTP_EVENT_ON_FINISH,NULL,0,NULL,NULL);
    return ESP_OK;
}
int esp_http_client_get_status_code(esp_http_client_handle_t h) { assert(h==(void *)1); return status; }
bool esp_http_client_is_complete_data_received(esp_http_client_handle_t h) { assert(h==(void *)1); return complete; }
esp_err_t esp_http_client_cleanup(esp_http_client_handle_t h) {
    assert(h==(void *)1); ++cleanup_calls;
    if(is("cancel_cleanup")) stopped=true;
    return is("cleanup") ? ESP_FAIL : ESP_OK;
}
bool cp_v3_clock_verify(const char *body,size_t n,const uint8_t spki[91],const char *id,
    const char nonce[65],uint64_t sent,uint64_t ended,uint32_t epoch,
    cp_v3_clock_verify_fn verify,void *ctx,cp_v3_time_t *out) {
    ++verify_calls; assert(n==5 && !memcmp(body,"valid",5) && spki==key && !strcmp(id,"key_1"));
    assert(!memcmp(nonce,request+10,64) && nonce[64]==0 && sent==1020 && ended==1100 && epoch==8);
    assert(verify && !ctx);
    if(!signature_ok) return false;
    *out=(cp_v3_time_t){.mono_ms=1060,.utc_ms=1793577600000ULL,.uncertainty_ms=1042,.clock_epoch=8};
    return true;
}
static void reset(const char *f) {
    now=1000; fault=f; init_calls=perform_calls=cleanup_calls=verify_calls=headers=0;
    stopped=false; complete=signature_ok=true; status=200;
}
static void failure(const char *f) {
    reset(f); cp_v3_time_t out={.utc_ms=123};
    assert(cp_v3_clock_probe_online(key,"key_1",8,cancel,&out)!=ESP_OK);
    cp_v3_time_t zero={0}; assert(!memcmp(&out,&zero,sizeof out));
    assert(init_calls==1 && cleanup_calls==(is("init")?0u:1u));
    assert(now<=7010 || is("overrun"));
}
int main(void) {
    reset(NULL); cp_v3_time_t out;
    assert(cp_v3_clock_probe_online(key,"key_1",8,cancel,&out)==ESP_OK);
    assert(out.mono_ms==1060 && out.clock_epoch==8 && out.uncertainty_ms==1042);
    assert(init_calls==1 && perform_calls==1 && cleanup_calls==1 && verify_calls==1);
    const char *bad[]={"init","header","post","perform","timeout","cancel_wait","backward","overrun",
        "cancel_event","repeat","redirect","encoding","oversize","negative","null_data","no_headers",
        "no_finish","cancel_cleanup","cleanup"};
    for(size_t i=0;i<sizeof bad/sizeof *bad;i++) failure(bad[i]);
    for(unsigned i=0;i<3;i++) {
        reset(NULL); if(i==0) status=401; if(i==1) complete=false; if(i==2) signature_ok=false;
        assert(cp_v3_clock_probe_online(key,"key_1",8,cancel,&out)==ESP_ERR_INVALID_RESPONSE);
        assert(!out.utc_ms && cleanup_calls==1);
    }
    reset(NULL); stopped=true;
    assert(cp_v3_clock_probe_online(key,"key_1",8,cancel,&out)==ESP_ERR_INVALID_STATE && !init_calls);
    reset(NULL);
    assert(cp_v3_clock_probe_online(key,"bad key",8,cancel,&out)==ESP_ERR_INVALID_ARG);
    assert(cp_v3_clock_probe_online(key,"key_1",0,cancel,&out)==ESP_ERR_INVALID_ARG);
    assert(cp_v3_clock_probe_online(NULL,"key_1",8,cancel,&out)==ESP_ERR_INVALID_ARG);
    assert(cp_v3_clock_probe_online(key,"key_1",8,cancel,NULL)==ESP_ERR_INVALID_ARG);
    assert(!init_calls);
    puts("online clock SDK/config/deadline/cancellation tests passed");
}
