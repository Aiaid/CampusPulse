#include "bootstrap_host.h"
#include "cp_v3_clock_bootstrap.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

const char wifi_event_base[]="wifi", ip_event_base[]="ip";
static char calls[12000];
static const char *fault, *cancel_at;
static unsigned fault_skip;
static bool is_cancelled, running, initialized, enterprise, has_identity, has_username, has_password;
static bool accepted, hint = true, connected = true, hint_running;
static unsigned attempts, verifies, random_calls;
static uint64_t now = 1000;
static TaskHandle_t task = (void *)1;
static void (*event_cb)(void *, esp_event_base_t, int32_t, void *);
static void (*hint_cb)(struct timeval *);
static esp_http_client_config_t http_config;
static char last_body[80], nonces[3][65];
static struct timeval wall = {.tv_sec = 123};
static esp_netif_t netif;
static esp_err_t step(const char *name) {
    assert(strlen(calls) + strlen(name) + 2 < sizeof calls);
    strcat(calls, name); strcat(calls, "|");
    if (cancel_at && !strcmp(cancel_at, name)) is_cancelled = true;
    if (fault && !strcmp(fault, name)) {
        if (!fault_skip) return ESP_FAIL;
        --fault_skip;
    }
    return ESP_OK;
}
static bool cancel(void) { return is_cancelled; }
static void order(const char *first, const char *second) {
    const char *a = strstr(calls, first), *b = strstr(calls, second);
    assert(a && b && a < b);
}
static void empty(const cp_v3_time_t *out) {
    cp_v3_time_t zero = {0}; assert(!memcmp(&zero, out, sizeof zero));
}
TaskHandle_t xTaskGetCurrentTaskHandle(void) { return task; }
int64_t esp_timer_get_time(void) { return (int64_t)(now * 1000); }
void vTaskDelay(unsigned ms) { now += ms; }
int gettimeofday(struct timeval *restrict out, void *restrict zone) { (void)zone; *out = wall; return 0; }
int settimeofday(const struct timeval *tv, const struct timezone *zone) { (void)zone; if (step("wall_restore")) return -1; wall = *tv; return 0; }
void esp_log_level_set(const char *s, int level) { (void)s; (void)level; }
int esp_crt_bundle_attach(void *p) { (void)p; return 0; }
esp_err_t esp_netif_init(void) { return step("netif_init"); }
esp_err_t esp_event_loop_create_default(void) { return ESP_OK; }
esp_netif_t *esp_netif_get_handle_from_ifkey(const char *key) { (void)key; return NULL; }
esp_netif_t *esp_netif_create_default_wifi_sta(void) { return &netif; }
void esp_netif_destroy_default_wifi(esp_netif_t *p) { assert(p == &netif); (void)step("netif_destroy"); }
esp_err_t esp_event_handler_instance_register(esp_event_base_t base, int32_t id,
    void (*cb)(void *, esp_event_base_t, int32_t, void *), void *context, esp_event_handler_instance_t *out) {
    (void)base;(void)id;(void)context;event_cb = cb; *out = (void *)1; return ESP_OK;
}
esp_err_t esp_event_handler_instance_unregister(esp_event_base_t b, int32_t id, esp_event_handler_instance_t p) { (void)b;(void)id;(void)p;return step("unregister"); }
esp_err_t esp_wifi_get_mode(wifi_mode_t *m) { (void)m; return initialized ? ESP_OK : ESP_ERR_WIFI_NOT_INIT; }
esp_err_t esp_wifi_init(const wifi_init_config_t *c) { (void)c;esp_err_t e=step("wifi_init");if(!e)initialized=true;return e; }
esp_err_t esp_wifi_set_storage(int s) { assert(s == WIFI_STORAGE_RAM);return ESP_OK; }
esp_err_t esp_wifi_set_mode(int s) { assert(s == WIFI_MODE_STA);return ESP_OK; }
esp_err_t esp_wifi_set_config(int interface, const wifi_config_t *c) { assert(interface==WIFI_IF_STA);assert(c->sta.pmf_cfg.capable);return step(c->sta.threshold.authmode==WIFI_AUTH_WPA2_ENTERPRISE?"wifi_peap":"wifi_non_peap"); }
esp_err_t esp_wifi_start(void) { esp_err_t e=step("wifi_start");if(!e)running=true;return e; }
esp_err_t esp_wifi_connect(void) { esp_err_t e=step("wifi_connect");if(!e&&connected)event_cb(NULL,IP_EVENT,IP_EVENT_STA_GOT_IP,NULL);return e; }
esp_err_t esp_wifi_stop(void) { esp_err_t e=step("wifi_stop");if(!e)running=false;return e; }
esp_err_t esp_wifi_deinit(void) { esp_err_t e=step("wifi_deinit");if(!e)initialized=false;return e; }
esp_err_t esp_wifi_sta_enterprise_enable(void) { assert(has_identity&&has_username&&has_password);esp_err_t e=step("eap_enable");if(!e)enterprise=true;return e; }
esp_err_t esp_wifi_sta_enterprise_disable(void) { assert(!running);esp_err_t e=step("eap_disable");if(!e)enterprise=false;return e; }
esp_err_t esp_eap_client_use_default_cert_bundle(bool b) { assert(!b);return step("eap_bundle_off"); }
esp_err_t esp_eap_client_set_domain_name(const char *domain) { assert(!domain);return step("eap_domain_clear"); }
esp_err_t esp_eap_client_set_disable_time_check(bool b) { return step(b?"eap_time_none":"eap_time_reset"); }
esp_err_t esp_eap_client_set_eap_methods(int m) { assert(m==ESP_EAP_TYPE_PEAP);return step("eap_method"); }
esp_err_t esp_eap_client_set_identity(const unsigned char *p, int n) { assert(n==8&&!memcmp(p,"identity",8));esp_err_t e=step("eap_identity");if(!e)has_identity=true;return e; }
esp_err_t esp_eap_client_set_username(const unsigned char *p, int n) { assert(n==4&&!memcmp(p,"user",4));esp_err_t e=step("eap_username");if(!e)has_username=true;return e; }
esp_err_t esp_eap_client_set_password(const unsigned char *p, int n) { assert(n==8&&!memcmp(p,"password",8));esp_err_t e=step("eap_password");if(!e)has_password=true;return e; }
void esp_eap_client_clear_identity(void) { assert(!running);has_identity=false;(void)step("identity_clear"); }
void esp_eap_client_clear_username(void) { assert(!running);has_username=false;(void)step("username_clear"); }
void esp_eap_client_clear_password(void) { assert(!running);has_password=false;(void)step("password_clear"); }
void esp_eap_client_clear_ca_cert(void) { (void)step("eap_ca_clear"); }
bool esp_sntp_enabled(void) { return hint_running; }
void esp_sntp_stop(void) { hint_running=false;(void)step("sntp_stop"); }
void esp_sntp_set_time_sync_notification_cb(void (*cb)(struct timeval *)) { hint_cb=cb; }
void esp_sntp_setoperatingmode(int m) { (void)m; }
void esp_sntp_set_sync_mode(int m) { (void)m; }
void esp_sntp_setservername(int i,const char *s) { assert(!i&&!strcmp(s,"ntp.aliyun.com")); }
void esp_sntp_set_sync_status(int s) { (void)s; }
void esp_sntp_init(void) { assert(running);(void)step("sntp_init");hint_running=true;if(hint){wall.tv_sec=1793577600;hint_cb(&wall);} }
void esp_fill_random(void *out,size_t n) { assert(running);memset(out,(int)++random_calls,n); }
esp_http_client_handle_t esp_http_client_init(const esp_http_client_config_t *c) {
    assert(!hint_running&&running);assert(c->crt_bundle_attach==esp_crt_bundle_attach&&!c->skip_cert_common_name_check);
    assert(c->disable_auto_redirect&&c->is_async&&c->method==HTTP_METHOD_POST);
    assert(!strcmp(c->url,CP_API_ORIGIN "/api/v3/clock"));http_config=*c;(void)step("https_init");return (void *)1;
}
esp_err_t esp_http_client_set_header(esp_http_client_handle_t h,const char *key,const char *value) {
    (void)h;assert(!strcmp(key,"Content-Type")||!strcmp(key,"Accept")||!strcmp(key,"Cache-Control"));
    assert(!strcmp(value,"application/json")||!strcmp(value,"no-store"));return ESP_OK;
}
esp_err_t esp_http_client_set_post_field(esp_http_client_handle_t h,const char *body,int n) {
    (void)h;assert(n==76&&!strncmp(body,"{\"nonce\":\"",10));memcpy(last_body,body,(size_t)n);last_body[n]=0;return ESP_OK;
}
esp_err_t esp_http_client_perform(esp_http_client_handle_t h) {
    (void)h;assert(attempts<3);++attempts;esp_err_t e=step("https_perform");if(e)return e;
    esp_http_client_event_t event={.event_id=HTTP_EVENT_HEADERS_SENT};e=http_config.event_handler(&event);if(e)return e;now+=100;
    event=(esp_http_client_event_t){.event_id=HTTP_EVENT_ON_DATA,.data="signed-response",.data_len=15};e=http_config.event_handler(&event);if(e)return e;
    event.event_id=HTTP_EVENT_ON_FINISH;return http_config.event_handler(&event);
}
int esp_http_client_get_status_code(esp_http_client_handle_t h) { (void)h;return 200; }
bool esp_http_client_is_complete_data_received(esp_http_client_handle_t h) { (void)h;return true; }
esp_err_t esp_http_client_cleanup(esp_http_client_handle_t h) { (void)h;return step("https_cleanup"); }
bool cp_v3_clock_verify(const char *body,size_t bytes,const uint8_t spki[91],const char *key,const char nonce[65],
    uint64_t start,uint64_t end,uint32_t epoch,cp_v3_clock_verify_fn verifier,void *context,cp_v3_time_t *out) {
    (void)spki;(void)context;assert(verifier&&epoch==1&&end-start==100);assert(!strcmp(key,"test-key"));
    assert(bytes==15&&!memcmp(body,"signed-response",15));assert(!memcmp(nonce,last_body+10,64));
    assert(verifies<3);for(unsigned i=0;i<verifies;++i)assert(strcmp(nonces[i],nonce));strcpy(nonces[verifies++],nonce);
    (void)step("signed_verify");*out=(cp_v3_time_t){.utc_ms=1793577600000ULL,.mono_ms=end,.clock_epoch=1,.uncertainty_ms=1000};return accepted;
}
static cp_settings_t settings(void) {
    cp_settings_t s={.version=CP_SETTINGS_VERSION,.wifi_security=CP_WIFI_ENTERPRISE_PEAP};
    strcpy(s.node_id,"cp_aabbccddeeff");strcpy(s.ssid,"synthetic-ap");strcpy(s.device_token,"synthetic-device-token-12345678901234567890");
    strcpy(s.api_origin,CP_API_ORIGIN);strcpy(s.eap_identity,"identity");strcpy(s.eap_username,"user");strcpy(s.eap_password,"password");return s;
}
static void reset(void) {
    fault=NULL;fault_skip=0;cancel_at=NULL;is_cancelled=false;assert(cp_v3_clock_stop()==ESP_OK);
    assert(!initialized&&!running&&!enterprise&&!hint_running&&!has_identity&&!has_username&&!has_password);
    calls[0]=0;accepted=true;hint=true;connected=true;attempts=verifies=random_calls=0;now=1000;wall=(struct timeval){.tv_sec=123};
}
static esp_err_t boot(cp_settings_t *s,cp_v3_time_t *out) { static const uint8_t key[91]={0};memset(out,0xab,sizeof *out);return cp_v3_clock_bootstrap_peap_none(s,key,"test-key",cancel,out); }
int main(void) {
    cp_settings_t s=settings();cp_v3_time_t out;static const uint8_t key[91]={0};
    reset();assert(cp_v3_clock_bootstrap(&s,key,"test-key",cancel,&out)==ESP_ERR_INVALID_ARG);empty(&out);assert(!*calls);
    s.wifi_security=CP_WIFI_OPEN;memset(s.eap_identity,0,sizeof s.eap_identity);memset(s.eap_username,0,sizeof s.eap_username);memset(s.eap_password,0,sizeof s.eap_password);
    assert(boot(&s,&out)==ESP_ERR_INVALID_ARG);empty(&out);assert(!*calls);
    assert(cp_v3_clock_bootstrap(&s,key,"test-key",cancel,&out)==ESP_OK);assert(!strstr(calls,"eap_"));reset();
    s.wifi_security=CP_WIFI_PERSONAL;strcpy(s.password,"personal-password");assert(cp_v3_clock_bootstrap(&s,key,"test-key",cancel,&out)==ESP_OK);reset();s=settings();
    assert(boot(&s,&out)==ESP_OK&&out.utc_ms);assert(attempts==1&&verifies==1);
    order("wifi_peap|","eap_bundle_off|");order("eap_bundle_off|","eap_ca_clear|");order("eap_ca_clear|","eap_domain_clear|");
    order("eap_domain_clear|","eap_time_none|");order("eap_time_none|","eap_identity|");order("eap_password|","eap_enable|");
    order("eap_enable|","wifi_start|");order("wifi_connect|","sntp_init|");order("sntp_stop|","https_init|");
    order("signed_verify|","wall_restore|");order("wifi_stop|","eap_disable|");order("eap_disable|","password_clear|");
    order("eap_time_reset|","wifi_deinit|");order("wifi_deinit|","netif_destroy|");reset();
    accepted=false;assert(boot(&s,&out)!=ESP_OK);empty(&out);assert(verifies==3&&random_calls==3);reset();
    const char *setup_faults[]={"wifi_init","wifi_peap","eap_bundle_off","eap_domain_clear","eap_time_none","eap_method","eap_identity","eap_username","eap_password","eap_enable","wifi_start","wifi_connect","https_perform"};
    for(size_t i=0;i<sizeof setup_faults/sizeof *setup_faults;++i){fault=setup_faults[i];assert(boot(&s,&out)!=ESP_OK);empty(&out);reset();}
    connected=false;assert(boot(&s,&out)!=ESP_OK);empty(&out);assert(!attempts);reset();
    hint=false;assert(boot(&s,&out)!=ESP_OK);empty(&out);assert(!attempts);reset();
    cancel_at="wifi_connect";assert(boot(&s,&out)!=ESP_OK);empty(&out);assert(!attempts);reset();
    cancel_at="https_perform";assert(boot(&s,&out)!=ESP_OK);empty(&out);reset();
    const char *cleanup_faults[]={"https_cleanup","wall_restore","wifi_stop","eap_disable","eap_domain_clear","eap_time_reset","eap_bundle_off","wifi_deinit","unregister"};
    for(size_t i=0;i<sizeof cleanup_faults/sizeof *cleanup_faults;++i){
        fault=cleanup_faults[i];
        if(!strcmp(fault,"eap_domain_clear")||!strcmp(fault,"eap_bundle_off"))fault_skip=1;
        assert(boot(&s,&out)!=ESP_OK);empty(&out);
        if(!strcmp(fault,"wifi_stop")||!strcmp(fault,"eap_disable"))assert(enterprise&&has_identity&&has_username&&has_password);
        assert(cp_v3_clock_bootstrap_peap_none(&s,key,"test-key",cancel,&out)==ESP_ERR_INVALID_STATE);empty(&out);
        task=(void *)2;assert(cp_v3_clock_stop()==ESP_ERR_INVALID_STATE);task=(void *)1;reset();
        assert(boot(&s,&out)==ESP_OK);reset();
    }
    puts("bootstrap SDK execution: PEAP NONE ordering, strict HTTPS, failure/cancel, cleanup ownership and retry passed");return 0;
}
