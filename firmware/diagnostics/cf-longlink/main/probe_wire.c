#include "probe_wire.h"
#include <string.h>
#include "cJSON.h"

void probe_hex(const uint8_t *in,size_t bytes,char *out)
{
    static const char hex[]="0123456789abcdef";
    for(size_t i=0;i<bytes;i++){out[2*i]=hex[in[i]>>4];out[2*i+1]=hex[in[i]&15];}
    out[2*bytes]=0;
}
void probe_payload(uint8_t *out,size_t bytes,const uint8_t run[16],uint32_t seq)
{
    if(bytes<20)return;
    memcpy(out,run,16);
    for(unsigned i=0;i<4;i++)out[16+i]=(uint8_t)(seq>>(24-8*i));
    for(size_t i=20;i<bytes;i++)out[i]=(uint8_t)((i*31u+seq*17u)&255u);
}
static bool field(const cJSON *root,const char *key,const char *expected)
{
    const cJSON *v=cJSON_GetObjectItemCaseSensitive(root,key);
    return cJSON_IsString(v)&&v->valuestring&&strcmp(v->valuestring,expected)==0;
}
static bool uuid(const char *s)
{
    if(strlen(s)!=36)return false;
    for(unsigned i=0;i<36;i++){
        if(i==8||i==13||i==18||i==23){if(s[i]!='-')return false;}
        else if(!((s[i]>='0'&&s[i]<='9')||(s[i]>='a'&&s[i]<='f')))return false;
    }
    return s[14]=='4'&&strchr("89ab",s[19]);
}
bool probe_receipt(const char *json,size_t length,const char *run,uint32_t seq,
    size_t bytes,const char *sha,probe_receipt_t *out)
{
    if(!json||!length||length>=PROBE_RECEIPT_CAP||strlen(run)!=32||strlen(sha)!=64||memchr(json,0,length))return false;
    // This flat receipt has no nested values. Reject nesting before cJSON's
    // recursive parser so bounded hostile JSON cannot exhaust the C3 stack.
    bool quoted=false,escape=false;unsigned depth=0;
    for(size_t i=0;i<length;i++){
        char c=json[i];
        if(quoted){if(escape)escape=false;else if(c=='\\')escape=true;else if(c=='"')quoted=false;}
        else if(c=='"')quoted=true;
        else if(c=='['||c==']')return false;
        else if(c=='{'){if(++depth>1)return false;}
        else if(c=='}'){if(!depth)return false;depth--;}
    }
    if(quoted||depth)return false;
    char bounded[PROBE_RECEIPT_CAP];memcpy(bounded,json,length);bounded[length]=0;
    cJSON *root=cJSON_ParseWithLengthOpts(bounded,length+1,NULL,true);
    bool valid=cJSON_IsObject(root);
    // Reject duplicates and unexpected fields rather than accepting ambiguous correlations.
    static const char *keys[]={"protocol","kind","run_id","seq","bytes","sha256","connection_id","colo"};
    unsigned seen=0;
    for(const cJSON *v=root?root->child:NULL;v;v=v->next){
        unsigned i=0;for(;i<8;i++)if(v->string&&strcmp(v->string,keys[i])==0)break;
        if(i==8||(seen&(1u<<i))){valid=false;break;}seen|=1u<<i;
    }
    const cJSON *n=cJSON_GetObjectItemCaseSensitive(root,"seq"),*b=cJSON_GetObjectItemCaseSensitive(root,"bytes");
    const cJSON *id=cJSON_GetObjectItemCaseSensitive(root,"connection_id"),*colo=cJSON_GetObjectItemCaseSensitive(root,"colo");
    valid=valid&&seen==255&&field(root,"protocol","cp-link-probe/1")&&field(root,"kind","transport_received")
        &&field(root,"run_id",run)&&field(root,"sha256",sha)&&cJSON_IsNumber(n)&&n->valuedouble==(double)seq
        &&cJSON_IsNumber(b)&&b->valuedouble==(double)bytes&&cJSON_IsString(id)&&uuid(id->valuestring)
        &&cJSON_IsString(colo)&&strlen(colo->valuestring)>=3&&strlen(colo->valuestring)<=8;
    if(valid)for(const char *p=colo->valuestring;*p;p++)if(!(*p>='A'&&*p<='Z'))valid=false;
    if(valid){strcpy(out->connection_id,id->valuestring);strcpy(out->colo,colo->valuestring);}
    cJSON_Delete(root);return valid;
}
int probe_fragment(probe_assembly_t *s,unsigned opcode,bool fin,int offset,int frame_size,
    const char *data,int length)
{
    if(opcode!=0&&opcode!=1)return 0;
    if(offset==0){
        if(opcode==1){
            if(s->active){s->active=false;return -1;}
            s->used=0;s->overflow=false;s->active=true;
        }
        s->frame_offset=0;s->frame_size=frame_size<0?0:(size_t)frame_size;
    }
    if(!s->active||offset<0||length<0||frame_size<0||(!data&&length)
        ||(size_t)offset!=s->frame_offset||(size_t)frame_size!=s->frame_size
        ||s->frame_offset>s->frame_size||(size_t)length>s->frame_size-s->frame_offset
        ||(size_t)length>sizeof(s->buffer)-1-s->used){s->overflow=true;s->active=false;return -1;}
    memcpy(s->buffer+s->used,data,length);s->used+=length;s->frame_offset+=length;
    if(fin&&s->frame_offset==s->frame_size){s->active=false;return 1;}
    return 0;
}
