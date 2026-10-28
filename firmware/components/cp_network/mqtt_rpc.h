#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#define CP_MQTT_REPLY_MAX 2048u
#define CP_MQTT_TOPIC_CAP 104u
#define CP_MQTT_BODY_MAX 8192u
#define CP_MQTT_TASK_STACK 6144u
#define CP_MQTT_IO_BUFFER 1024u
#define CP_MQTT_OUTBOX_LIMIT 12288u
#define CP_MQTT_USERNAME_MAX 128u
#define CP_MQTT_PASSWORD_MAX 256u
/* Cold admission includes the existing TLS floor plus the MQTT task, two IO
 * buffers, handshake/SDK metadata allowance and an application reserve. These
 * are conservative admission floors, not a claim of measured C3 headroom. */
#define CP_MQTT_COLD_FREE (56u*1024u)
#define CP_MQTT_COLD_LARGEST (20u*1024u)
/* Dynamic TLS RX can allocate 17058 B, TX 4437 B on the pinned C3 build.
 * IO/encoder mutual exclusion removes idle RX residency, not wire limits.
 * The IO gate serializes new RX/TX allocations; retained buffers are already
 * charged to the sampled free heap. Reserve the larger new allocation plus
 * 3422 B metadata/runtime slack. Per-request
 * growth is one QoS1 copy (body + <=104 topic + header + metadata), plus a copied
 * <=2049 response; cached RX may coexist with a write. */
#define CP_MQTT_HOT_RESERVE (20u*1024u)
#define CP_MQTT_PACKET_ALLOWANCE 256u
/* Even a small MQTT reply may arrive in a maximum-size TLS record. */
#define CP_MQTT_HOT_LARGEST 17058u

typedef struct {
    char reply_topic[CP_MQTT_TOPIC_CAP];
    unsigned char reply[CP_MQTT_REPLY_MAX+3u];
    size_t total,used;
    int publish_id,last_puback;
    bool active,assembling,complete,failed;
} cp_mqtt_rpc_t;

static inline bool cp_mqtt_uri_valid(const char *uri)
{
    if(!uri||strncmp(uri,"wss://",6))return false;
    const char *host=uri+6,*slash=strchr(host,'/');
    if(!slash||slash==host||strcmp(slash,"/mqtt")||slash-host>253)return false;
    /* Public DNS host only: no credentials, query, fragment, IPv6 literals,
     * control bytes or custom route. An optional explicit TLS port is allowed. */
    bool port=false,has_digit=false;
    unsigned port_value=0;
    for(const char *p=host;p<slash;++p) {
        if(*p==':'&&!port&&p>host){port=true;continue;}
        if(port) {if(*p<'0'||*p>'9')return false;has_digit=true;
            port_value=port_value*10u+(unsigned)(*p-'0');if(port_value>65535u)return false;}
        else if(!((*p>='a'&&*p<='z')||(*p>='A'&&*p<='Z')||
                  (*p>='0'&&*p<='9')||*p=='.'||*p=='-'))return false;
    }
    return !port||(has_digit&&port_value>0);
}
/* Native TLS accepts a bounded DNS authority only. Validating before SDK URI
 * parsing prevents its error logs from receiving credentials or query data.
 * Keep the WSS compatibility validator above unchanged. */
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
static inline bool cp_mqtt_credential_valid(const char *value,size_t max)
{
    if(!value||!*value)return false;
    for(size_t i=0;i<=max;++i) {
        unsigned char c=(unsigned char)value[i];
        if(!c)return true;
        if(c<0x20u||c>0x7eu||i==max)return false;
    }
    return false;
}
static inline bool cp_mqtt_cold_budget(size_t free_bytes,size_t largest)
{return free_bytes>=CP_MQTT_COLD_FREE&&largest>=CP_MQTT_COLD_LARGEST;}
static inline bool cp_mqtt_hot_budget(size_t free_bytes,size_t largest,size_t body)
{
    if(body>CP_MQTT_BODY_MAX)return false;
    size_t packet=body+CP_MQTT_PACKET_ALLOWANCE;
    return free_bytes>=CP_MQTT_HOT_RESERVE+packet+CP_MQTT_REPLY_MAX+1u &&
        largest>=(packet>CP_MQTT_HOT_LARGEST?packet:CP_MQTT_HOT_LARGEST);
}
static inline bool cp_mqtt_allocation_budget(size_t free_bytes,size_t largest,size_t allocation)
{
    if(allocation>CP_MQTT_BODY_MAX+1u)return false;
    size_t body=allocation?allocation-1u:0u;
    /* Called BEFORE caller allocates its immutable journal body. Account for
     * both that body and the independent QoS1 outbox copy. */
    return free_bytes>=allocation && cp_mqtt_hot_budget(free_bytes-allocation,largest,body) &&
        largest>=allocation;
}
/* Call under the small state lock, never while holding an SDK API lock. */
static inline bool cp_mqtt_rpc_begin(cp_mqtt_rpc_t *s,const char *topic)
{
    if(!s||!topic||strlen(topic)>=sizeof(s->reply_topic)||s->active)return false;
    memset(s,0,sizeof(*s));strcpy(s->reply_topic,topic);
    s->publish_id=s->last_puback=-1;s->active=true;return true;
}
static inline void cp_mqtt_rpc_cancel(cp_mqtt_rpc_t *s)
{s->active=s->assembling=false;}
static inline void cp_mqtt_rpc_publish_id(cp_mqtt_rpc_t *s,int id)
{if(s->active){s->publish_id=id;if(id<=0)s->failed=true;}}
static inline void cp_mqtt_rpc_puback(cp_mqtt_rpc_t *s,int id)
{if(s->active&&id>0)s->last_puback=id;}
static inline void cp_mqtt_rpc_fail(cp_mqtt_rpc_t *s)
{if(s->active&&!s->complete){s->failed=true;s->assembling=false;}}
/* First fragments must identify the exact in-flight RPC. Unmatched/late
 * responses are ignored; malformed matching responses fail the RPC closed.
 * Continuations may omit topic (ESP-MQTT does); every offset/total is checked. */
static inline void cp_mqtt_rpc_data(cp_mqtt_rpc_t *s,const char *topic,int topic_len,
    const void *data,int length,int offset,int total,int qos,bool retain)
{
    if(!s->active||s->failed||s->complete)return;
    if(offset==0) {
        s->assembling=false;
        if(!topic||topic_len<0||(size_t)topic_len!=strlen(s->reply_topic)||
           memcmp(topic,s->reply_topic,(size_t)topic_len))return;
        if(qos!=0||retain||total<2||total>(int)CP_MQTT_REPLY_MAX+2){cp_mqtt_rpc_fail(s);return;}
        s->total=(size_t)total;s->used=0;s->assembling=true;
    }
    if(!s->assembling)return;
    if(offset<0||length<0||total<0||(size_t)offset!=s->used||
       (size_t)total!=s->total||(size_t)length>s->total-s->used||
       (length&&!data)||qos!=0||retain||
       (topic_len>0&&(!topic||(size_t)topic_len!=strlen(s->reply_topic)||
        memcmp(topic,s->reply_topic,(size_t)topic_len)))) {cp_mqtt_rpc_fail(s);return;}
    if(length)memcpy(s->reply+s->used,data,(size_t)length);
    s->used+=(size_t)length;
    if(s->used==s->total) {
        unsigned status=((unsigned)s->reply[0]<<8)|s->reply[1];
        if(status<100||status>599){cp_mqtt_rpc_fail(s);return;}
        s->reply[s->used]=0;s->complete=true;s->assembling=false;
    }
}
static inline bool cp_mqtt_rpc_done(const cp_mqtt_rpc_t *s,size_t outbox)
{return s->active&&!s->failed&&s->complete&&s->publish_id>0&&s->last_puback==s->publish_id&&outbox==0;}

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
