#include "cp_provision.h"
#include "cp_provision_guard.h"
#include "sdkconfig.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "esp_app_desc.h"
#include "cJSON.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <ctype.h>

#define REQUEST_MAX 1536
#define SESSION_US (5LL * 60 * 1000000)
static cp_provision_snapshot_t state;
static portMUX_TYPE lock = portMUX_INITIALIZER_UNLOCKED;
static SemaphoreHandle_t session_mutex;
static cp_provision_submit_fn submit_fn;
static void *submit_ctx;
static char nonce[33];
static int64_t expires;
static uint32_t session_sequence;
static uint8_t attempt_digest[32];
static char diagnostic_boot_id[37],diagnostic_attempt_id[37];
static uint32_t diagnostic_reset_reason;
static cp_network_diagnostic_t diagnostic;
static cp_network_attempt_t previous_attempt;
static bool have_previous_attempt;
static esp_err_t diagnostic_history_error;
static cp_provision_credential_resolver_fn credential_resolver;
static void *credential_context;
static char board_description[50]="unbound";
static const char *str(const cJSON *obj, const char *key) {
    const cJSON *item = cJSON_GetObjectItemCaseSensitive(obj, key);
    return cJSON_IsString(item) ? item->valuestring : NULL;
}
static bool same(const char *a, const char *b) {
    if (!a || !b || strlen(a) != strlen(b)) return false;
    unsigned diff = 0; for (size_t i = 0; a[i]; i++) diff |= (unsigned char)a[i] ^ (unsigned char)b[i]; return diff == 0;
}
static void wipe(void *p, size_t n) { volatile unsigned char *v = p; while (n--) *v++ = 0; }
static bool take_session(void) {
    SemaphoreHandle_t mutex=__atomic_load_n(&session_mutex,__ATOMIC_ACQUIRE);
    if(!mutex) {
        SemaphoreHandle_t created=xSemaphoreCreateMutex();if(!created)return false;
        SemaphoreHandle_t expected=NULL;
        if(!__atomic_compare_exchange_n(&session_mutex,&expected,created,false,__ATOMIC_ACQ_REL,__ATOMIC_ACQUIRE))vSemaphoreDelete(created);
        mutex=__atomic_load_n(&session_mutex,__ATOMIC_ACQUIRE);
    }
    return xSemaphoreTake(mutex,0)==pdTRUE;
}
static void give_session(void){xSemaphoreGive(session_mutex);}
static bool session_allowed(void) {
    if(!state.active)return false;
    if(esp_timer_get_time()>=expires) {
        cp_provision_set_status("expired","Start a new USB setup session");
        return false;
    }
    return true;
}
void cp_provision_snapshot(cp_provision_snapshot_t *out) {
    if(!out)return;
    if(take_session()){(void)session_allowed();give_session();}
    portENTER_CRITICAL(&lock);*out=state;portEXIT_CRITICAL(&lock);
}
void cp_provision_set_status(const char *value, const char *reason) { portENTER_CRITICAL(&lock); snprintf(state.state, sizeof(state.state), "%s", value ? value : "unknown"); snprintf(state.reason, sizeof(state.reason), "%s", reason ? reason : ""); portEXIT_CRITICAL(&lock); }
static bool board_token(const char *value) {
    if(!value)return false;
    size_t length=strnlen(value,24);if(!length||length>=24)return false;
    for(size_t i=0;i<length;i++)if(!((value[i]>='a'&&value[i]<='z')||
        (value[i]>='0'&&value[i]<='9')||value[i]=='_'||value[i]=='-'))return false;
    return true;
}
esp_err_t cp_provision_bind_board(const char *board_id,const char *target_chip) {
    if(!board_token(board_id)||!board_token(target_chip))return ESP_ERR_INVALID_ARG;
    if(!take_session())return ESP_ERR_INVALID_STATE;
    if(state.active){give_session();return ESP_ERR_INVALID_STATE;}
    snprintf(board_description,sizeof board_description,"%s / %s",board_id,target_chip);
    give_session();return ESP_OK;
}
esp_err_t cp_provision_bind_context(const char *node,const char *boot,uint32_t reset,
    cp_provision_credential_resolver_fn resolver,void *context) {
    if(!node||strlen(node)!=15||strncmp(node,"cp_",3)||!cp_provision_uuid_v4(boot))return ESP_ERR_INVALID_ARG;
    if(!take_session())return ESP_ERR_INVALID_STATE;
    if(state.active){give_session();return ESP_ERR_INVALID_STATE;}
    portENTER_CRITICAL(&lock);snprintf(state.node_id,sizeof state.node_id,"%s",node);
    snprintf(diagnostic_boot_id,sizeof diagnostic_boot_id,"%s",boot);diagnostic_reset_reason=reset;
    if(!state.state[0])snprintf(state.state,sizeof state.state,"idle");
    portEXIT_CRITICAL(&lock);
    credential_resolver=resolver;credential_context=context;give_session();return ESP_OK;
}
void cp_provision_set_diagnostic(const cp_network_diagnostic_t *value,const char *attempt) {
    if(!cp_network_diag_valid(value)||(attempt&&!cp_provision_uuid_v4(attempt)))return;
    portENTER_CRITICAL(&lock);diagnostic=*value;
    if(attempt)memcpy(diagnostic_attempt_id,attempt,37);
    portEXIT_CRITICAL(&lock);
}
void cp_provision_set_previous_attempt(const cp_network_attempt_t *value,esp_err_t history_error) {
    bool valid=cp_network_attempt_valid(value);
    portENTER_CRITICAL(&lock);have_previous_attempt=valid;
    if(valid)previous_attempt=*value;else memset(&previous_attempt,0,sizeof previous_attempt);
    diagnostic_history_error=history_error;portEXIT_CRITICAL(&lock);
}
static bool saved_credential(const char *node,cp_settings_t *saved,uint32_t *generation) {
    return credential_resolver&&credential_resolver(node,saved,generation,credential_context);
}
static cJSON *diagnostic_json(const cp_network_diagnostic_t *d) {
    cJSON *o=cJSON_CreateObject();if(!o)return NULL;
    bool ok=cJSON_AddStringToObject(o,"stage",cp_network_diag_stage_name(d->stage)) &&
        cJSON_AddStringToObject(o,"code",cp_network_diag_code_name(d->code)) &&
        cJSON_AddNumberToObject(o,"esp_err",d->esp_err) && cJSON_AddNumberToObject(o,"http_status",d->http_status) &&
        cJSON_AddNumberToObject(o,"wifi_reason",d->wifi_reason) && cJSON_AddNumberToObject(o,"tls_code",d->tls_code) &&
        cJSON_AddNumberToObject(o,"tls_flags",d->tls_flags) && cJSON_AddNumberToObject(o,"elapsed_ms",d->elapsed_ms) &&
        cJSON_AddBoolToObject(o,"retryable",d->retryable!=0);
    if(!ok){cJSON_Delete(o);return NULL;}return o;
}
static bool copy_field(char *dest, size_t cap, const cJSON *obj, const char *key) { const char *v = str(obj, key); if (!v || strlen(v) >= cap) return false; memcpy(dest, v, strlen(v) + 1); return true; }
static cJSON *parse_request(const char *data, size_t len) {
    /* Only mqtt may contain a second-level scalar object. */
    unsigned depth = 0; bool quoted = false, escaped = false;
    for (size_t i = 0; i < len; i++) {
        unsigned char ch = data[i]; if (!ch) return NULL;
        if (quoted) { if (escaped) { if(ch=='u'&&i+4<len&&!memcmp(data+i+1,"0000",4))return NULL; escaped = false; } else if (ch == 92) escaped = true; else if (ch == 34) quoted = false; }
        else if (ch == 34) quoted = true;
        else if (ch == '{' || ch == '[') { if (++depth > 2) return NULL; }
        else if (ch == '}' || ch == ']') { if (!depth) return NULL; --depth; }
    }
    if (quoted || depth) return NULL;
    const char *end = NULL; cJSON *r = cJSON_ParseWithLengthOpts(data, len, &end, false);
    while (end && end < data + len && isspace((unsigned char)*end)) ++end;
    if (!cJSON_IsObject(r) || end != data + len) { cJSON_Delete(r); return NULL; }
    for(cJSON *a=r->child;a;a=a->next){
        if(cJSON_IsArray(a)||(cJSON_IsObject(a)&&strcmp(a->string,"mqtt"))){cJSON_Delete(r);return NULL;}
        if(cJSON_IsObject(a))for(cJSON *m=a->child;m;m=m->next){
            if(!cJSON_IsString(m)){cJSON_Delete(r);return NULL;}
            for(cJSON *b=m->next;b;b=b->next)if(!strcmp(m->string,b->string)){cJSON_Delete(r);return NULL;}
        }
        for(cJSON *b=a->next;b;b=b->next)if(!strcmp(a->string,b->string)){cJSON_Delete(r);return NULL;}
    }
    return r;
}
static void delete_request(cJSON *request) {
    for(cJSON *v=request?request->child:NULL;v;v=v->next){
        if(cJSON_IsString(v))wipe(v->valuestring,strlen(v->valuestring));
        else if(cJSON_IsObject(v))for(cJSON *m=v->child;m;m=m->next)
            if(cJSON_IsString(m))wipe(m->valuestring,strlen(m->valuestring));
    }
    cJSON_Delete(request);
}
static cJSON *reply(bool ok, const char *reason) { cJSON *r = cJSON_CreateObject(); if (!r) return NULL; cJSON_AddNumberToObject(r, "v", 1); cJSON_AddBoolToObject(r, "ok", ok); if (reason) cJSON_AddStringToObject(r, "reason", reason); return r; }
/* Keep large settings snapshots out of the USB dispatch/commit stack frame. */
static __attribute__((noinline)) cJSON *handle_info(const cJSON *request,cp_provision_mode_t transport) {
    const char *op=str(request,"op");
        cp_provision_snapshot_t snapshot;cp_network_diagnostic_t current;
        cp_network_attempt_t previous;bool have_previous;char boot[37],attempt[37];uint32_t reset;esp_err_t history;
        portENTER_CRITICAL(&lock);snapshot=state;current=diagnostic;previous=previous_attempt;have_previous=have_previous_attempt;
        memcpy(boot,diagnostic_boot_id,sizeof boot);memcpy(attempt,diagnostic_attempt_id,sizeof attempt);
        reset=diagnostic_reset_reason;history=diagnostic_history_error;portEXIT_CRITICAL(&lock);
        cJSON *r=reply(true,NULL);if(!r)return NULL;
        cp_settings_t saved={0};bool has_saved=saved_credential(snapshot.node_id,&saved,NULL);
        bool has_saved_mqtt=has_saved&&cp_settings_mqtt_ready(&saved);cp_settings_clear_sensitive(&saved);
        bool ok=cJSON_AddStringToObject(r,"node_id",snapshot.node_id)&&cJSON_AddStringToObject(r,"boot_id",boot)&&
            cJSON_AddStringToObject(r,"state",snapshot.state)&&cJSON_AddBoolToObject(r,"active",snapshot.active)&&
            cJSON_AddBoolToObject(r,"has_saved_credential",has_saved)&&
            cJSON_AddBoolToObject(r,"has_saved_mqtt",has_saved_mqtt)&&
            cJSON_AddNumberToObject(r,"uptime_ms",(double)(esp_timer_get_time()/1000))&&cJSON_AddNumberToObject(r,"reset_reason",reset);
        if(!strcmp(op,"info")) {
#if CONFIG_CP_NETWORK_MQTT_NATIVE_TLS
            ok=ok&&cJSON_AddBoolToObject(r,"mqtt_required",true);
#else
            ok=ok&&cJSON_AddBoolToObject(r,"mqtt_required",false);
#endif
            ok=ok&&cJSON_AddStringToObject(r,"board",board_description)&&
                cJSON_AddStringToObject(r,"firmware_version",esp_app_get_description()->version)&&cJSON_AddNumberToObject(r,"wifi_modes",7)&&
                cJSON_AddStringToObject(r,"transport","usb")&&
                cJSON_AddStringToObject(r,"security","physical-usb");
            if(transport==CP_PROVISION_USB)ok=ok&&cJSON_AddStringToObject(r,"nonce",nonce)&&
                cJSON_AddStringToObject(r,"mqtt_uri",CP_MQTT_PRODUCTION_URI)&&
                cJSON_AddStringToObject(r,"mqtt_ca_profile",CP_MQTT_CA_PROFILE);
            int64_t left=expires-esp_timer_get_time();ok=ok&&cJSON_AddNumberToObject(r,"session_expires_in_ms",left>0?left/1000:0);
        } else {
            ok=ok&&cJSON_AddStringToObject(r,"attempt_id",snapshot.attempt_id[0]?snapshot.attempt_id:attempt);
            if(current.stage==CP_DIAG_IDLE)ok=ok&&cJSON_AddStringToObject(r,"reason",snapshot.reason);
            cJSON *d=diagnostic_json(&current);
            if(!d||!cJSON_AddItemToObject(r,"diagnostic",d)){cJSON_Delete(d);ok=false;}
            /* Full previous-boot evidence is available on physical USB. */
            if(transport==CP_PROVISION_USB) {
                ok=ok&&cJSON_AddNumberToObject(r,"history_error",history);
                if(have_previous) {
                    cJSON *old=cJSON_CreateObject(),*detail=diagnostic_json(&previous.diagnostic);
                    bool old_ok=old&&detail&&cJSON_AddStringToObject(old,"attempt_id",previous.attempt_id)&&
                        cJSON_AddStringToObject(old,"boot_id",previous.boot_id)&&
                        cJSON_AddStringToObject(old,"state",previous.state==CP_ATTEMPT_SAVED?"saved":previous.state==CP_ATTEMPT_FAILED?"failed":"interrupted");
                    if(old_ok)old_ok=cJSON_AddItemToObject(old,"diagnostic",detail);
                    if(!old_ok){cJSON_Delete(detail);cJSON_Delete(old);ok=false;}
                    else if(!cJSON_AddItemToObject(r,"previous_attempt",old)){cJSON_Delete(old);ok=false;}
                }
            }
        }
        if(!ok){cJSON_Delete(r);return NULL;}return r;
}
static __attribute__((noinline)) cJSON *handle_configure(const cJSON *request,cp_provision_mode_t transport) {
    const char *op=str(request,"op");
    if(transport==CP_PROVISION_USB&&!same(str(request,"nonce"),nonce))return reply(false,"invalid_session_nonce");
    if (strcmp(op, "configure")) return reply(false, "invalid_operation");
    const char *attempt = str(request, "attempt_id");
    if (!cp_provision_uuid_v4(attempt)) return reply(false, "invalid_attempt_id");
    const cJSON *reuse_field=cJSON_GetObjectItemCaseSensitive(request,"reuse_saved_credential");
    bool reuse=cJSON_IsTrue(reuse_field);
    if((reuse_field&&!reuse)||(reuse&&cJSON_GetObjectItemCaseSensitive(request,"device_token")))return reply(false,"invalid_credential_mode");
    for(const cJSON *field=request->child;field;field=field->next) {
        const char *allowed[]={"v","op","nonce","node_id","attempt_id","ssid","password","device_token","reuse_saved_credential","wifi_security","eap_username","eap_identity","eap_password","mqtt"};bool known=false;
        for(unsigned i=0;i<sizeof allowed/sizeof allowed[0];++i)if(!strcmp(field->string,allowed[i]))known=true;
        if(!known)return reply(false,"invalid_settings");
    }
    cp_settings_t candidate = { .version = CP_SETTINGS_VERSION };
    snprintf(candidate.node_id, sizeof(candidate.node_id), "%s", state.node_id);
    snprintf(candidate.api_origin, sizeof(candidate.api_origin), "%s", CP_API_ORIGIN);
    const char *security=str(request,"wifi_security");
    if(!security) {
        if(cJSON_GetObjectItemCaseSensitive(request,"wifi_security"))return reply(false,"invalid_wifi_security");
        security="wpa2";
    }
    if(!strcmp(security,"open"))candidate.wifi_security=CP_WIFI_OPEN;
    else if(!strcmp(security,"enterprise"))candidate.wifi_security=CP_WIFI_ENTERPRISE_PEAP;
    else if(strcmp(security,"wpa2"))return reply(false,"invalid_wifi_security");
    if(candidate.wifi_security==CP_WIFI_ENTERPRISE_PEAP) {
        if(!copy_field(candidate.eap_username,sizeof candidate.eap_username,request,"eap_username")||
           !copy_field(candidate.eap_password,sizeof candidate.eap_password,request,"eap_password")) {
            wipe(&candidate,sizeof candidate);return reply(false,"invalid_enterprise_settings");
        }
        if(cJSON_GetObjectItemCaseSensitive(request,"eap_identity")) {
            if(!copy_field(candidate.eap_identity,sizeof candidate.eap_identity,request,"eap_identity")){wipe(&candidate,sizeof candidate);return reply(false,"invalid_enterprise_settings");}
        } else memcpy(candidate.eap_identity,candidate.eap_username,sizeof candidate.eap_identity);
    } else if(cJSON_GetObjectItemCaseSensitive(request,"eap_username")||cJSON_GetObjectItemCaseSensitive(request,"eap_password")||cJSON_GetObjectItemCaseSensitive(request,"eap_identity"))return reply(false,"invalid_wifi_security");
    uint32_t saved_generation=0;
    cp_settings_t saved={0};bool credential_ok=reuse?saved_credential(state.node_id,&saved,&saved_generation):
        copy_field(candidate.device_token,sizeof candidate.device_token,request,"device_token");
    if(reuse&&credential_ok){
        memcpy(candidate.device_token,saved.device_token,sizeof candidate.device_token);
        memcpy(candidate.mqtt_uri,saved.mqtt_uri,sizeof candidate.mqtt_uri);
        memcpy(candidate.mqtt_username,saved.mqtt_username,sizeof candidate.mqtt_username);
        memcpy(candidate.mqtt_password,saved.mqtt_password,sizeof candidate.mqtt_password);
        memcpy(candidate.mqtt_namespace,saved.mqtt_namespace,sizeof candidate.mqtt_namespace);
    }
    cp_settings_clear_sensitive(&saved);
    if(reuse&&!credential_ok){wipe(&candidate,sizeof candidate);return reply(false,"saved_credential_unavailable");}
    const cJSON *mqtt=cJSON_GetObjectItemCaseSensitive(request,"mqtt");
    if(mqtt){
        unsigned count=0;bool valid=cJSON_IsObject(mqtt);
        for(const cJSON *f=mqtt->child;valid&&f;f=f->next){++count;
            if(strcmp(f->string,"uri")&&strcmp(f->string,"username")&&strcmp(f->string,"password")&&strcmp(f->string,"namespace"))valid=false;
        }
        valid=valid&&count==4&&copy_field(candidate.mqtt_uri,sizeof candidate.mqtt_uri,mqtt,"uri")&&
            copy_field(candidate.mqtt_username,sizeof candidate.mqtt_username,mqtt,"username")&&
            copy_field(candidate.mqtt_password,sizeof candidate.mqtt_password,mqtt,"password")&&
            copy_field(candidate.mqtt_namespace,sizeof candidate.mqtt_namespace,mqtt,"namespace")&&cp_settings_mqtt_ready(&candidate);
        if(!valid){wipe(&candidate,sizeof candidate);return reply(false,"invalid_mqtt_settings");}
    }
#if CONFIG_CP_NETWORK_MQTT_NATIVE_TLS
    if(!cp_settings_mqtt_ready(&candidate)){wipe(&candidate,sizeof candidate);return reply(false,"mqtt_settings_required");}
#endif
    if (!copy_field(candidate.ssid, sizeof(candidate.ssid), request, "ssid") ||
        !copy_field(candidate.password, sizeof(candidate.password), request, "password") ||
        !credential_ok ||
        !same(str(request, "node_id"), state.node_id) || !cp_settings_validate(&candidate)) {
        wipe(&candidate, sizeof(candidate)); return reply(false, "invalid_settings");
    }
    uint8_t digest[32];
    if (!cp_provision_candidate_digest(&candidate,reuse,saved_generation,digest)) { wipe(&candidate, sizeof(candidate)); return reply(false, "settings_hash_failed"); }
    if (state.attempt_id[0]) {
        bool same_id = !strcmp(attempt, state.attempt_id);
        bool same_body = cp_provision_digest_equal(attempt_digest, digest);
        wipe(&candidate, sizeof(candidate)); wipe(digest, sizeof(digest));
        if (!same_id) return reply(false, "attempt_in_progress");
        if (!same_body) return reply(false, "attempt_payload_changed");
        cJSON *r = reply(true, NULL); if (!r) return NULL;
        char status[24];portENTER_CRITICAL(&lock);memcpy(status,state.state,sizeof status);portEXIT_CRITICAL(&lock);
        cJSON_AddStringToObject(r,"state",status);cJSON_AddStringToObject(r,"attempt_id",attempt);return r;
    }
    esp_err_t err = submit_fn(&candidate, attempt, submit_ctx); wipe(&candidate, sizeof(candidate));
    if (err != ESP_OK) { wipe(digest, sizeof(digest)); return reply(false, "supervisor_busy"); }
    memcpy(attempt_digest, digest, sizeof(attempt_digest)); wipe(digest, sizeof(digest));
    portENTER_CRITICAL(&lock); snprintf(state.attempt_id, sizeof(state.attempt_id), "%s", attempt); snprintf(state.state, sizeof(state.state), "received"); portEXIT_CRITICAL(&lock);
    cJSON *r = reply(true, NULL); cJSON_AddStringToObject(r, "state", "received"); cJSON_AddStringToObject(r, "attempt_id", attempt); return r;
}
/* Requests arrive only through physical USB. Never return/log secrets. */
static cJSON *handle(const cJSON *request, cp_provision_mode_t transport) {
    const cJSON *version=cJSON_GetObjectItemCaseSensitive(request,"v");
    if(!cJSON_IsNumber(version)||version->valuedouble!=1)return reply(false,"unsupported_version");
    const char *op=str(request,"op");if(!op)return reply(false,"invalid_operation");
    /* Physical USB status is intentionally available after radio handoff. */
    bool usb_status=transport==CP_PROVISION_USB&&!strcmp(op,"status");
    if(usb_status&&state.active)(void)session_allowed();
    if(!usb_status && (!state.active||state.mode!=transport))return reply(false,"setup_not_ready");
    if(!usb_status && !session_allowed())return reply(false,"setup_expired");
    if(!strcmp(op,"info")||!strcmp(op,"status"))return handle_info(request,transport);
    return handle_configure(request,transport);
}
esp_err_t cp_provision_usb_exchange(const uint8_t *request,size_t length,uint8_t **response,size_t *response_length) {
    if(!response||!response_length)return ESP_ERR_INVALID_ARG;
    *response=NULL;*response_length=0;
    if(!request||!length||length>REQUEST_MAX)return ESP_ERR_INVALID_SIZE;
    cJSON *object=parse_request((const char *)request,length),*result;
    if(!object)result=reply(false,"invalid_json");
    else if(!take_session())result=reply(false,"session_busy");
    else {result=handle(object,CP_PROVISION_USB);give_session();}
    delete_request(object);char *encoded=result?cJSON_PrintUnformatted(result):NULL;cJSON_Delete(result);
    if(!encoded)return ESP_ERR_NO_MEM;
    *response=(uint8_t *)encoded;*response_length=strlen(encoded);return ESP_OK;
}
esp_err_t cp_provision_start(cp_provision_mode_t mode,const char *node,const char *master,cp_provision_submit_fn submit,void *ctx) {
    if(!node||strlen(node)!=15||strncmp(node,"cp_",3)||!master||strlen(master)!=32||!submit||mode<CP_PROVISION_BLE||mode>CP_PROVISION_USB)return ESP_ERR_INVALID_ARG;
    if(mode!=CP_PROVISION_USB)return ESP_ERR_NOT_SUPPORTED;
    for(unsigned i=3;i<15;i++)if(!((node[i]>='0'&&node[i]<='9')||(node[i]>='a'&&node[i]<='f')))return ESP_ERR_INVALID_ARG;
    if(!take_session())return ESP_ERR_INVALID_STATE;
    if(state.active){give_session();return ESP_ERR_INVALID_STATE;}
    cp_provision_snapshot_t next={.active=true,.mode=mode};snprintf(next.node_id,sizeof next.node_id,"%s",node);
    uint8_t context[44];esp_fill_random(context,32);uint64_t now=(uint64_t)esp_timer_get_time();uint32_t seq=++session_sequence;
    for(unsigned i=0;i<8;i++)context[32+i]=(uint8_t)(now>>(56-8*i));
    for(unsigned i=0;i<4;i++)context[40+i]=(uint8_t)(seq>>(24-8*i));
    bool derived=cp_provision_session_nonce(master,context,sizeof context,nonce);wipe(context,sizeof context);wipe(attempt_digest,sizeof attempt_digest);
    if(!derived){give_session();return ESP_FAIL;}
    snprintf(next.state,sizeof next.state,"waiting");portENTER_CRITICAL(&lock);state=next;portEXIT_CRITICAL(&lock);wipe(&next,sizeof next);
    submit_fn=submit;submit_ctx=ctx;expires=esp_timer_get_time()+SESSION_US;
    give_session();return ESP_OK;
}
static esp_err_t stop_locked(void) {
    portENTER_CRITICAL(&lock); state.active = false; portEXIT_CRITICAL(&lock);
    wipe(nonce,sizeof nonce);
    return ESP_OK;
}

esp_err_t cp_provision_stop(void){if(!take_session())return ESP_ERR_INVALID_STATE;esp_err_t err=stop_locked();give_session();return err;}
