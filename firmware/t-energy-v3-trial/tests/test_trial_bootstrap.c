#include "trial_bootstrap.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static const char base[] = "{\"node_id\":\"cp_001122334455\",\"boot_id\":\"boot-test\",\"origin\":\"https://trial.invalid\",\"uplink_transport\":\"https\",\"device_token\":\"synthetic-token-at-least-thirty-two-bytes\",\"ssid\":\"test-net\",\"password\":\"test-pass\",\"utc_ms\":1800000000000,\"uncertainty_ms\":10,\"max_windows\":1,\"security\":\"personal\",\"anchor_mono_ms\":1000}";
static unsigned checks;
static char *peap(const char *input,const char *ca);
static void startup_profiles(const char *ca){
    const char *production="{\"node_id\":\"cp_001122334455\",\"boot_id\":\"boot-test\",\"origin\":\"" CP_API_ORIGIN "\",\"uplink_transport\":\"mqtt_tls\",\"device_token\":\"synthetic_device_credential_32_bytes\",\"ssid\":\"test-net\",\"password\":\"test-pass\",\"utc_ms\":1800000000000,\"uncertainty_ms\":10,\"max_windows\":0,\"security\":\"personal\",\"anchor_mono_ms\":1000,\"mqtt_uri\":\"" CP_MQTT_PRODUCTION_URI "\",\"mqtt_username\":\"synthetic-user\",\"mqtt_password\":\"synthetic-password\",\"mqtt_namespace\":\"synthetic-node\",\"save_startup\":true,\"startup_reconfigure\":false,\"clock_key_id\":\"synthetic-key-1\",\"clock_public_spki\":\"MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEaxfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpZP40Li_hp_m47n60p8D54WK84zV2sxXs7LtkBoN79R9Q\"}";
    trial_bootstrap_t out;
    assert(trial_bootstrap_parse(production,"cp_001122334455","boot-test",1100,&out));
    assert(out.save_startup&&!out.startup_reconfigure&&!out.max_windows&&out.clock_public_spki[0]==0x30);
    char *enterprise=peap(production,ca);assert(!trial_bootstrap_parse(enterprise,"cp_001122334455","boot-test",1100,&out));
    for(size_t i=0;i<sizeof out;i++)assert(!((unsigned char *)&out)[i]);
    free(enterprise);
    char input[4096];
    static const struct{const char *old,*replacement;} bad[]={
        {"\"save_startup\":true","\"save_startup\":false"},
        {"\"save_startup\":true","\"save_startup\":null"},
        {"\"save_startup\":true","\"save_startup\":\"true\""},
        {"\"save_startup\":true,",""},
        {"\"clock_key_id\":\"synthetic-key-1\",",""},
        {"\"clock_key_id\":\"synthetic-key-1\"","\"clock_key_id\":null"},
        {"\"startup_reconfigure\":false","\"startup_reconfigure\":null"},
        {"\"startup_reconfigure\":false","\"startup_reconfigure\":\"false\""},
        {"\"max_windows\":0","\"max_windows\":4"},
        {"\"clock_key_id\":","\"unknown_startup_key\":"},
        {"MFkwEwYH","MFkwEwYI"}
    };
    for(size_t i=0;i<sizeof bad/sizeof *bad;i++){
        const char *at=strstr(production,bad[i].old);assert(at);
        size_t prefix=(size_t)(at-production);memcpy(input,production,prefix);
        snprintf(input+prefix,sizeof input-prefix,"%s%s",bad[i].replacement,at+strlen(bad[i].old));
        memset(&out,0xa5,sizeof out);assert(!trial_bootstrap_parse(input,"cp_001122334455","boot-test",1100,&out));
        const uint8_t *p=(const uint8_t*)&out;for(size_t j=0;j<sizeof out;j++)assert(!p[j]);
    }
    strcpy(input,production);char *recover=strstr(input,"\"startup_reconfigure\":false");assert(recover);
    memmove(recover+strlen("\"startup_reconfigure\":true"),recover+strlen("\"startup_reconfigure\":false"),strlen(recover+strlen("\"startup_reconfigure\":false"))+1);
    memcpy(recover,"\"startup_reconfigure\":true",strlen("\"startup_reconfigure\":true"));
    assert(trial_bootstrap_parse(input,"cp_001122334455","boot-test",1100,&out)&&out.startup_reconfigure);
}
static bool zero(const void *data, size_t n) {
    const unsigned char *p = data;
    while (n--) if (*p++) return false;
    return true;
}
static bool parse(const char *json, trial_bootstrap_t *out) {
    memset(out,0xa5,sizeof *out);
    bool ok = trial_bootstrap_parse(json,"cp_001122334455","boot-test",1100,out);
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
static char *field(const char *input,const char *key,const char *value){
    size_t cap=strlen(input)+strlen(key)+strlen(value)*2+16;
    char *out=calloc(cap,1);assert(out);size_t n=strlen(input)-1;
    memcpy(out,input,n);n+=(size_t)snprintf(out+n,cap-n,",\"%s\":\"",key);
    for(;*value;value++){
        if(*value=='\n'||*value=='\r'||*value=='\\'||*value=='\"'){
            out[n++]='\\';out[n++]=*value=='\n'?'n':*value=='\r'?'r':*value;
        }else out[n++]=*value;
    }
    out[n++]='\"';out[n++]='}';out[n]=0;assert(n<cap);return out;
}
static char *peap(const char *input,const char *ca){
    char *a=replace(input,"\"security\":\"personal\"","\"security\":\"enterprise_peap\"");
    char *b=replace(a,"\"password\":\"test-pass\"","\"password\":\"\"");free(a);
    const char *keys[]={"eap_username","eap_identity","eap_password","eap_ca_pem","eap_domain"};
    const char *values[]={"synthetic-user","synthetic-identity","synthetic-eap-secret",ca,"radius.example"};
    for(unsigned i=0;i<5;i++){a=field(b,keys[i],values[i]);free(b);b=a;}return b;
}
static void wifi_modes(const char *ca,const char *leaf){
    trial_bootstrap_t out;
    char *a=replace(base,"personal","open"),*open=replace(a,"test-pass","");free(a);
    assert(parse(open,&out)&&out.settings.wifi_security==CP_WIFI_OPEN&&!out.settings.password[0]);
    reject_change(open,"\"password\":\"\"","\"password\":\"test-pass\"");
    const char *fields[]={"eap_username","eap_identity","eap_password","eap_ca_pem","eap_domain"};
    for(unsigned i=0;i<5;i++){
        a=field(base,fields[i],"");reject(a);free(a);a=field(open,fields[i],"");reject(a);free(a);
    }
    a=replace(base,"test-pass","0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");assert(parse(a,&out));free(a);
    a=replace(base,"test-pass","z123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");reject(a);free(a);
    char *valid=peap(base,ca);assert(parse(valid,&out));
    assert(out.settings.wifi_security==CP_WIFI_ENTERPRISE_PEAP&&!out.settings.password[0]);
    assert(!strcmp(out.settings.eap_username,"synthetic-user")&&!strcmp(out.settings.eap_identity,"synthetic-identity"));
    assert(!strcmp(out.settings.eap_password,"synthetic-eap-secret")&&!strcmp(out.eap_ca_pem,ca)&&!strcmp(out.eap_domain,"radius.example"));
    reject_change(valid,"\"password\":\"\"","\"password\":\"test-pass\"");
    for(unsigned i=0;i<5;i++){
        a=field(valid,fields[i],"");reject(a);free(a);
        char key[64];snprintf(key,sizeof key,"\"%s\":",fields[i]);
        const char *at=strstr(valid,key);assert(at);const char *end=at+strlen(key)+1;
        while(*end&&(*end!='\"'||end[-1]=='\\'))end++;
        assert(*end);end++;if(*end==',')end++;else at--;
        size_t n=(size_t)(end-at);a=malloc(strlen(valid)+1);assert(a);memcpy(a,valid,(size_t)(at-valid));strcpy(a+(at-valid),end);assert(n);reject(a);free(a);
    }
    const char *domains[]={"","https://radius.example","192.0.2.1","127.1","1234","*.example","a..example","-a.example","a-.example","a.example.","a.example;b.example","a.example b.example"};
    for(unsigned i=0;i<sizeof domains/sizeof *domains;i++)reject_change(valid,"radius.example",domains[i]);
    a=replace(valid,"radius.example","radius");assert(parse(a,&out));free(a);
    a=peap(base,leaf);reject(a);free(a);a=peap(base,"-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n");reject(a);free(a);
    reject_change(valid,"synthetic-user","synthetic-user\\u0000suffix");
    reject_change(valid,"synthetic-identity","synthetic-identity\\u0000suffix");
    reject_change(valid,"synthetic-eap-secret","synthetic-eap-secret\\u0000suffix");
    reject_change(valid,"radius.example","radius.example\\u0000suffix");
    reject_change(valid,"-----END CERTIFICATE-----\\n","-----END CERTIFICATE-----\\n\\u0000suffix");
    a=replace(valid,"synthetic-user","literal\\\\u0000");assert(parse(a,&out));free(a);
    reject_change(valid,"synthetic-user","");reject_change(valid,"synthetic-identity","");reject_change(valid,"synthetic-eap-secret","");
    reject_change(valid,"\"anchor_mono_ms\":1000","\"anchor_mono_ms\":1101");
    a=field(valid,"save_startup","true");reject(a);free(a);
    char *production=replace(valid,"https://trial.invalid",CP_API_ORIGIN);
    char *mqtt=replace(production,"\"uplink_transport\":\"https\"","\"uplink_transport\":\"mqtt_tls\"");free(production);
    const char *mk[]={"mqtt_uri","mqtt_username","mqtt_password","mqtt_namespace"};
    const char *mv[]={CP_MQTT_PRODUCTION_URI,"synthetic-user","synthetic-pass","synthetic"};
    for(unsigned i=0;i<4;i++){a=field(mqtt,mk[i],mv[i]);free(mqtt);mqtt=a;}
    assert(parse(mqtt,&out)&&out.transport==CP_V3_TRANSPORT_MQTT_TLS);
    a=field(mqtt,"server_ca_pem",ca);reject(a);free(a);free(mqtt);
    free(valid);free(open);
}
static void optional_ca_and_reuse(const char *ca){
    trial_bootstrap_t out;
    char *empty=peap(base,""),*no_ca=replace(empty,",\"eap_ca_pem\":\"\"","");free(empty);
    char *no_trust=replace(no_ca,",\"eap_domain\":\"radius.example\"","");free(no_ca);
    reject(no_trust);
    char *none=field(no_trust,"eap_server_verification","none");
    assert(parse(none,&out)&&out.eap_verification==CP_V3_EAP_VERIFY_NONE&&!out.eap_ca_pem[0]&&!out.eap_domain[0]);
    char *bad=field(none,"eap_ca_pem","");reject(bad);free(bad);
    bad=field(none,"eap_domain","");reject(bad);free(bad);
    reject_change(none,"\"none\"","\"ca\"");reject_change(none,"\"none\"","null");
    reject_change(none,"\"none\"","\"unknown\"");
    bad=field(base,"eap_server_verification","none");reject(bad);free(bad);
    char *verified=peap(base,ca);bad=field(verified,"eap_server_verification","none");reject(bad);free(bad);
    bad=field(verified,"eap_server_verification","ca");assert(parse(bad,&out)&&out.eap_verification==CP_V3_EAP_VERIFY_CA);free(bad);
    free(verified);free(none);free(no_trust);
    const char *reuse="{\"node_id\":\"cp_001122334455\",\"boot_id\":\"boot-test\",\"origin\":\"" CP_API_ORIGIN "\",\"uplink_transport\":\"mqtt_tls\",\"reuse_saved_credential\":true,\"reuse_saved_mqtt\":true,\"ssid\":\"fresh-wifi\",\"password\":\"fresh-pass\",\"utc_ms\":1800000000000,\"uncertainty_ms\":10,\"max_windows\":1,\"security\":\"personal\",\"anchor_mono_ms\":1000}";
    assert(parse(base,&out));cp_settings_t saved=out.settings;
    strcpy(saved.mqtt_uri,CP_MQTT_PRODUCTION_URI);strcpy(saved.mqtt_username,"saved-user");strcpy(saved.mqtt_password,"saved-mqtt-password");strcpy(saved.mqtt_namespace,"saved_namespace");
    assert(trial_bootstrap_parse_with_credentials(reuse,saved.node_id,"boot-test",1100,&saved,&out));
    assert(!strcmp(out.settings.device_token,saved.device_token)&&!strcmp(out.settings.mqtt_password,saved.mqtt_password));
    assert(!strcmp(out.settings.ssid,"fresh-wifi")&&!strcmp(out.settings.password,"fresh-pass"));
    reject(reuse);
    const char *fields[]={"device_token","mqtt_uri","mqtt_username","mqtt_password","mqtt_namespace"};
    for(unsigned i=0;i<5;i++){bad=field(reuse,fields[i],"");assert(!trial_bootstrap_parse_with_credentials(bad,saved.node_id,"boot-test",1100,&saved,&out)&&zero(&out,sizeof out));free(bad);}
    const char *old[]={"true","mqtt_tls",CP_API_ORIGIN,"boot-test","1000"};
    const char *replacement[]={"false","https","https://isolated.example","other-boot","1101"};
    for(unsigned i=0;i<5;i++){bad=replace(reuse,old[i],replacement[i]);assert(!trial_bootstrap_parse_with_credentials(bad,saved.node_id,"boot-test",1100,&saved,&out)&&zero(&out,sizeof out));free(bad);}
    /* Each credential source is independent; supplied and stored fields never mix within a source. */
    bad=replace(reuse,"\"reuse_saved_credential\":true","\"device_token\":\"manual-token-at-least-thirty-two-bytes\"");
    assert(trial_bootstrap_parse_with_credentials(bad,saved.node_id,"boot-test",1100,&saved,&out));
    assert(!strcmp(out.settings.device_token,"manual-token-at-least-thirty-two-bytes")&&!strcmp(out.settings.mqtt_password,saved.mqtt_password));free(bad);
    bad=replace(reuse,"\"reuse_saved_mqtt\":true","\"mqtt_uri\":\"" CP_MQTT_PRODUCTION_URI "\",\"mqtt_username\":\"manual-user\",\"mqtt_password\":\"manual-password\",\"mqtt_namespace\":\"manual_ns\"");
    cp_settings_t token_only=saved;memset(token_only.mqtt_uri,0,sizeof token_only.mqtt_uri);memset(token_only.mqtt_username,0,sizeof token_only.mqtt_username);memset(token_only.mqtt_password,0,sizeof token_only.mqtt_password);memset(token_only.mqtt_namespace,0,sizeof token_only.mqtt_namespace);
    assert(trial_bootstrap_parse_with_credentials(bad,token_only.node_id,"boot-test",1100,&token_only,&out));
    assert(!strcmp(out.settings.device_token,token_only.device_token)&&!strcmp(out.settings.mqtt_password,"manual-password"));free(bad);cp_settings_clear_sensitive(&token_only);
    strcpy(saved.node_id,"cp_112233445566");assert(!trial_bootstrap_parse_with_credentials(reuse,"cp_001122334455","boot-test",1100,&saved,&out));
    strcpy(saved.node_id,"cp_001122334455");saved.mqtt_password[0]=0;assert(!trial_bootstrap_parse_with_credentials(reuse,saved.node_id,"boot-test",1100,&saved,&out));
    cp_settings_clear_sensitive(&saved);trial_bootstrap_clear(&out);
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
    reject_change(base,"cp_001122334455","wrong");
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
    reject(production);
    char extra[1024];snprintf(extra,sizeof extra,",\"mqtt_uri\":\"%s\",\"mqtt_username\":\"synthetic-user\",\"mqtt_password\":\"synthetic-password\",\"mqtt_namespace\":\"synthetic-node\"}",CP_MQTT_PRODUCTION_URI);
    char *mqtt_base=replace(production,"\"uplink_transport\":\"https\"","\"uplink_transport\":\"mqtt_tls\"");
    char *mqtt=replace(mqtt_base,"}",extra);free(mqtt_base);
    assert(parse(mqtt,&out)&&out.transport==CP_V3_TRANSPORT_MQTT_TLS);
    char *default_mqtt=replace(mqtt,",\"uplink_transport\":\"mqtt_tls\"","");
    assert(parse(default_mqtt,&out)&&out.transport==CP_V3_TRANSPORT_MQTT_TLS);free(default_mqtt);
    reject_change(base,",\"uplink_transport\":\"https\"","");
    reject_change(mqtt,"mqtt_tls","https");
    reject_change(mqtt,CP_MQTT_PRODUCTION_URI,"mqtts://other.example:8883");
    reject_change(mqtt,"synthetic-node","bad/namespace");
    reject_change(mqtt,"\"mqtt_password\":\"synthetic-password\"","\"mqtt_password\":\"\"");
    reject_change(mqtt,"\"anchor_mono_ms\":1000","\"anchor_mono_ms\":1000,\"server_ca_pem\":\"\"");
    reject_change(mqtt,CP_API_ORIGIN,"https://isolated.example");
    free(mqtt);
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
    assert(!trial_bootstrap_parse(base,"cp_001122334455","boot-test",1100,NULL));
    assert(!parse(NULL,&out));
    memset(&out,0xa5,sizeof out); assert(!trial_bootstrap_parse(base,NULL,"boot-test",1100,&out)); assert(zero(&out,sizeof out));
    memset(&out,0xa5,sizeof out); assert(!trial_bootstrap_parse(base,"cp_001122334455",NULL,1100,&out)); assert(zero(&out,sizeof out));
    memset(&out,0xa5,sizeof out); assert(!trial_bootstrap_parse(base,"cp_001122334455","boot-test",31001,&out)); assert(zero(&out,sizeof out));
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
    startup_profiles(ca);wifi_modes(ca,leaf);optional_ca_and_reuse(ca);
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
