#pragma once
/* V3 native MQTT resource admission and confirmed-stop lifetime helpers.
 * Extracted from the retired shared network component; no legacy wire codec. */
#include <stdbool.h>
#include <stddef.h>
#include <string.h>
#define CP_MQTT_TASK_STACK 6144u
#define CP_MQTT_IO_BUFFER 1024u
#define CP_MQTT_OUTBOX_LIMIT 12288u
#define CP_MQTT_COLD_FREE (56u*1024u)
#define CP_MQTT_COLD_LARGEST (20u*1024u)
#define CP_MQTT_HOT_RESERVE (20u*1024u)
#define CP_MQTT_PACKET_ALLOWANCE 256u
#define CP_MQTT_HOT_LARGEST 17058u
static inline bool cp_mqtt_native_uri_valid(const char *uri)
{
    if(!uri||strncmp(uri,"mqtts://",8))return false;
    const char *host=uri+8,*p=host;
    size_t label=0;bool has_alpha=false;
    while(*p&&*p!=':') {
        if((size_t)(p-host)>=253u)return false;
        unsigned char c=(unsigned char)*p;
        bool alnum=(c>='a'&&c<='z')||(c>='A'&&c<='Z')||(c>='0'&&c<='9');
        if(c=='.') {if(!label||p[-1]=='-')return false;label=0;}
        else {
            if(!alnum&&c!='-')return false;
            if(!label&&c=='-')return false;
            if(++label>63u)return false;
            if((c>='a'&&c<='z')||(c>='A'&&c<='Z'))has_alpha=true;
        }
        ++p;
    }
    /* IP literals, trailing dots and empty labels are deliberately excluded. */
    if(!label||p[-1]=='-'||!has_alpha)return false;
    if(!*p)return true;
    unsigned port=0,digits=0;
    while(*++p) {
        if(*p<'0'||*p>'9'||++digits>5u)return false;
        port=port*10u+(unsigned)(*p-'0');
    }
    return digits&&port>0&&port<=65535u;
}
static inline bool cp_mqtt_cold_budget(size_t free_bytes,size_t largest)
{return free_bytes>=CP_MQTT_COLD_FREE&&largest>=CP_MQTT_COLD_LARGEST;}
/* A failed/unknown stop retains every object reachable by SDK callbacks. The
 * caller must never zero/reset this lease until release has succeeded. */
typedef struct { void *client;bool started,retained; } cp_mqtt_lease_t;
typedef struct { int (*stop)(void *);int (*destroy)(void *); } cp_mqtt_lease_ops_t;
static inline int cp_mqtt_lease_release(cp_mqtt_lease_t *s,const cp_mqtt_lease_ops_t *ops)
{
    if(s->retained)return -1;
    if(s->client&&s->started){int e=ops->stop(s->client);if(e){s->retained=true;return e;}s->started=false;}
    if(s->client){int e=ops->destroy(s->client);if(e){s->retained=true;return e;}s->client=NULL;}
    return 0;
}
