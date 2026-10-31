#pragma once
#include "cp_v3_transport.h"
#include <stdio.h>
#include <string.h>
#define CP_V3_MQTT_HEADER_BYTES 8u
#define CP_V3_MQTT_TOPIC_BYTES 104u
#define CP_V3_MQTT_FRAME_MAX (CP_V3_MQTT_HEADER_BYTES+CP_V3_MQTT_REQUEST_MAX)
typedef struct {
    char topic[CP_V3_MQTT_TOPIC_BYTES];
    uint8_t reply[CP_V3_MQTT_RESPONSE_MAX+3u];
    size_t total,used;
    int publish_id,puback_id;
    bool active,assembling,complete,failed;
} cp_v3_mqtt_rpc_t;
typedef struct {
    char boot[37],node[16],topic_namespace[16];
    uint32_t sequence;
    bool bound;
} cp_v3_mqtt_identity_t;
/* Boot-lifetime state, independent of connection/RPC/credential clearing.
 * Never invent another boot to evade a gateway's per-boot high-water mark. */
static inline bool cp_v3_mqtt_identity_bind(cp_v3_mqtt_identity_t *i,const char *node,const char *ns,const char *boot){
    if(!i||!node||!ns||!boot||!strlen(node)||strlen(node)>=sizeof i->node||!strlen(ns)||strlen(ns)>=sizeof i->topic_namespace||strlen(boot)!=36)return false;
    if(i->bound)return !strcmp(i->node,node)&&!strcmp(i->topic_namespace,ns)&&!strcmp(i->boot,boot);
    strcpy(i->node,node);strcpy(i->topic_namespace,ns);strcpy(i->boot,boot);i->bound=true;return true;
}
static inline bool cp_v3_mqtt_identity_next(cp_v3_mqtt_identity_t *i,uint32_t *out){
    if(!i||!i->bound||!out||i->sequence==UINT32_MAX)return false;
    *out=++i->sequence;return true;
}
static inline bool cp_v3_mqtt_boot_valid(const char *boot){
    if(!boot||strlen(boot)!=36||boot[14]!='4'||!strchr("89ab",boot[19]))return false;
    for(unsigned i=0;i<36;i++){
        if(i==8||i==13||i==18||i==23){if(boot[i]!='-')return false;}
        else if(!strchr("0123456789abcdef",boot[i]))return false;
    }return true;
}
static inline bool cp_v3_mqtt_config_valid(const cp_settings_t *settings,const cp_v3_transport_config_t *config){
    return settings&&config&&config->mode==CP_V3_TRANSPORT_MQTT_TLS&&config->origin&&
        !strcmp(config->origin,CP_API_ORIGIN)&&!config->server_ca_pem&&cp_v3_mqtt_boot_valid(config->active_boot)&&
        cp_settings_mqtt_ready(settings);
}
static inline unsigned cp_v3_mqtt_subop(cp_v3_http_method_t method,const char *path,bool receipt_only){
    if(!path)return 0;
    unsigned op=0;
    if(method==CP_V3_HTTP_POST){
        if(!strcmp(path,"/api/v3/device/capabilities"))op=1;
        else if(!strcmp(path,"/api/v3/device/config/ack"))op=3;
        else if(!strcmp(path,"/api/v3/device/lease"))op=4;
        else if(!strcmp(path,"/api/v3/statistics/ingest"))op=5;
    }else if(method==CP_V3_HTTP_GET&&!strncmp(path,"/api/v3/device/config?boot_id=",30))op=2;
    return receipt_only&&op!=3&&op!=4?0:op;
}
static inline bool cp_v3_mqtt_frame(unsigned op,bool receipt_only,const void *body,size_t bytes,uint8_t *out,size_t capacity,size_t *length){
    if(length)*length=0;
    if(!length||!out||op<1||op>5||bytes>CP_V3_MQTT_REQUEST_MAX||capacity<bytes+8||
       (bytes&&!body)||(op==2?bytes!=0:bytes==0)||(receipt_only&&op!=3&&op!=4))return false;
    const uint8_t header[8]={'C','P','V','3',1,(uint8_t)op,receipt_only?1:0,0};
    memcpy(out,header,8);if(bytes)memcpy(out+8,body,bytes);*length=bytes+8;return true;
}
/* Bounded correlation and fragment assembly with independent V3 storage. */
static inline bool cp_v3_mqtt_begin(cp_v3_mqtt_rpc_t *r,const char *topic){
    if(!r||!topic||strlen(topic)>=sizeof r->topic||r->active)return false;
    memset(r,0,sizeof *r);strcpy(r->topic,topic);r->active=true;r->publish_id=r->puback_id=-1;return true;
}
static inline void cp_v3_mqtt_data(cp_v3_mqtt_rpc_t *r,const char *topic,int topic_bytes,
    const void *data,int bytes,int offset,int total,int qos,bool retained){
    if(!r->active||r->failed||r->complete)return;
    if(offset==0){
        if(!topic||topic_bytes<0||(size_t)topic_bytes!=strlen(r->topic)||memcmp(topic,r->topic,(size_t)topic_bytes))return;
        r->assembling=false;
        if(qos||retained||total<2||total>(int)CP_V3_MQTT_RESPONSE_MAX+2){r->failed=true;return;}
        r->used=0;r->total=(size_t)total;r->assembling=true;
    }
    if(!r->assembling)return;
    if(bytes<0||offset<0||total<0||topic_bytes<0||(size_t)offset!=r->used||(size_t)total!=r->total||
       (size_t)bytes>r->total-r->used||(bytes&&!data)||qos||retained||
       (topic_bytes>0&&(!topic||(size_t)topic_bytes!=strlen(r->topic)||memcmp(topic,r->topic,(size_t)topic_bytes)))){
        r->failed=true;r->assembling=false;return;
    }
    if(bytes)memcpy(r->reply+r->used,data,(size_t)bytes);
    r->used+=(size_t)bytes;
    if(r->used==r->total){unsigned status=((unsigned)r->reply[0]<<8)|r->reply[1];
        if(status<100||status>599){r->failed=true;return;}
        r->reply[r->used]=0;r->complete=true;r->assembling=false;
    }
}
static inline bool cp_v3_mqtt_done(const cp_v3_mqtt_rpc_t *r,size_t outbox){
    return r->active&&!r->failed&&r->complete&&r->publish_id>0&&r->publish_id==r->puback_id&&!outbox;
}
static inline void cp_v3_mqtt_puback(cp_v3_mqtt_rpc_t *r,int id){
    if(r->active&&id>0&&(r->publish_id<0||r->publish_id==id))r->puback_id=id;
}
