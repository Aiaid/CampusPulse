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
#define MQTT_JSON "{\"uri\":\"" CP_MQTT_PRODUCTION_URI "\",\"username\":\"fixture_pool\",\"password\":\"synthetic-mqtt-password\",\"namespace\":\"fixture_pool\"}"
static const char *master="00112233445566778899aabbccddeeff";
static const char *node="cp_001122aabbcc";
static unsigned submitted;
static cp_settings_t submitted_candidate;
static atomic_bool hold_submit,entered,release_submit;
static esp_err_t submit_test(const cp_settings_t *c,const char *id,void *ctx){(void)ctx;assert(!strcmp(c->node_id,node));assert(cp_provision_uuid_v4(id));submitted_candidate=*c;submitted++;if(atomic_load(&hold_submit)){atomic_store(&entered,true);while(!atomic_load(&release_submit))sched_yield();}return ESP_OK;}
static cJSON *exchange(const char *body){uint8_t *out=NULL;size_t n=0;assert(cp_provision_usb_exchange((const uint8_t *)body,strlen(body),&out,&n)==ESP_OK);assert(out&&n>0&&n<=1536);cJSON *r=cJSON_ParseWithLength((char *)out,n);free(out);assert(r);return r;}
static void expect_reason(cJSON *r,const char *why){assert(cJSON_IsFalse(cJSON_GetObjectItem(r,"ok")));assert(!strcmp(str(r,"reason"),why));cJSON_Delete(r);}
static void safe_status(cJSON *r){assert(!cJSON_GetObjectItem(r,"nonce"));assert(!cJSON_GetObjectItem(r,"proof"));assert(!cJSON_GetObjectItem(r,"pin"));assert(!cJSON_GetObjectItem(r,"password"));assert(!cJSON_GetObjectItem(r,"device_token"));}
static void candidate(char out[1025],const char *n,const char *password){snprintf(out,1025,"{\"v\":1,\"op\":\"configure\",\"nonce\":\"%s\",\"node_id\":\"%s\",\"attempt_id\":\"11111111-2222-4333-8444-555555555555\",\"ssid\":\"test-network\",\"password\":\"%s\",\"device_token\":\"cpd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"mqtt\":" MQTT_JSON "}",n,node,password);}
static void *configure_thread(void *arg){cJSON *r=exchange(arg);assert(cJSON_IsTrue(cJSON_GetObjectItem(r,"ok")));cJSON_Delete(r);return NULL;}
static const char *saved_token="cpd_synthetic_saved_credential_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
static const char *boot="aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
static bool credential_available=true,saved_mqtt_available=true;
static uint32_t credential_generation=3;
static bool resolve_credential(const char *id,cp_settings_t *out,uint32_t *generation,void *context)
{
    assert(context==&credential_generation);
    if(!credential_available||strcmp(id,node))return false;
    if(out){memset(out,0,sizeof *out);snprintf(out->device_token,sizeof out->device_token,"%s",saved_token);if(saved_mqtt_available){strcpy(out->mqtt_uri,CP_MQTT_PRODUCTION_URI);strcpy(out->mqtt_username,"fixture_pool");strcpy(out->mqtt_password,"synthetic-mqtt-password");strcpy(out->mqtt_namespace,"fixture_pool");}}
    if(generation)*generation=credential_generation;return true;
}
static void new_usb_session(void)
{if(state.active)assert(cp_provision_stop()==ESP_OK);assert(cp_provision_start(CP_PROVISION_USB,node,master,submit_test,NULL)==ESP_OK);}
static cJSON *request(const char *security,const char *password)
{
    cJSON *r=cJSON_CreateObject();assert(r);
    cJSON_AddNumberToObject(r,"v",1);cJSON_AddStringToObject(r,"op","configure");cJSON_AddStringToObject(r,"nonce",nonce);
    cJSON_AddStringToObject(r,"node_id",node);cJSON_AddStringToObject(r,"attempt_id","11111111-2222-4333-8444-555555555555");
    cJSON_AddStringToObject(r,"ssid","synthetic-network");cJSON_AddStringToObject(r,"password",password);cJSON_AddStringToObject(r,"device_token",saved_token);
    cJSON_AddItemToObject(r,"mqtt",cJSON_Parse(MQTT_JSON));
    if(security)cJSON_AddStringToObject(r,"wifi_security",security);return r;
}
static cJSON *send_request(cJSON *request)
{char *encoded=cJSON_PrintUnformatted(request);assert(encoded);cJSON *r=exchange(encoded);free(encoded);cJSON_Delete(request);return r;}
static void accepted(cJSON *request)
{unsigned before=submitted;cJSON *r=send_request(request);assert(cJSON_IsTrue(cJSON_GetObjectItem(r,"ok")));safe_status(r);cJSON_Delete(r);assert(submitted==before+1);}
static void test_mqtt_candidates(void)
{
    new_usb_session();cJSON *q=request("wpa2","test-password");cJSON_DeleteItemFromObject(q,"mqtt");expect_reason(send_request(q),"mqtt_settings_required");
    q=request("wpa2","test-password");cJSON *m=cJSON_GetObjectItem(q,"mqtt");cJSON_AddStringToObject(m,"extra","no");expect_reason(send_request(q),"invalid_mqtt_settings");
    q=request("wpa2","test-password");m=cJSON_GetObjectItem(q,"mqtt");cJSON_ReplaceItemInObject(m,"namespace",cJSON_CreateString("bad/namespace"));expect_reason(send_request(q),"invalid_mqtt_settings");
    q=request("wpa2","test-password");m=cJSON_GetObjectItem(q,"mqtt");cJSON_ReplaceItemInObject(m,"uri",cJSON_CreateString("mqtts://evil.invalid:8883"));expect_reason(send_request(q),"invalid_mqtt_settings");
    q=request("wpa2","test-password");m=cJSON_GetObjectItem(q,"mqtt");cJSON_AddStringToObject(m,"password","duplicate");expect_reason(send_request(q),"invalid_json");
    saved_mqtt_available=false;q=request("wpa2","test-password");cJSON_DeleteItemFromObject(q,"device_token");cJSON_DeleteItemFromObject(q,"mqtt");cJSON_AddTrueToObject(q,"reuse_saved_credential");expect_reason(send_request(q),"mqtt_settings_required");
    q=request("wpa2","test-password");cJSON_DeleteItemFromObject(q,"device_token");cJSON_AddTrueToObject(q,"reuse_saved_credential");accepted(q);assert(!strcmp(submitted_candidate.device_token,saved_token));saved_mqtt_available=true;
    new_usb_session();accepted(request("wpa2","test-password"));q=request("wpa2","test-password");m=cJSON_GetObjectItem(q,"mqtt");cJSON_ReplaceItemInObject(m,"password",cJSON_CreateString("different-secret"));expect_reason(send_request(q),"attempt_payload_changed");
    assert(cp_provision_stop()==ESP_OK);
}
static cJSON *ble_request(cJSON *q)
{
    char *body=cJSON_PrintUnformatted(q);cJSON_Delete(q);assert(body&&strlen(body)<=496);uint8_t *out=NULL;ssize_t n=0;
    assert(app_handler(0,(uint8_t *)body,strlen(body),&out,&n,NULL)==ESP_OK);free(body);assert(out&&n>0&&n<=496);
    cJSON *r=cJSON_ParseWithLength((char *)out,(size_t)n);free(out);assert(r);return r;
}
static cJSON *chunk(const char *data,bool reset)
{cJSON *q=cJSON_CreateObject();cJSON_AddNumberToObject(q,"v",1);cJSON_AddStringToObject(q,"op","configure_chunk");cJSON_AddStringToObject(q,"data",data);if(reset)cJSON_AddTrueToObject(q,"reset");return q;}
static void test_ble_chunks(void)
{
    assert(cp_provision_start(CP_PROVISION_BLE,node,master,submit_test,NULL)==ESP_OK);
    cJSON *q=cJSON_CreateObject();cJSON_AddNumberToObject(q,"v",1);cJSON_AddStringToObject(q,"op","info");cJSON *r=ble_request(q);assert(cJSON_IsTrue(cJSON_GetObjectItem(r,"mqtt_required"))&&cJSON_IsTrue(cJSON_GetObjectItem(r,"has_saved_mqtt")));safe_status(r);cJSON_Delete(r);
    expect_reason(ble_request(chunk("{}",false)),"chunk_reset_required");
    q=request("enterprise","");cJSON_AddStringToObject(q,"eap_username","synthetic-enterprise-username");cJSON_AddStringToObject(q,"eap_password","synthetic-enterprise-password");
    char *body=cJSON_PrintUnformatted(q);cJSON_Delete(q);assert(body&&strlen(body)>496);size_t total=strlen(body);
    unsigned before=submitted;
    for(size_t offset=0;offset<total;){char fragment[201];size_t n=total-offset;if(n>200)n=200;memcpy(fragment,body+offset,n);fragment[n]=0;
        r=ble_request(chunk(fragment,offset==0));assert(cJSON_IsTrue(cJSON_GetObjectItem(r,"ok"))&&cJSON_GetObjectItem(r,"received_bytes")->valueint==(int)(offset+n));cJSON_Delete(r);offset+=n;}
    free(body);assert(submitted==before);
    q=cJSON_CreateObject();cJSON_AddNumberToObject(q,"v",1);cJSON_AddStringToObject(q,"op","configure_commit");r=ble_request(q);assert(cJSON_IsTrue(cJSON_GetObjectItem(r,"ok")));safe_status(r);cJSON_Delete(r);
    assert(submitted==before+1&&!chunk_json&&!strcmp(submitted_candidate.mqtt_namespace,"fixture_pool"));
    for(unsigned i=0;i<8;++i){char fragment[201];memset(fragment,'a',200);fragment[200]=0;r=ble_request(chunk(fragment,i==0));if(i<7){assert(cJSON_IsTrue(cJSON_GetObjectItem(r,"ok")));cJSON_Delete(r);}else expect_reason(r,"settings_too_large");}
    assert(!chunk_json);r=ble_request(chunk("{",true));cJSON_Delete(r);assert(chunk_json);assert(cp_provision_stop()==ESP_OK&&!chunk_json);
}
static void test_network_and_context(void)
{
    assert(cp_provision_bind_context(node,boot,7,resolve_credential,&credential_generation)==ESP_OK);
    assert(cp_provision_bind_context(node,"not-a-uuid",7,resolve_credential,&credential_generation)==ESP_ERR_INVALID_ARG);
    new_usb_session();assert(cp_provision_bind_context(node,boot,7,resolve_credential,&credential_generation)==ESP_ERR_INVALID_STATE);
    cJSON *r=exchange("{\"v\":1,\"op\":\"info\"}");assert(!strcmp(str(r,"boot_id"),boot));assert(cJSON_GetObjectItem(r,"wifi_modes")->valueint==7);assert(cJSON_IsTrue(cJSON_GetObjectItem(r,"has_saved_credential")));cJSON_Delete(r);
    expect_reason(send_request(request("open","nonempty")),"invalid_settings");
    cJSON *q=request("open","");cJSON_AddStringToObject(q,"eap_username","synthetic-user");expect_reason(send_request(q),"invalid_wifi_security");
    expect_reason(send_request(request("unknown","test-password")),"invalid_wifi_security");
    q=request(NULL,"test-password");cJSON_AddNumberToObject(q,"wifi_security",1);expect_reason(send_request(q),"invalid_wifi_security");
    accepted(request("open",""));assert(submitted_candidate.wifi_security==CP_WIFI_OPEN&&!submitted_candidate.password[0]&&!submitted_candidate.eap_username[0]);
    new_usb_session();expect_reason(send_request(request("enterprise","")),"invalid_enterprise_settings");
    q=request("enterprise","");cJSON_AddStringToObject(q,"eap_username","synthetic-user");cJSON_AddStringToObject(q,"eap_password","");expect_reason(send_request(q),"invalid_settings");
    q=request("enterprise","");cJSON_AddStringToObject(q,"eap_username","synthetic-user");cJSON_AddStringToObject(q,"eap_password","synthetic-eap-password");accepted(q);
    assert(submitted_candidate.wifi_security==CP_WIFI_ENTERPRISE_PEAP&&!strcmp(submitted_candidate.eap_identity,"synthetic-user")&&!submitted_candidate.password[0]);
    new_usb_session();q=request("enterprise","");cJSON_AddStringToObject(q,"eap_username","synthetic-user");cJSON_AddStringToObject(q,"eap_identity","synthetic-outer");cJSON_AddStringToObject(q,"eap_password","synthetic-eap-password");accepted(q);assert(!strcmp(submitted_candidate.eap_identity,"synthetic-outer"));
    new_usb_session();q=request("wpa2","test-password");cJSON_AddTrueToObject(q,"reuse_saved_credential");expect_reason(send_request(q),"invalid_credential_mode");
    q=request("wpa2","test-password");cJSON_DeleteItemFromObject(q,"device_token");cJSON_AddFalseToObject(q,"reuse_saved_credential");expect_reason(send_request(q),"invalid_credential_mode");
    credential_available=false;q=request("wpa2","test-password");cJSON_DeleteItemFromObject(q,"device_token");cJSON_AddTrueToObject(q,"reuse_saved_credential");expect_reason(send_request(q),"saved_credential_unavailable");
    credential_available=true;q=request("wpa2","test-password");cJSON_DeleteItemFromObject(q,"device_token");cJSON_AddTrueToObject(q,"reuse_saved_credential");cJSON_DeleteItemFromObject(q,"mqtt");accepted(q);assert(!strcmp(submitted_candidate.device_token,saved_token)&&!strcmp(submitted_candidate.mqtt_password,"synthetic-mqtt-password"));
    q=request("wpa2","test-password");expect_reason(send_request(q),"attempt_payload_changed");
    credential_generation++;q=request("wpa2","test-password");cJSON_DeleteItemFromObject(q,"device_token");cJSON_AddTrueToObject(q,"reuse_saved_credential");expect_reason(send_request(q),"attempt_payload_changed");
    assert(cp_provision_stop()==ESP_OK);
    cp_network_diagnostic_t d={0};cp_network_diag_update(&d,CP_DIAG_TLS,CP_DIAG_TLS_CERTIFICATE_FAILED,ESP_FAIL,4100,true,true);d.tls_code=-123;d.tls_flags=8;
    cp_network_attempt_t old={.version=1,.state=CP_ATTEMPT_FAILED,.diagnostic=d};strcpy(old.attempt_id,"11111111-2222-4333-8444-555555555555");strcpy(old.boot_id,boot);
    cp_provision_set_diagnostic(&d,old.attempt_id);cp_provision_set_previous_attempt(&old,ESP_FAIL);
    r=exchange("{\"v\":1,\"op\":\"status\"}");safe_status(r);assert(!strcmp(str(r,"boot_id"),boot));assert(cJSON_GetObjectItem(r,"reset_reason")->valueint==7);assert(cJSON_GetObjectItem(r,"history_error")->valueint==ESP_FAIL);
    cJSON *detail=cJSON_GetObjectItem(r,"diagnostic"),*previous=cJSON_GetObjectItem(r,"previous_attempt");assert(!strcmp(str(detail,"code"),"tls_certificate_failed")&&cJSON_GetObjectItem(detail,"tls_code")->valueint==-123);assert(previous&&!strcmp(str(previous,"state"),"failed"));
    char *encoded=cJSON_PrintUnformatted(r);assert(encoded&&!strstr(encoded,saved_token)&&!strstr(encoded,"synthetic-eap-password")&&!strstr(encoded,"synthetic-user"));free(encoded);cJSON_Delete(r);
    old.version=99;cp_provision_set_previous_attempt(&old,ESP_OK);r=exchange("{\"v\":1,\"op\":\"status\"}");assert(!cJSON_GetObjectItem(r,"previous_attempt"));cJSON_Delete(r);
}
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
    test_network_and_context();test_mqtt_candidates();test_ble_chunks();
    puts("Actual provisioning module: USB guards/concurrency, expiry/lock, open/PEAP validation, saved credential mode/generation, boot context, MQTT migration, BLE chunks and safe retained diagnostics passed.");return 0;
}
