#pragma once
#include "cJSON.h"
#include "cp_v3_evidence.h"
#include <math.h>
#include <stdio.h>
#include <string.h>

typedef struct {
    char id[65],boot_id[37],capability_sha256[65],place_id[65],dataset[17],ruleset[65];
    uint64_t from_generation,expires_ms;
    bool pending;
} edge_online_transition_t;
static inline cJSON *edge_online_parse(const void *data,size_t length) {
    if(!data||!length||length>16384)return NULL;
    const char *bytes=data,*end=NULL;cJSON *root=cJSON_ParseWithLengthOpts(bytes,length,&end,false);
    if(!root)return NULL;
    while(end<bytes+length&&(*end==' '||*end=='\r'||*end=='\n'||*end=='\t'))end++;
    if(end!=bytes+length||!cJSON_IsObject(root)){cJSON_Delete(root);return NULL;}return root;
}
static inline bool edge_online_fields(const cJSON *o,const char *const *keys,size_t count) {
    if(!cJSON_IsObject(o))return false;
    size_t seen=0;const cJSON *item;
    cJSON_ArrayForEach(item,o) {
        bool found=false;for(size_t i=0;i<count;i++)if(item->string&&!strcmp(item->string,keys[i])){found=true;break;}
        if(!found)return false;
        for(const cJSON *other=item->next;other;other=other->next)if(other->string&&!strcmp(item->string,other->string))return false;
        seen++;
    }return seen==count;
}
static inline const char *edge_online_text(const cJSON *o,const char *key) {
    const cJSON *v=cJSON_GetObjectItemCaseSensitive(o,key);return cJSON_IsString(v)?v->valuestring:NULL;
}
static inline bool edge_online_equal(const cJSON *o,const char *key,const char *value) {
    const char *s=edge_online_text(o,key);return s&&value&&!strcmp(s,value);
}
static inline bool edge_online_u64(const cJSON *o,const char *key,uint64_t *out) {
    const cJSON *n=cJSON_GetObjectItemCaseSensitive(o,key);
    if(!cJSON_IsNumber(n)||!isfinite(n->valuedouble)||n->valuedouble<0||n->valuedouble>9007199254740991.0)return false;
    uint64_t value=(uint64_t)n->valuedouble;if((double)value!=n->valuedouble)return false;*out=value;return true;
}
static inline bool edge_online_hash(const char *s) {
    if(!s||strlen(s)!=64)return false;
    for(unsigned i=0;i<64;i++)if(!((s[i]>='0'&&s[i]<='9')||(s[i]>='a'&&s[i]<='f')))return false;
    return true;
}
static inline bool edge_online_id(const char *s) {
    if(!s||!*s||strlen(s)>64)return false;
    for(unsigned i=0;s[i];i++)if(!((s[i]>='a'&&s[i]<='z')||(s[i]>='0'&&s[i]<='9')||(i&&(s[i]=='_'||s[i]=='-'))))return false;
    return true;
}
static inline bool edge_online_iso(const char *s,uint64_t *out) {
    if(!s||strlen(s)!=24||s[4]!='-'||s[7]!='-'||s[10]!='T'||s[13]!=':'||s[16]!=':'||s[19]!='.'||s[23]!='Z')return false;
    for(unsigned i=0;i<24;i++)if(i!=4&&i!=7&&i!=10&&i!=13&&i!=16&&i!=19&&i!=23&&(s[i]<'0'||s[i]>'9'))return false;
    unsigned y=0,m=0,d=0,h=0,n=0,sec=0,ms=0;
    if(sscanf(s,"%4u-%2u-%2uT%2u:%2u:%2u.%3uZ",&y,&m,&d,&h,&n,&sec,&ms)!=7||y<1970||m<1||m>12||!d||h>23||n>59||sec>59)return false;
    static const unsigned days[]={31,28,31,30,31,30,31,31,30,31,30,31};
    bool leap=y%4==0&&(y%100!=0||y%400==0);if(d>days[m-1]+(m==2&&leap))return false;
    unsigned a=y-(m<=2),era=a/400,yoe=a-era*400;
    unsigned doy=(153*(m>2?m-3:m+9)+2)/5+d-1,doe=yoe*365+yoe/4-yoe/100+doy;
    uint64_t day=(uint64_t)era*146097+doe-719468;
    *out=(((day*24+h)*60+n)*60+sec)*1000+ms;return true;
}
static inline bool edge_online_transition(const void *body,size_t bytes,const char *boot,uint64_t generation,
    const char *capability,cp_v3_time_t now,edge_online_transition_t *out) {
    cJSON *root=edge_online_parse(body,bytes);if(!root)return false;
    const cJSON *t=cJSON_GetObjectItemCaseSensitive(root,"online_transition");
    const char *const keys[]={"id","boot_id","from_generation","capability_sha256","expires_at","phase","target_place_id","target_dataset","target_ruleset"};
    const char *id=edge_online_text(t,"id"),*place=edge_online_text(t,"target_place_id"),*dataset=edge_online_text(t,"target_dataset"),*rules=edge_online_text(t,"target_ruleset");
    uint64_t from=0,expiry=0;
    bool okay=edge_online_fields(t,keys,9)&&edge_online_id(id)&&edge_online_id(place)&&
        edge_online_equal(t,"boot_id",boot)&&edge_online_equal(t,"capability_sha256",capability)&&edge_online_u64(t,"from_generation",&from)&&from==generation&&
        edge_online_iso(edge_online_text(t,"expires_at"),&expiry)&&expiry>now.utc_ms+now.uncertainty_ms&&
        (edge_online_equal(t,"phase","pending")||edge_online_equal(t,"phase","assigned"))&&dataset&&
        (!strcmp(dataset,"field")||!strcmp(dataset,"demo")||!strcmp(dataset,"controlled_test"))&&rules&&
        (!strcmp(rules,"unclassified-v1")||!strcmp(rules,"cp-v3-vehicle-candidates/1"));
    if(okay){memset(out,0,sizeof *out);strcpy(out->id,id);strcpy(out->place_id,place);strcpy(out->dataset,dataset);strcpy(out->ruleset,rules);
        strcpy(out->boot_id,boot);strcpy(out->capability_sha256,capability);out->from_generation=from;out->expires_ms=expiry;out->pending=edge_online_equal(t,"phase","pending");}
    cJSON_Delete(root);return okay;
}
static inline bool edge_online_config_generation(const void *body,size_t bytes,uint64_t *out) {
    cJSON *root=edge_online_parse(body,bytes);if(!root)return false;
    const cJSON *config=cJSON_GetObjectItemCaseSensitive(root,"config"),*policy=cJSON_GetObjectItemCaseSensitive(config,"policy");
    bool result=edge_online_u64(policy,"assignment_generation",out)&&*out;cJSON_Delete(root);return result;
}
static inline bool edge_online_is_ready(const void *body,size_t bytes) {
    cJSON *root=edge_online_parse(body,bytes);if(!root)return false;
    bool ready=edge_online_equal(root,"schema","scope-transition-ready/1");cJSON_Delete(root);return ready;
}
static inline bool edge_online_ready_matches(const cp_v3_expected_t *expected,const void *body,size_t bytes,
    const void *receipt,size_t length,cp_v3_sha256_fn sha,void *ctx) {
    cJSON *request=edge_online_parse(body,bytes),*reply=edge_online_parse(receipt,length);bool okay=false;
    const char *const request_keys[]={"protocol","schema","transition_id","boot_id","from_generation","capability_sha256",
        "closed_window_seq","closed_segment_seq","clock_epoch","uptime_ms","observation_upper_ms"};
    const char *const receipt_keys[]={"protocol","schema","transition_id","boot_id","from_generation",
        "closed_window_seq","closed_segment_seq","clock_epoch","uptime_ms","node_id","body_sha256",
        "assignment_generation","policy_sha256","server_time","durability","evidence"};
    uint8_t digest[32];char hash[65];uint64_t from=0,new_generation=0,upper=0,server=0;
    if(!expected||!request||!reply||!sha||!sha(ctx,body,bytes,digest))goto done;
    for(unsigned i=0;i<32;i++)snprintf(hash+2*i,3,"%02x",digest[i]);
    if(!edge_online_fields(request,request_keys,11)||!edge_online_fields(reply,receipt_keys,16)||
       !edge_online_equal(request,"protocol","campuspulse/3")||!edge_online_equal(request,"schema","scope-transition-ready/1")||
       !edge_online_equal(reply,"protocol","campuspulse/3")||!edge_online_equal(reply,"schema","scope-transition-ready-receipt/1")||
       !edge_online_equal(request,"boot_id",expected->scope.boot_id)||!edge_online_equal(reply,"node_id",expected->scope.node_id)||
       !edge_online_equal(reply,"body_sha256",hash)||strcmp(hash,expected->body_sha256)||
       !edge_online_equal(reply,"durability","committed")||!edge_online_equal(reply,"evidence","device_pause")||
       !edge_online_id(edge_online_text(request,"transition_id"))||!edge_online_hash(edge_online_text(request,"capability_sha256"))||
       !edge_online_hash(edge_online_text(reply,"policy_sha256"))||!edge_online_u64(request,"from_generation",&from)||from!=expected->scope.assignment_generation||
       !edge_online_u64(reply,"assignment_generation",&new_generation)||new_generation<=from||
       !edge_online_u64(request,"observation_upper_ms",&upper)||!edge_online_iso(edge_online_text(reply,"server_time"),&server)||server<upper)goto done;
    const char *strings[]={"transition_id","boot_id"};
    for(unsigned i=0;i<2;i++)if(!edge_online_equal(reply,strings[i],edge_online_text(request,strings[i])))goto done;
    const char *numbers[]={"from_generation","closed_window_seq","closed_segment_seq","clock_epoch","uptime_ms"};
    for(unsigned i=0;i<5;i++){uint64_t a,b;if(!edge_online_u64(request,numbers[i],&a)||!edge_online_u64(reply,numbers[i],&b)||a!=b)goto done;
        if(i>=1&&i<=3&&(a>UINT32_MAX||(i==3&&!a)))goto done;}
    okay=true;
done:cJSON_Delete(request);cJSON_Delete(reply);return okay;
}
