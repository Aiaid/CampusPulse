#include "cp_settings.h"
#include <stddef.h>
#include <string.h>
static size_t bounded_length(const char *s, size_t cap)
{
    const char *end = memchr(s, 0, cap);
    return end ? (size_t)(end-s) : cap;
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
    if (!ssid || ssid > 32 || pass < 8 || pass > 64 || token < 32 || token > 192 ||
        bounded_length(s->api_origin, sizeof(s->api_origin)) != strlen(CP_API_ORIGIN) ||
        strcmp(s->api_origin, CP_API_ORIGIN)) return false;
    for (size_t i=0; i<ssid; ++i) if ((unsigned char)s->ssid[i] < 32 || s->ssid[i]==127) return false;
    for (size_t i=0; i<pass; ++i) {
        unsigned char c=(unsigned char)s->password[i];
        if (c < 32 || c > 126) return false;
        if (pass == 64 && !((c>='0' && c<='9') || (c>='a' && c<='f') || (c>='A' && c<='F'))) return false;
    }
    for (size_t i=0; i<token; ++i)
        if ((unsigned char)s->device_token[i] < 33 || (unsigned char)s->device_token[i] > 126) return false;
    return true;
}
void cp_settings_clear_sensitive(cp_settings_t *s)
{
    if (!s) return;
    volatile unsigned char *p=(volatile unsigned char *)s;
    for (size_t i=0;i<sizeof(*s);++i) p[i]=0;
}
