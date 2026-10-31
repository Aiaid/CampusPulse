#include "trial_bootstrap.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static const char base[] = "{\"node_id\":\"te-test\",\"boot_id\":\"boot-test\",\"origin\":\"https://trial.invalid\",\"device_token\":\"synthetic-token\",\"ssid\":\"test-net\",\"password\":\"test-pass\",\"utc_ms\":1800000000000,\"uncertainty_ms\":10,\"max_windows\":1,\"security\":\"personal\",\"anchor_mono_ms\":1000}";
static unsigned checks;
static bool zero(const void *data, size_t n) {
    const unsigned char *p = data;
    while (n--) if (*p++) return false;
    return true;
}
static bool parse(const char *json, trial_bootstrap_t *out) {
    memset(out,0xa5,sizeof *out);
    bool ok = trial_bootstrap_parse(json,"te-test","boot-test",1100,out);
    ++checks;
    if (!ok) assert(zero(out,sizeof *out));
    return ok;
}
static void reject(const char *json) {
    trial_bootstrap_t out;
    assert(!parse(json,&out));
}
static char *read_file(const char *path) {
    FILE *file = fopen(path,"rb"); assert(file);
    assert(fseek(file,0,SEEK_END) == 0); long n = ftell(file); assert(n > 0 && n < 4096);
    rewind(file); char *data = calloc((size_t)n+1,1); assert(data);
    assert(fread(data,1,(size_t)n,file) == (size_t)n); fclose(file); return data;
}
static char *with_ca(const char *pem) {
    size_t cap = strlen(base)+strlen(pem)*6+64;
    char *out = calloc(cap,1); assert(out);
    size_t n = strlen(base)-1; memcpy(out,base,n);
    memcpy(out+n,",\"server_ca_pem\":\"",18); n += 18;
    for (; *pem; ++pem) {
        if (*pem == '\n' || *pem == '\r' || *pem == '\\' || *pem == '"') {
            out[n++] = '\\'; out[n++] = *pem == '\n' ? 'n' : *pem == '\r' ? 'r' : *pem;
        } else out[n++] = *pem;
    }
    out[n++] = '"'; out[n++] = '}'; out[n] = 0; assert(n < cap); return out;
}
static char *replace(const char *input, const char *old, const char *new) {
    const char *at = strstr(input,old); assert(at);
    size_t prefix = (size_t)(at-input);
    char *out = malloc(strlen(input)+strlen(new)+1); assert(out);
    memcpy(out,input,prefix); strcpy(out+prefix,new); strcat(out,at+strlen(old)); return out;
}
static void reject_change(const char *json, const char *old, const char *new) {
    char *changed = replace(json,old,new); reject(changed); free(changed);
}
static void malformed_json(void) {
    const char *bad[] = {"", " ", "null", "[]", "{}", "{", "{\"", "{\"n\\", "{\"n\\u", "{\"n\\u0", "{\"n\\u00", "{\"n\\u000", "{\"n\\u0000\":1}", "{\"node_id\":{}}", "{\"node_id\":[1]}", "{\"node_id\":true}", "{\"node_id\":null}", "{\"unknown\":\"test-pass\"}"};
    for (size_t i = 0; i < sizeof bad/sizeof *bad; ++i) reject(bad[i]);
    reject_change(base,"test-pass","test\\u0000-pass");
    reject_change(base,"node_id","node_id\\u0000suffix");
    reject_change(base,"test-pass","test\\qpass");
    reject_change(base,"test-pass","test\\u12G4pass");
    reject_change(base,"test-pass","test\\ud800pass");
    reject_change(base,"test-pass","test\\udc00pass");
    reject_change(base,"test-pass","test\\u0080pass");
    reject_change(base,"test-pass","test\\npass");
    reject_change(base,"test-pass","test\\rpass");
    reject_change(base,"test-pass","test\\tpass");
    reject_change(base,"test-pass","test\\bpass");
    reject_change(base,"test-pass","test\\fpass");
    reject_change(base,"test-pass","short");
    reject_change(base,"personal","open");
    reject_change(base,"te-test","wrong");
    reject_change(base,"boot-test","wrong");
    reject_change(base,"\"ssid\":\"test-net\",","");
    reject_change(base,"\"ssid\":\"test-net\"","\"ssid\":\"test-net\",\"ssid\":\"other\"");
    reject_change(base,"\"ssid\":\"test-net\"","\"ssid\":\"test-net\",\"s\\u0073id\":\"other\"");
    reject_change(base,"\"ssid\":\"test-net\"","\"ssid\":\"test-net\",\"unknown\":\"other\"");
    reject_change(base,"\"ssid\":\"test-net\"","\"ssid\":\"test-net\",");
    reject_change(base,"\"ssid\":\"test-net\"","\"ssid\":\"test-net\" trailing");
    const char *numbers[] = {"01", "+1", "-1", "0x1", "1.", ".1", "1e", "1e+", "1e-", "1e99999", "NaN", "Infinity", "1.5", "true", "null", "[]", "{}", "\"1\"", "0", "4", "3.0000000000000001", "1.0000000000000001", "0.99999999999999999", "2.9999999999999999999999999", "1e-99999", "1e32768", "1.000000000000000000000000001"};
    for (size_t i = 0; i < sizeof numbers/sizeof *numbers; ++i) {
        char new[128]; snprintf(new,sizeof new,"\"max_windows\":%s",numbers[i]);
        reject_change(base,"\"max_windows\":1",new);
    }
    reject_change(base,"1800000000000","946684799999");
    reject_change(base,"1800000000000","4102444799001");
    reject_change(base,"\"anchor_mono_ms\":1000","\"anchor_mono_ms\":1101");
    reject_change(base,"\"uncertainty_ms\":10","\"uncertainty_ms\":2000");
    char *trail = malloc(strlen(base)+8); assert(trail); strcpy(trail,base); strcat(trail,"garbage"); reject(trail); free(trail);
}
static void mutate(const char *json) {
    size_t n = strlen(json);
    /* Every exact-size prefix catches boundary reads at truncated escapes,
     * numbers, delimiters and PEM end lines under ASan/UBSan. */
    for (size_t len = 0; len < n; ++len) {
        char *prefix = malloc(len+1); assert(prefix);
        memcpy(prefix,json,len); prefix[len] = 0; reject(prefix); free(prefix);
    }
    static const unsigned char bytes[] = {0,1,10,31,32,34,44,48,58,65,91,92,93,123,125,127,255};
    char *changed = malloc(n+1); assert(changed);
    for (size_t i = 0; i < n; ++i) for (size_t j = 0; j < sizeof bytes; ++j) {
        memcpy(changed,json,n+1); changed[i] = (char)bytes[j];
        trial_bootstrap_t out;
        if (parse(changed,&out)) {
            assert(out.settings.version == CP_SETTINGS_VERSION);
            assert(out.max_windows >= 1 && out.max_windows <= 3);
            trial_bootstrap_clear(&out); assert(zero(&out,sizeof out));
        }
    }
    free(changed);
}
int main(int argc, char **argv) {
    assert(argc == 3);
    trial_bootstrap_t out;
    char *production=replace(base,"https://trial.invalid",CP_API_ORIGIN);
    assert(parse(production,&out));
    const char *bad_production[]={"https://pulse.anend.net:443","https://pulse.anend.net:8443","https://pulse.anend.net/","https://sub.pulse.anend.net","https://pulse.anend.net.","https://PULSE.anend.net"};
    for(size_t i=0;i<sizeof bad_production/sizeof *bad_production;i++)reject_change(base,"https://trial.invalid",bad_production[i]);
    reject_change(production,"\"anchor_mono_ms\":1000","\"anchor_mono_ms\":1000,\"server_ca_pem\":\"\"");
    free(production);
    assert(parse(base,&out)); assert(!out.server_ca_pem[0]);
    assert(!strcmp(out.settings.password,"test-pass"));
    assert(out.clock_seed.utc_ms == 1800000000100ULL);
    assert(out.clock_seed.uncertainty_ms == 11 && out.clock_seed.mono_ms == 1100);
    assert(out.settings.wifi_security == CP_WIFI_PERSONAL && out.max_windows == 1);
    trial_bootstrap_clear(&out); assert(zero(&out,sizeof out)); trial_bootstrap_clear(NULL);
    assert(!trial_bootstrap_parse(base,"te-test","boot-test",1100,NULL));
    assert(!parse(NULL,&out));
    memset(&out,0xa5,sizeof out); assert(!trial_bootstrap_parse(base,NULL,"boot-test",1100,&out)); assert(zero(&out,sizeof out));
    memset(&out,0xa5,sizeof out); assert(!trial_bootstrap_parse(base,"te-test",NULL,1100,&out)); assert(zero(&out,sizeof out));
    memset(&out,0xa5,sizeof out); assert(!trial_bootstrap_parse(base,"te-test","boot-test",31001,&out)); assert(zero(&out,sizeof out));
    char *valid = replace(base,"test-pass","test\\\"\\/\\\\\\u002dpass");
    assert(parse(valid,&out)); assert(!strcmp(out.settings.password,"test\"/\\-pass")); free(valid);
    valid = replace(base,"\"max_windows\":1","\"max_windows\":1.0e+0"); assert(parse(valid,&out)); free(valid);
    const char *exact[] = {"10e-1", "10000000000000000000000000000000000000e-37", "0.0001000e4", "3.000000000000000000000000000000000000000", "0.2e1"};
    for (size_t i = 0; i < sizeof exact/sizeof *exact; ++i) {
        char field[128]; snprintf(field,sizeof field,"\"max_windows\":%s",exact[i]);
        valid = replace(base,"\"max_windows\":1",field); assert(parse(valid,&out)); free(valid);
    }
    valid = replace(base,"1800000000000","1.8e12"); assert(parse(valid,&out)); free(valid);
    valid = replace(base,"node_id","n\\u006fde_id"); assert(parse(valid,&out)); free(valid);
    malformed_json();
    char *ca = read_file(argv[1]), *leaf = read_file(argv[2]);
    char *json = with_ca(ca); assert(parse(json,&out)); assert(!strcmp(out.server_ca_pem,ca));
    reject_change(json,"https://trial.invalid",CP_API_ORIGIN);
    valid = replace(json,"\\n","\\u000A"); assert(parse(valid,&out)); assert(!strcmp(out.server_ca_pem,ca)); free(valid);
    trial_bootstrap_clear(&out); assert(zero(&out,sizeof out));
    char *bad = with_ca(leaf); reject(bad); free(bad);
    bad = with_ca(""); reject(bad); free(bad);
    const char *bad_pem[] = {"-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n", "-----BEGIN CERTIFICATE-----", "-----BEGIN CERTIFICATE-----\r", "-----BEGIN CERTIFICATE-----\n", "-----BEGIN CERTIFICATE-----\nAAAA", "-----BEGIN CERTIFICATE-----\nAAAA\r", "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\r", "-----BEGIN CERTIFICATE-----\nAA=A\n-----END CERTIFICATE-----\n", "-----BEGIN CERTIFICATE-----\nAB==\n-----END CERTIFICATE-----\n", "-----BEGIN CERTIFICATE-----\nAAB=\n-----END CERTIFICATE-----\n"};
    for (size_t i = 0; i < sizeof bad_pem/sizeof *bad_pem; ++i) { bad = with_ca(bad_pem[i]); reject(bad); free(bad); }
    bad = with_ca("-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n"); reject(bad); free(bad);
    reject_change(json,"CERTIFICATE","PRIVATE KEY");
    reject_change(json,"-----BEGIN CERTIFICATE-----","leading-----BEGIN CERTIFICATE-----");
    reject_change(json,"-----END CERTIFICATE-----\\n","-----END CERTIFICATE-----\\ntrailing");
    reject_change(json,"-----END CERTIFICATE-----","-----END CERTIFICATE----");
    reject_change(json,"-----BEGIN CERTIFICATE-----\\n","-----BEGIN CERTIFICATE-----\\n\\n");
    reject_change(json,"-----BEGIN CERTIFICATE-----\\n","-----BEGIN CERTIFICATE-----\\u0000\\n");
    reject_change(json,"-----BEGIN CERTIFICATE-----\\n","-----BEGIN CERTIFICATE-----\\n!!!!\\n");
    reject_change(json,"-----BEGIN CERTIFICATE-----\\n","-----BEGIN CERTIFICATE-----\\nAAAA=AAA\\n");
    reject_change(json,"-----BEGIN CERTIFICATE-----\\n","-----BEGIN CERTIFICATE-----\\nAAA\\n");
    reject_change(json,"-----BEGIN CERTIFICATE-----\\n","-----BEGIN CERTIFICATE-----\\nAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\\n");
    reject_change(json,"\"server_ca_pem\":","\"server_ca_pem\":null,\"server_ca_pem\":");
    reject_change(base,"\"anchor_mono_ms\":1000","\"anchor_mono_ms\":1000,\"server_ca_pem\":null");
    reject_change(base,"\"anchor_mono_ms\":1000","\"anchor_mono_ms\":1000,\"server_ca_pem\":42");
    char *chain = malloc(strlen(ca)*2+1); assert(chain); strcpy(chain,ca); strcat(chain,ca);
    bad = with_ca(chain); reject(bad); free(bad); free(chain);
    char *crlf = calloc(strlen(ca)*2+1,1); assert(crlf); size_t j = 0;
    for (size_t i = 0; ca[i]; ++i) { if (ca[i] == '\n') crlf[j++] = '\r'; crlf[j++] = ca[i]; }
    valid = with_ca(crlf); assert(parse(valid,&out)); assert(!strcmp(out.server_ca_pem,crlf)); free(valid); free(crlf);
    size_t ca_len = strlen(ca); assert(ca[ca_len-1] == '\n'); ca[ca_len-1] = 0;
    valid = with_ca(ca); assert(parse(valid,&out)); free(valid);
    char *big = malloc(TRIAL_BOOTSTRAP_CA_MAX+2u); assert(big);
    memset(big,'A',TRIAL_BOOTSTRAP_CA_MAX+1u); big[TRIAL_BOOTSTRAP_CA_MAX+1u] = 0;
    bad = with_ca(big); reject(bad); free(bad);
    big[TRIAL_BOOTSTRAP_CA_MAX] = 0; bad = with_ca(big); reject(bad); free(bad); free(big);
    size_t max_json = TRIAL_BOOTSTRAP_LINE_MAX-8u;
    char *boundary = malloc(max_json+2); assert(boundary); memset(boundary,' ',max_json+1);
    memcpy(boundary,base,strlen(base)); boundary[max_json] = 0; assert(parse(boundary,&out));
    boundary[max_json] = ' '; boundary[max_json+1] = 0; reject(boundary); free(boundary);
    mutate(base); mutate(json);
    free(ca); free(leaf); free(json);
    printf("trial bootstrap host tests: %u parser checks passed (synthetic certificates)\n",checks);
    return 0;
}
