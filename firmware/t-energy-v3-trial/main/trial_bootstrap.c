#include "trial_bootstrap.h"
#include "cp_v3_transport.h"
#include "cp_v3_startup.h"
#include "cp_v3_saved_credentials.h"
#ifndef TRIAL_BOOTSTRAP_HOST_TEST
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include <unistd.h>
#endif
#include <stdio.h>
#include <string.h>

static void wipe(void *data, size_t size) {
    volatile unsigned char *p = data; while (size--) *p++ = 0;
}
void trial_bootstrap_clear(trial_bootstrap_t *out) { if (out) wipe(out, sizeof *out); }
static void space(const char **p) { while (**p == ' ') ++*p; }
static int hex(unsigned char c) {
    if (c >= '0' && c <= '9') return c-'0';
    if (c >= 'a' && c <= 'f') return c-'a'+10;
    if (c >= 'A' && c <= 'F') return c-'A'+10;
    return -1;
}
/* Flat schema: decode directly into caller-owned output, with no JSON heap
 * allocation that could free partially decoded credentials before wiping. */
static bool string(const char **p, char *out, size_t capacity) {
    if (**p != '"') return false;
    ++*p;
    size_t used = 0;
    while (**p && **p != '"') {
        unsigned char c = (unsigned char)*(*p)++;
        if (c < 32 || c > 126) return false;
        if (c == '\\') {
            c = (unsigned char)**p;
            if (!c) return false;
            ++*p;
            switch (c) {
                case '"': case '\\': case '/': break;
                case 'b': c = '\b'; break;
                case 'f': c = '\f'; break;
                case 'n': c = '\n'; break;
                case 'r': c = '\r'; break;
                case 't': c = '\t'; break;
                case 'u': {
                    unsigned value = 0;
                    for (unsigned i = 0; i < 4; ++i) {
                        int digit = hex((unsigned char)**p);
                        if (digit < 0) return false;
                        value = value*16u+(unsigned)digit; ++*p;
                    }
                    /* All admitted strings are ASCII. NUL must never hide a
                     * value/key suffix; non-ASCII and surrogates are rejected. */
                    if (!value || value > 126) return false;
                    c = (unsigned char)value;
                    break;
                }
                default: return false;
            }
        }
        if (used+1 >= capacity) return false;
        out[used++] = (char)c;
    }
    if (**p != '"') return false;
    ++*p; out[used] = 0; return true;
}
static bool ascii_text(const char *text, bool empty) {
    if (!empty && !*text) return false;
    for (; *text; ++text) if ((unsigned char)*text < 32 || (unsigned char)*text > 126) return false;
    return true;
}
static bool digit(char c) { return c >= '0' && c <= '9'; }
static bool boolean(const char **p,bool *out) {
    if(!strncmp(*p,"true",4)){*p+=4;*out=true;return true;}
    if(!strncmp(*p,"false",5)){*p+=5;*out=false;return true;}
    return false;
}
static bool public_key_decode(const char *text,uint8_t out[91]) {
    if(strlen(text)!=122)return false;
    uint32_t acc=0;unsigned bits=0;size_t used=0;
    for(size_t i=0;i<122;i++){
        unsigned char c=(unsigned char)text[i];int d=c>='A'&&c<='Z'?c-'A':c>='a'&&c<='z'?c-'a'+26:c>='0'&&c<='9'?c-'0'+52:c=='-'?62:c=='_'?63:-1;
        if(d<0)return false;
        acc=(acc<<6)|(unsigned)d;bits+=6;
        if(bits>=8){bits-=8;if(used>=91)return false;out[used++]=(uint8_t)(acc>>bits);}
    }
    return used==91&&bits==4&&(acc&15u)==0;
}
/* Compare the exact decimal value, without floating-point rounding. Keep JSON
 * integer-valued forms such as 1.0e0 and 10e-1 compatible with earlier hosts. */
static bool integer(const char **p, uint64_t min, uint64_t max, uint64_t *out) {
    const char *start = *p, *scan = start;
    bool negative = *scan == '-';
    if (negative) ++scan;
    const char *mantissa = scan;
    if (*scan == '0') ++scan;
    else {
        if (*scan < '1' || *scan > '9') return false;
        do { ++scan; } while (digit(*scan));
    }
    unsigned fractional = 0;
    if (*scan == '.') {
        ++scan; if (!digit(*scan)) return false;
        do { ++scan; ++fractional; } while (digit(*scan));
    }
    const char *mantissa_end = scan;
    int exponent = 0;
    if (*scan == 'e' || *scan == 'E') {
        ++scan; bool exponent_negative = *scan == '-';
        if (*scan == '+' || *scan == '-') ++scan;
        if (!digit(*scan)) return false;
        do {
            /* Saturation exceeds every possible mantissa in this bounded JSON. */
            if (exponent < 32768) {
                exponent = exponent*10+(*scan-'0');
                if (exponent > 32768) exponent = 32768;
            }
            ++scan;
        } while (digit(*scan));
        if (exponent_negative) exponent = -exponent;
    }
    unsigned significant = 0, trailing = 0;
    for (const char *s = mantissa; s < mantissa_end; ++s) {
        if (*s == '.') continue;
        if (*s != '0' || significant) ++significant;
        trailing = *s == '0' ? trailing+1 : 0;
    }
    uint64_t value = 0;
    if (significant) {
        if (negative) return false;
        unsigned core = significant-trailing;
        int zeros = exponent+(int)trailing-(int)fractional;
        if (zeros < 0 || core > 16 || zeros > 16 || core+(unsigned)zeros > 16) return false;
        unsigned used = 0;
        for (const char *s = mantissa; s < mantissa_end && used < core; ++s) {
            if (*s == '.' || (!used && *s == '0')) continue;
            value = value*10u+(unsigned)(*s-'0'); ++used;
        }
        while (zeros-- > 0) value *= 10u;
    }
    if (value < min || value > max) return false;
    *p = scan; *out = value; return true;
}

bool trial_bootstrap_parse_with_credentials(const char *json, const char *node, const char *boot,
                          uint64_t mono, const cp_settings_t *saved, trial_bootstrap_t *out) {
    if (!out) return false;
    trial_bootstrap_clear(out);
    if (!json || !node || !boot) return false;
    size_t length = 0;
    while (length <= TRIAL_BOOTSTRAP_LINE_MAX-8u && json[length]) ++length;
    if (length > TRIAL_BOOTSTRAP_LINE_MAX-8u) return false;
    /* Physical USB records are printable ASCII. Escaped JSON newlines are
     * decoded only within strings; encoded record size is bounded separately. */
    for (size_t i = 0; i < length; ++i) if ((unsigned char)json[i] < 32 || (unsigned char)json[i] > 126) return false;
    bool ok = false, seen[29] = {0};
    static const char *keys[] = {"node_id","boot_id","origin","device_token","ssid","password","utc_ms","uncertainty_ms","max_windows","security","anchor_mono_ms","server_ca_pem",
        "uplink_transport","mqtt_uri","mqtt_username","mqtt_password","mqtt_namespace",
        "save_startup","startup_reconfigure","clock_key_id","clock_public_spki",
        "eap_username","eap_identity","eap_password","eap_ca_pem","eap_domain","eap_server_verification","reuse_saved_credential","reuse_saved_mqtt"};
    const unsigned key_count=sizeof keys/sizeof keys[0];
    char key[32] = {0}, given_boot[37] = {0}, security[16] = {0},transport[16]={0};
    char public_key[123]={0},verification[8]={0};
    bool reuse_credential=false,reuse_mqtt=false;
    uint64_t utc = 0, uncertainty = 0, windows = 0, anchor = 0;
    const char *p = json;
    space(&p); if (*p != '{') goto done; ++p;
    for (;;) {
        space(&p);
        if (!string(&p,key,sizeof key)) goto done;
        unsigned k; for (k = 0; k < key_count && strcmp(key,keys[k]); ++k) {}
        if (k == key_count || seen[k]) goto done;
        seen[k] = true;
        space(&p); if (*p != ':') goto done; ++p; space(&p);
        char *target = NULL; size_t cap = 0;
        switch (k) {
            case 0: target = out->settings.node_id; cap = sizeof out->settings.node_id; break;
            case 1: target = given_boot; cap = sizeof given_boot; break;
            case 2: target = out->origin; cap = sizeof out->origin; break;
            case 3: target = out->settings.device_token; cap = sizeof out->settings.device_token; break;
            case 4: target = out->settings.ssid; cap = sizeof out->settings.ssid; break;
            case 5: target = out->settings.password; cap = sizeof out->settings.password; break;
            case 6: if (!integer(&p,946684800000ULL,4102444799000ULL,&utc)) goto done; break;
            case 7: if (!integer(&p,1,2000,&uncertainty)) goto done; break;
            case 8: if (!integer(&p,0,3,&windows)) goto done; break;
            case 9: target = security; cap = sizeof security; break;
            case 10: if (!integer(&p,0,9007199254740991ULL,&anchor)) goto done; break;
            case 11: target = out->server_ca_pem; cap = sizeof out->server_ca_pem; break;
            case 12: target = transport; cap = sizeof transport; break;
            case 13: target = out->settings.mqtt_uri; cap = sizeof out->settings.mqtt_uri; break;
            case 14: target = out->settings.mqtt_username; cap = sizeof out->settings.mqtt_username; break;
            case 15: target = out->settings.mqtt_password; cap = sizeof out->settings.mqtt_password; break;
            case 16: target = out->settings.mqtt_namespace; cap = sizeof out->settings.mqtt_namespace; break;
            case 17: if(!boolean(&p,&out->save_startup))goto done;break;
            case 18: if(!boolean(&p,&out->startup_reconfigure))goto done;break;
            case 19: target=out->clock_key_id;cap=sizeof out->clock_key_id;break;
            case 20: target=public_key;cap=sizeof public_key;break;
            case 21: target=out->settings.eap_username;cap=sizeof out->settings.eap_username;break;
            case 22: target=out->settings.eap_identity;cap=sizeof out->settings.eap_identity;break;
            case 23: target=out->settings.eap_password;cap=sizeof out->settings.eap_password;break;
            case 24: target=out->eap_ca_pem;cap=sizeof out->eap_ca_pem;break;
            case 25: target=out->eap_domain;cap=sizeof out->eap_domain;break;
            case 26: target=verification;cap=sizeof verification;break;
            case 27: if(!boolean(&p,&reuse_credential))goto done;break;
            case 28: if(!boolean(&p,&reuse_mqtt))goto done;break;
        }
        if (target && (!string(&p,target,cap) || (k != 11 && k != 24 && !ascii_text(target,k == 5)))) goto done;
        space(&p);
        if (*p == '}') { ++p; break; }
        if (*p != ',') goto done;
        ++p;
    }
    space(&p); if (*p) goto done;
    for (unsigned k = 0; k < 11; ++k) if (k!=3&&!seen[k]) goto done;
    if(reuse_credential){
        if(seen[3]||!cp_v3_saved_credential_ready(saved,node))goto done;
        memcpy(out->settings.device_token,saved->device_token,sizeof out->settings.device_token);
    }else if(!seen[3])goto done;
    if(reuse_mqtt){
        if(seen[13]||seen[14]||seen[15]||seen[16]||!cp_v3_saved_mqtt_ready(saved,node))goto done;
        memcpy(out->settings.mqtt_uri,saved->mqtt_uri,sizeof out->settings.mqtt_uri);
        memcpy(out->settings.mqtt_username,saved->mqtt_username,sizeof out->settings.mqtt_username);
        memcpy(out->settings.mqtt_password,saved->mqtt_password,sizeof out->settings.mqtt_password);
        memcpy(out->settings.mqtt_namespace,saved->mqtt_namespace,sizeof out->settings.mqtt_namespace);
    }
    if (strcmp(node,out->settings.node_id) || strcmp(boot,given_boot) ||
        anchor > mono || mono-anchor > 30000 ||
        (seen[11] && !cp_v3_ca_validate(out->server_ca_pem))) goto done;
    if(!strcmp(security,"personal"))out->settings.wifi_security=CP_WIFI_PERSONAL;
    else if(!strcmp(security,"open"))out->settings.wifi_security=CP_WIFI_OPEN;
    else if(!strcmp(security,"enterprise_peap"))out->settings.wifi_security=CP_WIFI_ENTERPRISE_PEAP;
    else goto done;
    for(unsigned k=21;k<24;k++)if(seen[k]!=(out->settings.wifi_security==CP_WIFI_ENTERPRISE_PEAP))goto done;
    if(out->settings.wifi_security==CP_WIFI_ENTERPRISE_PEAP){
        if(!seen[26]){if(!seen[24]||!seen[25])goto done;}
        else if(!strcmp(verification,"none")){
            if(seen[24]||seen[25])goto done;
            out->eap_verification=CP_V3_EAP_VERIFY_NONE;
        }else if(strcmp(verification,"ca"))goto done;
        if(out->eap_verification==CP_V3_EAP_VERIFY_CA&&(!seen[24]||!seen[25]))goto done;
    }else if(seen[24]||seen[25]||seen[26])goto done;
    /* Production is one canonical origin and always the SDK public bundle.
     * A CA field is forbidden even when empty. Host CLI permission is checked
     * before USB; the physical frame cannot weaken the device TLS boundary. */
    bool production=!strcmp(out->origin,CP_API_ORIGIN);
    /* Production defaults strictly to native MQTT. Diagnostics must explicitly
     * choose HTTPS, never silently route a test endpoint through the broker. */
    if(!seen[12]){if(!production)goto done;snprintf(transport,sizeof transport,"mqtt_tls");}
    if(!strcmp(transport,"mqtt_tls")){
        if(!production||seen[11]||(!reuse_mqtt&&(!seen[13]||!seen[14]||!seen[15]||!seen[16]))||!cp_settings_mqtt_ready(&out->settings))goto done;
        out->transport=CP_V3_TRANSPORT_MQTT_TLS;
    }else if(!strcmp(transport,"https")){
        if(production||reuse_credential||reuse_mqtt||seen[13]||seen[14]||seen[15]||seen[16]||!cp_v3_transport_origin_allowed(out->origin,seen[11]))goto done;
        out->transport=CP_V3_TRANSPORT_HTTPS;
    }else goto done;
    uint64_t age = mono-anchor;
    utc += age; uncertainty += (age*500u+999999u)/1000000u;
    if (uncertainty > 2000) goto done;
    out->settings.version = CP_SETTINGS_VERSION;
    /* The independent transport validates the explicit origin separately. */
    snprintf(out->settings.api_origin,sizeof out->settings.api_origin,"%s",CP_API_ORIGIN);
    if(!cp_v3_wifi_validate_mode(&out->settings,out->eap_ca_pem,out->eap_domain,out->eap_verification))goto done;
    out->clock_seed = (cp_v3_time_t){.utc_ms=utc,.mono_ms=mono,.clock_epoch=1,.uncertainty_ms=(uint32_t)uncertainty};
    out->max_windows = (unsigned)windows;
    if(seen[17]||seen[18]||seen[19]||seen[20]){
        if(!out->save_startup||!seen[19]||!seen[20]||out->transport!=CP_V3_TRANSPORT_MQTT_TLS||
           !public_key_decode(public_key,out->clock_public_spki))goto done;
        cp_v3_startup_profile_t candidate={.settings=out->settings,.auto_start=true,.time_public_spki_len=91};
        memcpy(candidate.time_key_id,out->clock_key_id,sizeof candidate.time_key_id);memcpy(candidate.time_public_spki,out->clock_public_spki,91);
        bool valid=cp_v3_startup_validate(&candidate,node);cp_v3_startup_clear(&candidate);if(!valid)goto done;
    }
    if(!windows&&!out->save_startup)goto done;
    ok = true;
done:
    wipe(key,sizeof key); wipe(given_boot,sizeof given_boot); wipe(security,sizeof security);wipe(public_key,sizeof public_key);
    if (!ok) trial_bootstrap_clear(out);
    return ok;
}

bool trial_bootstrap_parse(const char *json,const char *node,const char *boot,uint64_t mono,trial_bootstrap_t *out) {
    return trial_bootstrap_parse_with_credentials(json,node,boot,mono,NULL,out);
}
#ifndef TRIAL_BOOTSTRAP_HOST_TEST
static bool parse_saved(const char *json,const char *node,const char *boot,trial_bootstrap_t *out) {
    cp_v3_saved_credentials_t saved;cp_v3_saved_credentials_load(node,&saved);
    bool ok=trial_bootstrap_parse_with_credentials(json,node,boot,(uint64_t)esp_timer_get_time()/1000u,&saved.settings,out);
    cp_v3_saved_credentials_clear(&saved);return ok;
}
static bool hello_id(const char *value) {
    if (strlen(value) != 32) return false;
    for (unsigned i = 0; i < 32; ++i) if (!((value[i] >= '0' && value[i] <= '9') || (value[i] >= 'a' && value[i] <= 'f'))) return false;
    return true;
}
esp_err_t trial_bootstrap_wait_for(const char *node, const char *boot, trial_bootstrap_t *out, bool (*cancelled)(void),uint32_t grace_ms) {
    static char line[TRIAL_BOOTSTRAP_LINE_MAX + 1u]; size_t used = 0;
    bool overflow = false, pending_cr = false;
    uint64_t began=(uint64_t)esp_timer_get_time()/1000u;
    trial_bootstrap_clear(out); puts("V3 READY"); fflush(stdout);
    for (;;) {
        if(cancelled&&cancelled()){wipe(line,sizeof line);trial_bootstrap_clear(out);return ESP_ERR_INVALID_STATE;}
        if(grace_ms&&(uint64_t)esp_timer_get_time()/1000u-began>=grace_ms){wipe(line,sizeof line);trial_bootstrap_clear(out);return ESP_ERR_TIMEOUT;}
        unsigned char byte; ssize_t n = read(STDIN_FILENO,&byte,1);
        if (n != 1) { vTaskDelay(pdMS_TO_TICKS(10)); continue; }
        if (pending_cr && byte != '\n') overflow = true;
        if (byte == '\r') { pending_cr = true; continue; }
        if (byte != '\n') { if (byte < 32 || byte > 126) overflow=true;
            if (used + 1 < sizeof line && !overflow) line[used++] = (char)byte; else overflow=true; continue; }
        line[used] = 0;
        if (!overflow && !strncmp(line,"HELLO ",6) && hello_id(line+6)) {
            grace_ms=0;
            cp_v3_saved_credentials_t saved;cp_v3_saved_credentials_load(node,&saved);
            printf("V3 HELLO {\"node_id\":\"%s\",\"boot_id\":\"%s\",\"request_id\":\"%s\",\"mono_ms\":%llu,\"credential_state\":\"%s\",\"mqtt_state\":\"%s\"}\n",node,boot,line+6,(unsigned long long)((uint64_t)esp_timer_get_time()/1000u),cp_v3_saved_state_name(saved.credential_state),cp_v3_saved_state_name(saved.mqtt_state));
            cp_v3_saved_credentials_clear(&saved);fflush(stdout);
        } else if(!overflow&&!strcmp(line,"SETUP")){grace_ms=0;puts("V3 USB SETUP");fflush(stdout);
        } else if (!overflow && !strncmp(line,"V3START ",8) && parse_saved(line+8,node,boot,out)) {
            wipe(line,sizeof line); puts("V3 START ACCEPTED"); fflush(stdout); return ESP_OK;
        } else { puts("V3 ERR BOOTSTRAP"); fflush(stdout); }
        wipe(line,sizeof line); used=0; overflow=false; pending_cr=false;
    }
}
esp_err_t trial_bootstrap_wait(const char *node,const char *boot,trial_bootstrap_t *out,bool (*cancelled)(void)) {
    return trial_bootstrap_wait_for(node,boot,out,cancelled,0);
}
#endif
