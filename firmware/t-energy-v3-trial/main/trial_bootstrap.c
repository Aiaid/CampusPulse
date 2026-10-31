#include "trial_bootstrap.h"
#include "cp_v3_transport.h"
#include "mbedtls/x509_crt.h"
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
static int base64_digit(unsigned char c) {
    if (c >= 'A' && c <= 'Z') return c-'A';
    if (c >= 'a' && c <= 'z') return c-'a'+26;
    if (c >= '0' && c <= '9') return c-'0'+52;
    if (c == '+') return 62;
    if (c == '/') return 63;
    return -1;
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
static bool pem_ca(const char *pem) {
    size_t n = strlen(pem);
    static const char begin[] = "-----BEGIN CERTIFICATE-----";
    static const char end[] = "-----END CERTIFICATE-----";
    if (!n || n > TRIAL_BOOTSTRAP_CA_MAX || strncmp(pem,begin,sizeof begin-1)) return false;
    const char *p = pem + sizeof begin-1;
    if (*p == '\r') ++p;
    if (*p++ != '\n') return false;
    bool body = false, final_line = false;
    size_t encoded = 0, padding = 0;
    while (strncmp(p,end,sizeof end-1)) {
        if (final_line) return false;
        size_t width = 0, pads = 0;
        int last = 0;
        while (*p && *p != '\r' && *p != '\n') {
            unsigned char c = (unsigned char)*p++;
            if (++width > 64) return false;
            if (c == '=') { if (++pads > 2) return false; }
            else { last = base64_digit(c); if (pads || last < 0) return false; }
        }
        if (!width || width % 4) return false;
        if ((pads == 2 && (last & 15)) || (pads == 1 && (last & 3))) return false;
        encoded += width; padding += pads;
        body = true; final_line = width < 64 || pads;
        if (*p == '\r') ++p;
        if (*p++ != '\n') return false;
    }
    p += sizeof end-1;
    if (*p == '\r') { ++p; if (*p != '\n') return false; }
    if (*p == '\n') ++p;
    if (!body || *p) return false;
    /* mbedTLS PEM parsing alone is permissive about surrounding text and
     * partial chains. The exact envelope above forbids both. */
    mbedtls_x509_crt cert;
    mbedtls_x509_crt_init(&cert);
    bool ok = mbedtls_x509_crt_parse(&cert,(const unsigned char *)pem,n+1) == 0 &&
              cert.MBEDTLS_PRIVATE(ca_istrue) != 0 && !cert.next &&
              cert.raw.len == encoded/4u*3u-padding;
    mbedtls_x509_crt_free(&cert);
    return ok;
}

bool trial_bootstrap_parse(const char *json, const char *node, const char *boot,
                          uint64_t mono, trial_bootstrap_t *out) {
    if (!out) return false;
    trial_bootstrap_clear(out);
    if (!json || !node || !boot) return false;
    size_t length = 0;
    while (length <= TRIAL_BOOTSTRAP_LINE_MAX-8u && json[length]) ++length;
    if (length > TRIAL_BOOTSTRAP_LINE_MAX-8u) return false;
    /* Physical USB records are printable ASCII. Escaped JSON newlines are
     * decoded only within strings; encoded record size is bounded separately. */
    for (size_t i = 0; i < length; ++i) if ((unsigned char)json[i] < 32 || (unsigned char)json[i] > 126) return false;
    bool ok = false, seen[17] = {0};
    static const char *keys[] = {"node_id","boot_id","origin","device_token","ssid","password","utc_ms","uncertainty_ms","max_windows","security","anchor_mono_ms","server_ca_pem",
        "uplink_transport","mqtt_uri","mqtt_username","mqtt_password","mqtt_namespace"};
    char key[32] = {0}, given_boot[37] = {0}, security[16] = {0},transport[16]={0};
    uint64_t utc = 0, uncertainty = 0, windows = 0, anchor = 0;
    const char *p = json;
    space(&p); if (*p != '{') goto done; ++p;
    for (;;) {
        space(&p);
        if (!string(&p,key,sizeof key)) goto done;
        unsigned k; for (k = 0; k < 17 && strcmp(key,keys[k]); ++k) {}
        if (k == 17 || seen[k]) goto done;
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
            case 8: if (!integer(&p,1,3,&windows)) goto done; break;
            case 9: target = security; cap = sizeof security; break;
            case 10: if (!integer(&p,0,9007199254740991ULL,&anchor)) goto done; break;
            case 11: target = out->server_ca_pem; cap = sizeof out->server_ca_pem; break;
            case 12: target = transport; cap = sizeof transport; break;
            case 13: target = out->settings.mqtt_uri; cap = sizeof out->settings.mqtt_uri; break;
            case 14: target = out->settings.mqtt_username; cap = sizeof out->settings.mqtt_username; break;
            case 15: target = out->settings.mqtt_password; cap = sizeof out->settings.mqtt_password; break;
            case 16: target = out->settings.mqtt_namespace; cap = sizeof out->settings.mqtt_namespace; break;
        }
        if (target && (!string(&p,target,cap) || (k != 11 && !ascii_text(target,k == 5)))) goto done;
        space(&p);
        if (*p == '}') { ++p; break; }
        if (*p != ',') goto done;
        ++p;
    }
    space(&p); if (*p) goto done;
    for (unsigned k = 0; k < 11; ++k) if (!seen[k]) goto done;
    if (strcmp(node,out->settings.node_id) || strcmp(boot,given_boot) || strcmp(security,"personal") ||
        strlen(out->settings.password) < 8 || anchor > mono || mono-anchor > 30000 ||
        (seen[11] && !pem_ca(out->server_ca_pem))) goto done;
    /* Production is one canonical origin and always the SDK public bundle.
     * A CA field is forbidden even when empty. Host CLI permission is checked
     * before USB; the physical frame cannot weaken the device TLS boundary. */
    bool production=!strcmp(out->origin,CP_API_ORIGIN);
    /* Production defaults strictly to native MQTT. Diagnostics must explicitly
     * choose HTTPS, never silently route a test endpoint through the broker. */
    if(!seen[12]){if(!production)goto done;snprintf(transport,sizeof transport,"mqtt_tls");}
    if(!strcmp(transport,"mqtt_tls")){
        if(!production||seen[11]||!seen[13]||!seen[14]||!seen[15]||!seen[16]||!cp_settings_mqtt_ready(&out->settings))goto done;
        out->transport=CP_V3_TRANSPORT_MQTT_TLS;
    }else if(!strcmp(transport,"https")){
        if(production||seen[13]||seen[14]||seen[15]||seen[16]||!cp_v3_transport_origin_allowed(out->origin,seen[11]))goto done;
        out->transport=CP_V3_TRANSPORT_HTTPS;
    }else goto done;
    uint64_t age = mono-anchor;
    utc += age; uncertainty += (age*500u+999999u)/1000000u;
    if (uncertainty > 2000) goto done;
    out->settings.version = CP_SETTINGS_VERSION; out->settings.wifi_security = CP_WIFI_PERSONAL;
    /* The independent transport validates the explicit origin separately. */
    snprintf(out->settings.api_origin,sizeof out->settings.api_origin,"%s",CP_API_ORIGIN);
    out->clock_seed = (cp_v3_time_t){.utc_ms=utc,.mono_ms=mono,.clock_epoch=1,.uncertainty_ms=(uint32_t)uncertainty};
    out->max_windows = (unsigned)windows;
    ok = true;
done:
    wipe(key,sizeof key); wipe(given_boot,sizeof given_boot); wipe(security,sizeof security);
    if (!ok) trial_bootstrap_clear(out);
    return ok;
}

#ifndef TRIAL_BOOTSTRAP_HOST_TEST
static bool hello_id(const char *value) {
    if (strlen(value) != 32) return false;
    for (unsigned i = 0; i < 32; ++i) if (!((value[i] >= '0' && value[i] <= '9') || (value[i] >= 'a' && value[i] <= 'f'))) return false;
    return true;
}
esp_err_t trial_bootstrap_wait(const char *node, const char *boot, trial_bootstrap_t *out, bool (*cancelled)(void)) {
    static char line[TRIAL_BOOTSTRAP_LINE_MAX + 1u]; size_t used = 0;
    bool overflow = false, pending_cr = false;
    trial_bootstrap_clear(out); puts("V3 READY"); fflush(stdout);
    for (;;) {
        if(cancelled&&cancelled()){wipe(line,sizeof line);trial_bootstrap_clear(out);return ESP_ERR_INVALID_STATE;}
        unsigned char byte; ssize_t n = read(STDIN_FILENO,&byte,1);
        if (n != 1) { vTaskDelay(pdMS_TO_TICKS(10)); continue; }
        if (pending_cr && byte != '\n') overflow = true;
        if (byte == '\r') { pending_cr = true; continue; }
        if (byte != '\n') { if (byte < 32 || byte > 126) overflow=true;
            if (used + 1 < sizeof line && !overflow) line[used++] = (char)byte; else overflow=true; continue; }
        line[used] = 0;
        if (!overflow && !strncmp(line,"HELLO ",6) && hello_id(line+6)) {
            printf("V3 HELLO {\"node_id\":\"%s\",\"boot_id\":\"%s\",\"request_id\":\"%s\",\"mono_ms\":%llu}\n",node,boot,line+6,(unsigned long long)((uint64_t)esp_timer_get_time()/1000u)); fflush(stdout);
        } else if (!overflow && !strncmp(line,"V3START ",8) && trial_bootstrap_parse(line+8,node,boot,(uint64_t)esp_timer_get_time()/1000u,out)) {
            wipe(line,sizeof line); puts("V3 START ACCEPTED"); fflush(stdout); return ESP_OK;
        } else { puts("V3 ERR BOOTSTRAP"); fflush(stdout); }
        wipe(line,sizeof line); used=0; overflow=false; pending_cr=false;
    }
}
#endif
