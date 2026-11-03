#include "trial_bootstrap.h"
#include "cp_v3_transport.h"
#include "cp_v3_saved_credentials.h"
#include "cJSON.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <math.h>
#ifdef CP_V3_BOOTSTRAP_CONTINUOUS
#include "esp_heap_caps.h"
#include "cp_v3_startup.h"
static bool public_key_decode(const char *text,uint8_t out[91]) {
    if(!text||strlen(text)!=122)return false;
    uint32_t acc=0;unsigned bits=0;size_t used=0;
    for(size_t i=0;i<122;i++){
        unsigned char c=(unsigned char)text[i];int d=c>='A'&&c<='Z'?c-'A':c>='a'&&c<='z'?c-'a'+26:c>='0'&&c<='9'?c-'0'+52:c=='-'?62:c=='_'?63:-1;
        if(d<0)return false;
        acc=(acc<<6)|(unsigned)d;bits+=6;
        if(bits>=8){bits-=8;if(used>=91)return false;out[used++]=(uint8_t)(acc>>bits);}
    }
    return used==91&&bits==4&&(acc&15u)==0;
}
#endif

static void wipe(void *data, size_t size) {
    volatile unsigned char *p = data; while (size--) *p++ = 0;
}
static bool hello_id(const char *value){if(strlen(value)!=32)return false;for(unsigned i=0;i<32;++i)if(!((value[i]>='0'&&value[i]<='9')||(value[i]>='a'&&value[i]<='f')))return false;return true;}
void trial_bootstrap_clear(trial_bootstrap_t *out) { if (out) wipe(out, sizeof *out); }
static bool text(cJSON *root, const char *key, char *out, size_t cap, bool empty) {
    cJSON *v = cJSON_GetObjectItemCaseSensitive(root, key);
    if (!cJSON_IsString(v) || !v->valuestring) return false;
    size_t n = strlen(v->valuestring);
    if (n >= cap || (!empty && !n)) return false;
    for (size_t i = 0; i < n; ++i) if ((unsigned char)v->valuestring[i] < 32 || (unsigned char)v->valuestring[i] > 126) return false;
    memcpy(out, v->valuestring, n + 1); return true;
}
static bool integer(cJSON *root, const char *key, double min, double max, uint64_t *out) {
    cJSON *v = cJSON_GetObjectItemCaseSensitive(root, key);
    if (!cJSON_IsNumber(v) || !isfinite(v->valuedouble) || v->valuedouble < min || v->valuedouble > max || floor(v->valuedouble) != v->valuedouble) return false;
    *out = (uint64_t)v->valuedouble; return true;
}
static bool parse_with_credentials(const char *json, const char *node, const char *boot, const cp_settings_t *saved, trial_bootstrap_t *out) {
    trial_bootstrap_clear(out);
    if(!json||!node||!boot||!out)return false;
    size_t wire_length=strlen(json);
#ifdef CP_V3_BOOTSTRAP_CONTINUOUS
    if(wire_length>8191u-8u)return false;
#else
    if(wire_length>4095u-8u)return false;
#endif
    for(size_t i=0;i<wire_length;i++)if((unsigned char)json[i]<32||(unsigned char)json[i]>126)return false;
    /* cJSON strings do not expose decoded lengths. Reject active NUL escapes
     * before parsing, while retaining a literal escaped backslash + u0000. */
    for(size_t i=0;i<wire_length;i++)if(json[i]=='\\'){
        if(++i>=wire_length)return false;
        if(json[i]=='u'&&wire_length-i>4&&!memcmp(json+i+1,"0000",4))return false;
    }
    const char *end = NULL;
    cJSON *root = cJSON_ParseWithOpts(json, &end, true);
    bool ok = cJSON_IsObject(root), seen[29] = {0};
    static const char *keys[] = {"node_id","boot_id","origin","device_token","ssid","password","utc_ms","uncertainty_ms","max_windows","security","anchor_mono_ms","uplink_transport",
        "eap_username","eap_identity","eap_password","eap_ca_pem","eap_domain","eap_server_verification"
#ifdef CP_V3_BOOTSTRAP_CONTINUOUS
        ,"server_ca_pem","mqtt_uri","mqtt_username","mqtt_password","mqtt_namespace",
        "save_startup","startup_reconfigure","clock_key_id","clock_public_spki","reuse_saved_credential","reuse_saved_mqtt"
#endif
    };
    const unsigned key_count=sizeof keys/sizeof keys[0];
    for (cJSON *v = ok ? root->child : NULL; v; v = v->next) {
        if (!v->string) { ok=false; break; }
        unsigned k; for (k = 0; k < key_count && strcmp(v->string, keys[k]); ++k) {}
        if (k == key_count || seen[k]) { ok = false; break; } seen[k] = true;
    }
    for (unsigned k = 0; k < 12; ++k) if (k!=3&&!seen[k]) ok = false;
    cJSON *reuse_token=cJSON_GetObjectItemCaseSensitive(root,"reuse_saved_credential"),*reuse_broker=cJSON_GetObjectItemCaseSensitive(root,"reuse_saved_mqtt");
    bool reuse_credential=cJSON_IsTrue(reuse_token),reuse_mqtt=cJSON_IsTrue(reuse_broker);
    if((reuse_token&&!cJSON_IsBool(reuse_token))||(reuse_broker&&!cJSON_IsBool(reuse_broker)))ok=false;
    if(ok&&reuse_credential){
        ok=!seen[3]&&cp_v3_saved_credential_ready(saved,node);
        if(ok)memcpy(out->settings.device_token,saved->device_token,sizeof out->settings.device_token);
    }else if(ok)ok=text(root,"device_token",out->settings.device_token,sizeof out->settings.device_token,false);
    char given_boot[37] = {0}, security[16] = {0},transport[16]={0}; uint64_t utc = 0, uncertainty = 0, windows = 0, anchor=0;
    if (ok) ok = text(root,"node_id",out->settings.node_id,sizeof out->settings.node_id,false) &&
        text(root,"boot_id",given_boot,sizeof given_boot,false) && !strcmp(node,out->settings.node_id) && !strcmp(boot,given_boot) &&
        text(root,"origin",out->origin,sizeof out->origin,false) &&
        text(root,"uplink_transport",transport,sizeof transport,false) &&
        text(root,"ssid",out->settings.ssid,sizeof out->settings.ssid,false) &&
        text(root,"password",out->settings.password,sizeof out->settings.password,true) &&
        text(root,"security",security,sizeof security,false) &&
        integer(root,"utc_ms",946684800000.,4102444799000.,&utc) &&
        integer(root,"uncertainty_ms",1,2000,&uncertainty) &&
#ifdef CP_V3_BOOTSTRAP_CONTINUOUS
        integer(root,"max_windows",0,60,&windows) &&
#else
        integer(root,"max_windows",1,3,&windows) &&
#endif
        integer(root,"anchor_mono_ms",0,9007199254740991.,&anchor);
    if(ok){
        if(!strcmp(security,"personal"))out->settings.wifi_security=CP_WIFI_PERSONAL;
        else if(!strcmp(security,"open"))out->settings.wifi_security=CP_WIFI_OPEN;
        else if(!strcmp(security,"enterprise_peap"))out->settings.wifi_security=CP_WIFI_ENTERPRISE_PEAP;
        else ok=false;
        for(unsigned k=12;k<15;k++)if(seen[k]!=(out->settings.wifi_security==CP_WIFI_ENTERPRISE_PEAP))ok=false;
        if(out->settings.wifi_security!=CP_WIFI_ENTERPRISE_PEAP&&(seen[15]||seen[16]||seen[17]))ok=false;
    }
    if(ok&&out->settings.wifi_security==CP_WIFI_ENTERPRISE_PEAP){
        char verification[8]={0};
        if(seen[17]){
            ok=text(root,"eap_server_verification",verification,sizeof verification,false);
            if(ok&&!strcmp(verification,"none"))out->eap_verification=CP_V3_EAP_VERIFY_NONE;
            else if(ok&&strcmp(verification,"ca"))ok=false;
        }
        if(ok)ok=text(root,"eap_username",out->settings.eap_username,sizeof out->settings.eap_username,false)&&
            text(root,"eap_identity",out->settings.eap_identity,sizeof out->settings.eap_identity,false)&&
            text(root,"eap_password",out->settings.eap_password,sizeof out->settings.eap_password,false);
        if(ok&&out->eap_verification==CP_V3_EAP_VERIFY_NONE)ok=!seen[15]&&!seen[16];
        else if(ok){
            cJSON *ca=cJSON_GetObjectItemCaseSensitive(root,"eap_ca_pem");
            ok=text(root,"eap_domain",out->eap_domain,sizeof out->eap_domain,false)&&
                cJSON_IsString(ca)&&ca->valuestring&&strlen(ca->valuestring)<sizeof out->eap_ca_pem;
            if(ok)memcpy(out->eap_ca_pem,ca->valuestring,strlen(ca->valuestring)+1);
        }
    }
    uint64_t mono=(uint64_t)esp_timer_get_time()/1000u;
    if(ok)ok=anchor<=mono&&mono-anchor<=30000;
    if(ok){uint64_t age=mono-anchor;utc+=age;uncertainty+=(age*500u+999999u)/1000000u;ok=uncertainty<=2000;}
#ifdef CP_V3_BOOTSTRAP_CONTINUOUS
    cJSON *ca=cJSON_GetObjectItemCaseSensitive(root,"server_ca_pem");
    if(ok&&ca){
        ok=cJSON_IsString(ca)&&ca->valuestring&&cp_v3_ca_validate(ca->valuestring);
        if(ok)memcpy(out->server_ca_pem,ca->valuestring,strlen(ca->valuestring)+1);
    }
#endif
    if(ok){
        if(!strcmp(transport,"https")){
            out->transport=CP_V3_TRANSPORT_HTTPS;
            ok=strcmp(out->origin,CP_API_ORIGIN)!=0&&!reuse_credential&&!reuse_mqtt;
            const char *mqtt_keys[]={"mqtt_uri","mqtt_username","mqtt_password","mqtt_namespace"};
            for(unsigned i=0;i<4;i++)if(cJSON_GetObjectItemCaseSensitive(root,mqtt_keys[i]))ok=false;
        }
#ifdef CP_V3_BOOTSTRAP_CONTINUOUS
        else if(!strcmp(transport,"mqtt_tls")){
            out->transport=CP_V3_TRANSPORT_MQTT_TLS;
            ok=!strcmp(out->origin,CP_API_ORIGIN)&&!cJSON_GetObjectItemCaseSensitive(root,"server_ca_pem");
            if(ok&&reuse_mqtt){
                const char *mqtt_keys[]={"mqtt_uri","mqtt_username","mqtt_password","mqtt_namespace"};
                for(unsigned i=0;i<4;i++)if(cJSON_GetObjectItemCaseSensitive(root,mqtt_keys[i]))ok=false;
                if(ok)ok=cp_v3_saved_mqtt_ready(saved,node);
                if(ok){
                    memcpy(out->settings.mqtt_uri,saved->mqtt_uri,sizeof out->settings.mqtt_uri);
                    memcpy(out->settings.mqtt_username,saved->mqtt_username,sizeof out->settings.mqtt_username);
                    memcpy(out->settings.mqtt_password,saved->mqtt_password,sizeof out->settings.mqtt_password);
                    memcpy(out->settings.mqtt_namespace,saved->mqtt_namespace,sizeof out->settings.mqtt_namespace);
                }
            }else if(ok)ok=text(root,"mqtt_uri",out->settings.mqtt_uri,sizeof out->settings.mqtt_uri,false)&&
                text(root,"mqtt_username",out->settings.mqtt_username,sizeof out->settings.mqtt_username,false)&&
                text(root,"mqtt_password",out->settings.mqtt_password,sizeof out->settings.mqtt_password,false)&&
                text(root,"mqtt_namespace",out->settings.mqtt_namespace,sizeof out->settings.mqtt_namespace,false);
            if(ok)ok=cp_settings_mqtt_ready(&out->settings);
        }
#endif
        else ok=false;
    }
    if (ok) ok = cp_v3_transport_origin_allowed(out->origin,
        cJSON_GetObjectItemCaseSensitive(root,"server_ca_pem") != NULL);
    if (ok) {
        out->settings.version = CP_SETTINGS_VERSION;
        /* Shared settings validates its legacy field. The independent V3
         * transport uses the explicit, strictly validated bootstrap origin. */
        snprintf(out->settings.api_origin,sizeof out->settings.api_origin,"%s",CP_API_ORIGIN);
        out->clock_seed = (cp_v3_time_t){.utc_ms=utc,.mono_ms=mono,.clock_epoch=1,.uncertainty_ms=(uint32_t)uncertainty};
        out->max_windows = (unsigned)windows;
    }
    if(ok)ok=cp_v3_wifi_validate_mode(&out->settings,out->eap_ca_pem,out->eap_domain,out->eap_verification);
#ifdef CP_V3_BOOTSTRAP_CONTINUOUS
    cJSON *save=cJSON_GetObjectItemCaseSensitive(root,"save_startup"),*recover=cJSON_GetObjectItemCaseSensitive(root,"startup_reconfigure");
    cJSON *key_id=cJSON_GetObjectItemCaseSensitive(root,"clock_key_id"),*key=cJSON_GetObjectItemCaseSensitive(root,"clock_public_spki");
    if(ok&&(save||recover||key_id||key)){
        char encoded[123];
        ok=out->transport==CP_V3_TRANSPORT_MQTT_TLS&&cJSON_IsTrue(save)&&
            (!recover||cJSON_IsBool(recover))&&text(root,"clock_key_id",out->clock_key_id,sizeof out->clock_key_id,false)&&
            text(root,"clock_public_spki",encoded,sizeof encoded,false)&&public_key_decode(encoded,out->clock_public_spki);
        if(ok){
            cp_v3_startup_profile_t candidate={.settings=out->settings,.time_public_spki_len=91,.auto_start=true};
            memcpy(candidate.time_key_id,out->clock_key_id,sizeof candidate.time_key_id);memcpy(candidate.time_public_spki,out->clock_public_spki,91);
            ok=cp_v3_startup_validate(&candidate,node);cp_v3_startup_clear(&candidate);
        }
        if(ok){out->save_startup=true;out->startup_reconfigure=cJSON_IsTrue(recover);}
        wipe(encoded,sizeof encoded);
    }
#endif
    for (cJSON *v = root ? root->child : NULL; v; v = v->next) if (v->valuestring) wipe(v->valuestring,strlen(v->valuestring));
    cJSON_Delete(root); wipe(given_boot,sizeof given_boot); wipe(security,sizeof security);wipe(transport,sizeof transport);
    if (!ok) trial_bootstrap_clear(out);
    return ok;
}
static bool parse_saved(const char *json,const char *node,const char *boot,trial_bootstrap_t *out) {
#ifdef CP_V3_BOOTSTRAP_CONTINUOUS
    cp_v3_saved_credentials_t saved;cp_v3_saved_credentials_load(node,&saved);
    bool ok=parse_with_credentials(json,node,boot,&saved.settings,out);
    cp_v3_saved_credentials_clear(&saved);return ok;
#else
    return parse_with_credentials(json,node,boot,NULL,out);
#endif
}
esp_err_t trial_bootstrap_wait(const char *node, const char *boot, trial_bootstrap_t *out, bool (*cancelled)(void)) {
#ifdef CP_V3_BOOTSTRAP_CONTINUOUS
    size_t capacity=8192;char *line=heap_caps_calloc(1,capacity,MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT);
    if(!line)return ESP_ERR_NO_MEM;
#else
    static char storage[4096];char *line=storage;size_t capacity=sizeof storage;
#endif
    size_t used = 0; bool overflow = false;
    trial_bootstrap_clear(out); puts("V3 READY"); fflush(stdout);
    for (;;) {
        if(cancelled&&cancelled()){wipe(line,capacity);trial_bootstrap_clear(out);
#ifdef CP_V3_BOOTSTRAP_CONTINUOUS
            heap_caps_free(line);
#endif
            return ESP_ERR_INVALID_STATE;}
        unsigned char byte; ssize_t n = read(STDIN_FILENO,&byte,1);
        if (n != 1) { vTaskDelay(pdMS_TO_TICKS(10)); continue; }
        if (byte == '\r') continue;
        if (byte != '\n') { if (byte < 32 || byte > 126) overflow=true;
            if (used + 1 < capacity && !overflow) line[used++] = (char)byte; else overflow=true; continue; }
        line[used] = 0;
        if (!overflow && !strncmp(line,"HELLO ",6) && hello_id(line+6)) {
#ifdef CP_V3_BOOTSTRAP_CONTINUOUS
            cp_v3_saved_credentials_t saved;cp_v3_saved_credentials_load(node,&saved);
            printf("V3 HELLO {\"node_id\":\"%s\",\"boot_id\":\"%s\",\"request_id\":\"%s\",\"mono_ms\":%llu,\"credential_state\":\"%s\",\"mqtt_state\":\"%s\"}\n",node,boot,line+6,(unsigned long long)((uint64_t)esp_timer_get_time()/1000u),cp_v3_saved_state_name(saved.credential_state),cp_v3_saved_state_name(saved.mqtt_state));
            cp_v3_saved_credentials_clear(&saved);
#else
            printf("V3 HELLO {\"node_id\":\"%s\",\"boot_id\":\"%s\",\"request_id\":\"%s\",\"mono_ms\":%llu}\n",node,boot,line+6,(unsigned long long)((uint64_t)esp_timer_get_time()/1000u));
#endif
            fflush(stdout);
        } else if (!overflow && !strncmp(line,"V3START ",8) && parse_saved(line+8,node,boot,out)) {
            wipe(line,capacity);
#ifdef CP_V3_BOOTSTRAP_CONTINUOUS
            heap_caps_free(line);
#endif
            puts("V3 START ACCEPTED"); fflush(stdout); return ESP_OK;
        } else { puts("V3 ERR BOOTSTRAP"); fflush(stdout); }
        wipe(line,capacity); used=0; overflow=false;
    }
}
