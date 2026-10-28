#include "cp_settings.h"
#include <stddef.h>
#include <string.h>
static size_t bounded_length(const char *s, size_t cap)
{
    const char *end = memchr(s, 0, cap);
    return end ? (size_t)(end-s) : cap;
}
bool cp_settings_mqtt_ready(const cp_settings_t *s)
{
    if(!s || bounded_length(s->mqtt_uri,sizeof s->mqtt_uri)!=strlen(CP_MQTT_PRODUCTION_URI) ||
       strcmp(s->mqtt_uri,CP_MQTT_PRODUCTION_URI))return false;
    const char *fields[]={s->mqtt_username,s->mqtt_password};
    const size_t caps[]={sizeof s->mqtt_username,sizeof s->mqtt_password};
    for(unsigned i=0;i<2;++i){size_t n=bounded_length(fields[i],caps[i]);
        if(!n||n==caps[i])return false;
        for(size_t j=0;j<n;++j)if((unsigned char)fields[i][j]<33||(unsigned char)fields[i][j]>126)return false;
    }
    size_t n=bounded_length(s->mqtt_namespace,sizeof s->mqtt_namespace);
    if(!n||n==sizeof s->mqtt_namespace)return false;
    for(size_t i=0;i<n;++i){char c=s->mqtt_namespace[i];
        if(!((c>='a'&&c<='z')||(c>='0'&&c<='9')||c=='_'||c=='-'))return false;
    }
    return true;
}
bool cp_settings_validate(const cp_settings_t *s)
{
    if (!s || s->version != CP_SETTINGS_VERSION ||
        bounded_length(s->node_id, sizeof(s->node_id)) != 15 ||
        strncmp(s->node_id, "cp_", 3) != 0) return false;
    for (unsigned i=3; i<15; ++i)
        if (!((s->node_id[i]>='0' && s->node_id[i]<='9') ||
              (s->node_id[i]>='a' && s->node_id[i]<='f'))) return false;
    size_t ssid = bounded_length(s->ssid, sizeof(s->ssid));
    size_t pass = bounded_length(s->password, sizeof(s->password));
    size_t token = bounded_length(s->device_token, sizeof(s->device_token));
    if (!ssid || ssid > 32 || pass > 64 || token < 32 || token > 192 ||
        bounded_length(s->api_origin, sizeof(s->api_origin)) != strlen(CP_API_ORIGIN) ||
        strcmp(s->api_origin, CP_API_ORIGIN)) return false;
    if (s->wifi_security > CP_WIFI_ENTERPRISE_PEAP) return false;
    if (s->wifi_security == CP_WIFI_PERSONAL && pass < 8) return false;
    if (s->wifi_security != CP_WIFI_PERSONAL && pass != 0) return false;
    const char *eap[] = {s->eap_username,s->eap_identity,s->eap_password};
    for (unsigned field=0;field<3;++field) {
        size_t n=bounded_length(eap[field],129);
        if (n>128 || (s->wifi_security==CP_WIFI_ENTERPRISE_PEAP && !n) ||
            (s->wifi_security!=CP_WIFI_ENTERPRISE_PEAP && n)) return false;
        for (size_t i=0;i<n;++i) if ((unsigned char)eap[field][i]<32 || eap[field][i]==127) return false;
    }
    for (size_t i=0; i<ssid; ++i) if ((unsigned char)s->ssid[i] < 32 || s->ssid[i]==127) return false;
    for (size_t i=0; i<pass; ++i) {
        unsigned char c=(unsigned char)s->password[i];
        if (c < 32 || c > 126) return false;
        if (pass == 64 && !((c>='0' && c<='9') || (c>='a' && c<='f') || (c>='A' && c<='F'))) return false;
    }
    for (size_t i=0; i<token; ++i)
        if ((unsigned char)s->device_token[i] < 33 || (unsigned char)s->device_token[i] > 126) return false;
    const bool absent=!s->mqtt_uri[0]&&!s->mqtt_username[0]&&!s->mqtt_password[0]&&!s->mqtt_namespace[0];
    /* Require the entire absent fields to be zero, not an embedded suffix. */
    if(absent){const char *fields[]={s->mqtt_uri,s->mqtt_username,s->mqtt_password,s->mqtt_namespace};
        const size_t sizes[]={sizeof s->mqtt_uri,sizeof s->mqtt_username,sizeof s->mqtt_password,sizeof s->mqtt_namespace};
        for(unsigned f=0;f<4;++f)for(size_t i=0;i<sizes[f];++i)if(fields[f][i])return false;
    }else if(!cp_settings_mqtt_ready(s))return false;
    return true;
}
void cp_settings_clear_sensitive(cp_settings_t *s)
{
    if (!s) return;
    volatile unsigned char *p=(volatile unsigned char *)s;
    for (size_t i=0;i<sizeof(*s);++i) p[i]=0;
}
