/* Compile the actual provisioning implementation with host transport shims. */
#include "../cp_provision.c"
#include <assert.h>
#include <pthread.h>
#include <stdatomic.h>
#include <sched.h>
int64_t cp_test_time_us=1000;
void esp_fill_random(void *p,size_t n){arc4random_buf(p,n);}
protocomm_t *protocomm_new(void){return (protocomm_t *)calloc(1,1);}
void protocomm_delete(protocomm_t *p){free(p);}
esp_err_t protocomm_ble_start(protocomm_t *p,const protocomm_ble_config_t *c){(void)p;(void)c;return ESP_OK;}
esp_err_t protocomm_ble_stop(protocomm_t *p){(void)p;return ESP_OK;}
esp_err_t protocomm_set_security(protocomm_t *p,const char *n,const protocomm_security_t *s,const void *v){(void)p;(void)n;(void)s;(void)v;return ESP_OK;}
esp_err_t protocomm_add_endpoint(protocomm_t *p,const char *n,protocomm_req_handler_t h,void *ctx){(void)p;(void)n;(void)h;(void)ctx;return ESP_OK;}
static const char *master="00112233445566778899aabbccddeeff";
static const char *node="cp_001122aabbcc";
static unsigned submitted;
static atomic_bool hold_submit,entered,release_submit;
static esp_err_t submit_test(const cp_settings_t *c,const char *id,void *ctx){(void)ctx;assert(!strcmp(c->node_id,node));assert(cp_provision_uuid_v4(id));submitted++;if(atomic_load(&hold_submit)){atomic_store(&entered,true);while(!atomic_load(&release_submit))sched_yield();}return ESP_OK;}
static cJSON *exchange(const char *body){uint8_t *out=NULL;size_t n=0;assert(cp_provision_usb_exchange((const uint8_t *)body,strlen(body),&out,&n)==ESP_OK);assert(out&&n>0&&n<=1024);cJSON *r=cJSON_ParseWithLength((char *)out,n);free(out);assert(r);return r;}
static void expect_reason(cJSON *r,const char *why){assert(cJSON_IsFalse(cJSON_GetObjectItem(r,"ok")));assert(!strcmp(str(r,"reason"),why));cJSON_Delete(r);}
static void safe_status(cJSON *r){assert(!cJSON_GetObjectItem(r,"nonce"));assert(!cJSON_GetObjectItem(r,"proof"));assert(!cJSON_GetObjectItem(r,"pin"));assert(!cJSON_GetObjectItem(r,"password"));assert(!cJSON_GetObjectItem(r,"device_token"));}
static void candidate(char out[1025],const char *n,const char *password){snprintf(out,1025,"{\"v\":1,\"op\":\"configure\",\"nonce\":\"%s\",\"node_id\":\"%s\",\"attempt_id\":\"11111111-2222-4333-8444-555555555555\",\"ssid\":\"test-network\",\"password\":\"%s\",\"device_token\":\"cpd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}",n,node,password);}
static void *configure_thread(void *arg){cJSON *r=exchange(arg);assert(cJSON_IsTrue(cJSON_GetObjectItem(r,"ok")));cJSON_Delete(r);return NULL;}
int main(void){
    assert(cp_provision_start(CP_PROVISION_USB,node,master,submit_test,NULL)==ESP_OK);
    cJSON *info=exchange("{\"v\":1,\"op\":\"info\"}");assert(!strcmp(str(info,"transport"),"usb"));assert(!strcmp(str(info,"security"),"physical-usb"));assert(!strcmp(str(info,"firmware_version"),"synthetic-sdk-test"));char old_nonce[33];strcpy(old_nonce,str(info,"nonce"));cJSON_Delete(info);
    cp_provision_snapshot_t view;cp_provision_snapshot(&view);assert(view.proof[0]==0&&view.ap_password[0]==0);
    const char *bad[]={"{\"v\":1,\"op\":\"info\",\"op\":\"status\"}","{\"v\":1,\"op\":\"info\\u0000x\"}","{\"v\":1,\"op\":[]}","{\"v\":1,\"op\":{}}"};for(unsigned i=0;i<4;i++)expect_reason(exchange(bad[i]),"invalid_json");
    char body[1025];candidate(body,old_nonce,"test-password");
    atomic_store(&hold_submit,true);pthread_t thread;assert(!pthread_create(&thread,NULL,configure_thread,body));while(!atomic_load(&entered))sched_yield();
    assert(cp_provision_stop()==ESP_ERR_INVALID_STATE);assert(cp_provision_start(CP_PROVISION_USB,node,master,submit_test,NULL)==ESP_ERR_INVALID_STATE);expect_reason(exchange("{\"v\":1,\"op\":\"info\"}"),"session_busy");
    atomic_store(&release_submit,true);pthread_join(thread,NULL);atomic_store(&hold_submit,false);assert(submitted==1);
    cJSON *r=exchange(body);assert(cJSON_IsTrue(cJSON_GetObjectItem(r,"ok")));cJSON_Delete(r);assert(submitted==1);
    candidate(body,old_nonce,"different-password");expect_reason(exchange(body),"attempt_payload_changed");assert(submitted==1);
    cp_provision_set_status("testing","wifi_and_cloud");assert(cp_provision_stop()==ESP_OK);
    r=exchange("{\"v\":1,\"op\":\"status\"}");safe_status(r);assert(!strcmp(str(r,"state"),"testing"));assert(cJSON_IsFalse(cJSON_GetObjectItem(r,"active")));cJSON_Delete(r);
    expect_reason(exchange("{\"v\":1,\"op\":\"info\"}"),"setup_not_ready");
    cp_test_time_us+=1000;assert(cp_provision_start(CP_PROVISION_USB,node,master,submit_test,NULL)==ESP_OK);candidate(body,old_nonce,"test-password");expect_reason(exchange(body),"invalid_session_nonce");assert(submitted==1);
    cp_test_time_us+=SESSION_US;expect_reason(exchange("{\"v\":1,\"op\":\"info\"}"),"setup_expired");assert(cp_provision_stop()==ESP_OK);
    assert(cp_provision_start(CP_PROVISION_SOFTAP,node,master,submit_test,NULL)==ESP_OK);cp_provision_snapshot(&view);assert(strlen(view.proof)==8&&strlen(view.ap_password)==12);
    for(unsigned i=0;i<5;i++){cJSON *request=cJSON_CreateObject();cJSON_AddNumberToObject(request,"v",1);cJSON_AddStringToObject(request,"op","info");cJSON_AddStringToObject(request,"nonce",nonce);cJSON_AddStringToObject(request,"proof","wrongpin");assert(take_session());r=handle(request,CP_PROVISION_SOFTAP);give_session();expect_reason(r,i==4?"setup_locked":"invalid_setup_pin");cJSON_Delete(request);}
    assert(proof_failures==5);cp_provision_snapshot(&view);assert(!strcmp(view.state,"locked")&&!view.proof[0]);assert(cp_provision_stop()==ESP_OK);
    puts("Actual provisioning module: USB nonce/candidate idempotence, concurrent stop/start/submit, status-after-stop, parser guards, 5-minute expiry and 5-failure lock passed.");return 0;
}
