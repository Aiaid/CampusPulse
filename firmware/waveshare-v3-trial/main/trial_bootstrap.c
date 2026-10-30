#include "trial_bootstrap.h"
#include "cJSON.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <math.h>

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
static bool parse(const char *json, const char *node, const char *boot, trial_bootstrap_t *out) {
    const char *end = NULL;
    cJSON *root = cJSON_ParseWithOpts(json, &end, true);
    bool ok = cJSON_IsObject(root), seen[11] = {0};
    static const char *keys[] = {"node_id","boot_id","origin","device_token","ssid","password","utc_ms","uncertainty_ms","max_windows","security","anchor_mono_ms"};
    for (cJSON *v = ok ? root->child : NULL; v; v = v->next) {
        if (!v->string) { ok=false; break; }
        unsigned k; for (k = 0; k < 11 && strcmp(v->string, keys[k]); ++k) {}
        if (k == 11 || seen[k]) { ok = false; break; } seen[k] = true;
    }
    for (unsigned k = 0; k < 11; ++k) if (!seen[k]) ok = false;
    char given_boot[37] = {0}, security[16] = {0}; uint64_t utc = 0, uncertainty = 0, windows = 0, anchor=0;
    if (ok) ok = text(root,"node_id",out->settings.node_id,sizeof out->settings.node_id,false) &&
        text(root,"boot_id",given_boot,sizeof given_boot,false) && !strcmp(node,out->settings.node_id) && !strcmp(boot,given_boot) &&
        text(root,"origin",out->origin,sizeof out->origin,false) &&
        text(root,"device_token",out->settings.device_token,sizeof out->settings.device_token,false) &&
        text(root,"ssid",out->settings.ssid,sizeof out->settings.ssid,false) &&
        text(root,"password",out->settings.password,sizeof out->settings.password,true) &&
        text(root,"security",security,sizeof security,false) && !strcmp(security,"personal") &&
        strlen(out->settings.password) >= 8 &&
        integer(root,"utc_ms",946684800000.,4102444799000.,&utc) &&
        integer(root,"uncertainty_ms",1,2000,&uncertainty) && integer(root,"max_windows",1,3,&windows) &&
        integer(root,"anchor_mono_ms",0,9007199254740991.,&anchor);
    uint64_t mono=(uint64_t)esp_timer_get_time()/1000u;
    if(ok)ok=anchor<=mono&&mono-anchor<=30000;
    if(ok){uint64_t age=mono-anchor;utc+=age;uncertainty+=(age*500u+999999u)/1000000u;ok=uncertainty<=2000;}
    if (ok) {
        out->settings.version = CP_SETTINGS_VERSION; out->settings.wifi_security = CP_WIFI_PERSONAL;
        /* Shared settings shape validates its legacy field. The independent
         * v3 transport ignores this field and rejects that production origin. */
        snprintf(out->settings.api_origin,sizeof out->settings.api_origin,"%s",CP_API_ORIGIN);
        out->clock_seed = (cp_v3_time_t){.utc_ms=utc,.mono_ms=mono,.clock_epoch=1,.uncertainty_ms=(uint32_t)uncertainty};
        out->max_windows = (unsigned)windows;
    }
    for (cJSON *v = root ? root->child : NULL; v; v = v->next) if (v->valuestring) wipe(v->valuestring,strlen(v->valuestring));
    cJSON_Delete(root); wipe(given_boot,sizeof given_boot); wipe(security,sizeof security);
    if (!ok) trial_bootstrap_clear(out);
    return ok;
}
esp_err_t trial_bootstrap_wait(const char *node, const char *boot, trial_bootstrap_t *out, bool (*cancelled)(void)) {
    static char line[4096]; size_t used = 0; bool overflow = false;
    trial_bootstrap_clear(out); puts("V3 READY"); fflush(stdout);
    for (;;) {
        if(cancelled&&cancelled()){wipe(line,sizeof line);trial_bootstrap_clear(out);return ESP_ERR_INVALID_STATE;}
        unsigned char byte; ssize_t n = read(STDIN_FILENO,&byte,1);
        if (n != 1) { vTaskDelay(pdMS_TO_TICKS(10)); continue; }
        if (byte == '\r') continue;
        if (byte != '\n') { if (byte < 32 || byte > 126) overflow=true;
            if (used + 1 < sizeof line && !overflow) line[used++] = (char)byte; else overflow=true; continue; }
        line[used] = 0;
        if (!overflow && !strncmp(line,"HELLO ",6) && hello_id(line+6)) {
            printf("V3 HELLO {\"node_id\":\"%s\",\"boot_id\":\"%s\",\"request_id\":\"%s\",\"mono_ms\":%llu}\n",node,boot,line+6,(unsigned long long)((uint64_t)esp_timer_get_time()/1000u)); fflush(stdout);
        } else if (!overflow && !strncmp(line,"V3START ",8) && parse(line+8,node,boot,out)) {
            wipe(line,sizeof line); puts("V3 START ACCEPTED"); fflush(stdout); return ESP_OK;
        } else { puts("V3 ERR BOOTSTRAP"); fflush(stdout); }
        wipe(line,sizeof line); used=0; overflow=false;
    }
}
