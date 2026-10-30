#include "cp_network.h"
#include "protocol_internal.h"
/* Share only the compile-time limit; do not add a component dependency cycle. */
#include "../cp_collect/include/cp_collect_limits.h"
#include "cJSON.h"
#include <math.h>
#include <stdio.h>
#include <string.h>
#ifdef CP_NETWORK_HOST_TEST
#include <openssl/sha.h>
#else
#include "mbedtls/sha256.h"
#endif
static const cJSON *field(const cJSON *o, const char *key) { return cJSON_GetObjectItemCaseSensitive(o,key); }
static bool equals(const cJSON *o, const char *key, const char *v)
{ const cJSON *x=field(o,key); return cJSON_IsString(x) && x->valuestring && strcmp(x->valuestring,v)==0; }
static bool number(const cJSON *o, const char *key, uint64_t min, uint64_t max, uint64_t *out)
{
    const cJSON *x=field(o,key);
    if (!cJSON_IsNumber(x) || !isfinite(x->valuedouble) || floor(x->valuedouble)!=x->valuedouble ||
        x->valuedouble<(double)min || x->valuedouble>(double)max) return false;
    if (out) *out=(uint64_t)x->valuedouble;
    return true;
}
static bool copy_string(const cJSON *o, const char *key, char *out, size_t cap)
{
    const cJSON *x=field(o,key);
    if (!cJSON_IsString(x) || !x->valuestring || !x->valuestring[0] || strlen(x->valuestring)>=cap) return false;
    strcpy(out,x->valuestring); return true;
}
static bool id_valid(const char *s)
{ for (;*s;++s) if (!((*s>='a'&&*s<='z')||(*s>='0'&&*s<='9')||*s=='_'||*s=='-')) return false; return true; }
static bool unique_tree(const cJSON *o, unsigned depth)
{
    if (depth>12) return false;
    for (const cJSON *a=o->child;a;a=a->next) {
        if (cJSON_IsObject(o)) {
            if (!a->string) return false;
            for (const cJSON *b=a->next;b;b=b->next)
                if (!b->string || strcmp(a->string,b->string)==0) return false;
        }
        if (!unique_tree(a,depth+1)) return false;
    }
    return true;
}
static cJSON *parse(const char *text, size_t length)
{
    if (!text || !length || length>CP_NETWORK_BODY_MAX || memchr(text,0,length)) return NULL;
    /* cJSON represents decoded strings as C strings: disallow embedded NUL. */
    for (size_t i=0;i+5<length;++i) if (!memcmp(text+i,"\\u0000",6)) return NULL;
    unsigned depth=0; bool quoted=false, escaped=false;
    for (size_t i=0;i<length;++i) {
        char c=text[i];
        if (quoted) {
            if (escaped) escaped=false;
            else if (c=='\\') escaped=true;
            else if (c=='"') quoted=false;
        } else if (c=='"') quoted=true;
        else if (c=='{' || c=='[') { if (++depth>12) return NULL; }
        else if (c=='}' || c==']') { if (!depth) return NULL; --depth; }
    }
    if (quoted || depth) return NULL;
    const char *end=NULL;
    cJSON *o=cJSON_ParseWithLengthOpts(text,length,&end,false);
    if (!o) return NULL;
    while (end<text+length && (*end==' ' || *end=='\r' || *end=='\n' || *end=='\t')) ++end;
    if (end!=text+length || !cJSON_IsObject(o) || !unique_tree(o,0)) { cJSON_Delete(o); return NULL; }
    return o;
}
static bool exact_keys(const cJSON *o, const char *const *keys, size_t count)
{
    if (!cJSON_IsObject(o)) return false;
    size_t found=0;
    for (const cJSON *v=o->child;v;v=v->next) {
        bool match=false;
        for (size_t i=0;i<count;++i) if (!strcmp(keys[i],v->string)) { match=true; break; }
        if (!match) return false;
        ++found;
    }
    return found==count;
}
#define KEYS(obj, ...) exact_keys(obj,(const char *const[]){__VA_ARGS__},sizeof((const char *const[]){__VA_ARGS__})/sizeof(char *))
static bool date_ms(const char *s, uint64_t *out)
{
    if (strlen(s)!=24 || s[4]!='-'||s[7]!='-'||s[10]!='T'||s[13]!=':'||s[16]!=':'||s[19]!='.'||s[23]!='Z') return false;
    for (unsigned i=0;i<24;++i) if (i!=4&&i!=7&&i!=10&&i!=13&&i!=16&&i!=19&&i!=23 && (s[i]<'0'||s[i]>'9')) return false;
    unsigned y=0,m=0,d=0,h=0,n=0,z=0,ms=0;
    /* Fixed decimal fields, without libc scanning/locale initialization. */
    for(unsigned i=0;i<4;++i)y=y*10u+(unsigned)(s[i]-'0');
    for(unsigned i=0;i<2;++i){m=m*10u+(unsigned)(s[5+i]-'0');d=d*10u+(unsigned)(s[8+i]-'0');
        h=h*10u+(unsigned)(s[11+i]-'0');n=n*10u+(unsigned)(s[14+i]-'0');z=z*10u+(unsigned)(s[17+i]-'0');}
    for(unsigned i=0;i<3;++i)ms=ms*10u+(unsigned)(s[20+i]-'0');
    if (y<2020||y>2199||m<1||m>12||h>23||n>59||z>59) return false;
    static const unsigned days[]={31,28,31,30,31,30,31,31,30,31,30,31};
    bool leap=(y%4==0 && (y%100!=0||y%400==0));
    if (!d || d>days[m-1]+(m==2 && leap)) return false;
    uint64_t total=0;
    for (unsigned yr=1970;yr<y;++yr) total+=365+(yr%4==0 && (yr%100!=0||yr%400==0));
    for (unsigned mo=1;mo<m;++mo) total+=days[mo-1]+(mo==2 && leap);
    *out=(((total+d-1)*24+h)*60+n)*60000+z*1000+ms; return true;
}
bool cp_network_parse_policy(const char *json, size_t length, const char *node,
    cp_network_policy_t *out, bool *present, bool *expired)
{
    if (!out || !present || !expired || !node) return false;
    memset(out,0,sizeof(*out)); *present=false; *expired=false;
    cJSON *root=parse(json,length);
    if (!root) return false;
    bool ok=false;
    const cJSON *control=field(root,"control"), *config=field(root,"config"), *ex=field(root,"expired");
    uint64_t value=0;
    if (!equals(root,"protocol",CP_PROTOCOL) || !cJSON_IsBool(ex) ||
        !KEYS(control,"lease_ms") || !number(control,"lease_ms",1,CP_NETWORK_LEASE_MS,&out->lease_ms)) goto done;
    *expired=cJSON_IsTrue(ex);
    if (cJSON_IsNull(config)) { ok=true; goto done; }
    *present=true;
    if (!KEYS(config,"protocol","capture_config_id","node_id","placement_id","dataset","capture_profile","allowed_streams","scan","raw_capture","identity_scheme","accept_until","upload_policy","summary","control") ||
        !equals(config,"protocol",CP_PROTOCOL) || !equals(config,"node_id",node) ||
        !equals(config,"capture_profile","address_metrics") || !equals(config,"identity_scheme","mac") ||
        !copy_string(config,"capture_config_id",out->core.config_id,sizeof(out->core.config_id)) || !id_valid(out->core.config_id) ||
        !copy_string(config,"node_id",out->node_id,sizeof(out->node_id)) ||
        !copy_string(config,"placement_id",out->placement_id,sizeof(out->placement_id)) || !id_valid(out->placement_id) ||
        !copy_string(config,"dataset",out->dataset,sizeof(out->dataset)) ||
        !(equals(config,"dataset","field")||equals(config,"dataset","controlled_test")||equals(config,"dataset","demo"))) goto done;
    char accept[25];
    if (!copy_string(config,"accept_until",accept,sizeof(accept)) || !date_ms(accept,&out->core.upload_accept_until_utc_ms)) goto done;
    const cJSON *scan=field(config,"scan"), *summary=field(config,"summary"), *raw=field(config,"raw_capture"), *upload=field(config,"upload_policy"), *cc=field(config,"control");
    if (!KEYS(scan,"stack","adapter_version","mode","interval_ms","window_ms","filter_duplicates","host_filter") ||
        !equals(scan,"stack","nimble") || !equals(scan,"adapter_version",CP_NETWORK_ADAPTER) || !equals(scan,"host_filter","none") ||
        !copy_string(scan,"adapter_version",out->adapter_version,sizeof(out->adapter_version)) ||
        !(equals(scan,"mode","passive")||equals(scan,"mode","active")) || !cJSON_IsBool(field(scan,"filter_duplicates"))) goto done;
    out->scan_active=equals(scan,"mode","active"); out->filter_duplicates=cJSON_IsTrue(field(scan,"filter_duplicates"));
    if (!number(scan,"interval_ms",3,10240,&value)) goto done;
    out->scan_interval_ms=(uint32_t)value;
    if (!number(scan,"window_ms",3,value,&value)) goto done;
    out->scan_window_ms=(uint32_t)value;
    /* Integer milliseconds must map exactly to NimBLE 0.625 ms units. */
    if (out->scan_interval_ms%5 || out->scan_window_ms%5) goto done;
    if (!KEYS(summary,"window_ms","bin_ms","max_addresses") ||
        !number(summary,"window_ms",1000,300000,&value)) goto done;
    out->summary_window_ms=(uint32_t)value;
    if (!number(summary,"bin_ms",1000,out->summary_window_ms,&value)) goto done;
    out->summary_bin_ms=(uint32_t)value;
    /* Match the server's divisible-window contract within the collector's
     * native 16-bin bound. Policy-sized banks are admitted before scanning;
     * accepting a policy here does not bypass runtime heap/lease admission. */
    if (out->summary_window_ms%out->summary_bin_ms ||
        out->summary_window_ms/out->summary_bin_ms>16 ||
        !number(summary,"max_addresses",1,CP_COLLECT_ADDRESSES,&value)) goto done;
    out->max_addresses=(uint32_t)value;
    if (!KEYS(cc,"lease_ms") || !number(cc,"lease_ms",1,CP_NETWORK_LEASE_MS,&value)) goto done;
    if (value<out->lease_ms) out->lease_ms=value;
    if (equals(raw,"mode","off")) { if (!KEYS(raw,"mode")) goto done; }
    else if (equals(raw,"mode","sampled")) {
        if (!KEYS(raw,"mode","sample_every_n","selection","max_reports_per_window") || !equals(raw,"selection","seq_mod_n_eq_0") ||
            !number(raw,"sample_every_n",1,UINT32_MAX,&value)) goto done;
        out->raw_enabled=true; out->sample_every_n=(uint32_t)value;
        if (!number(raw,"max_reports_per_window",1,4,&value)) goto done;
        out->max_raw_per_window=(uint32_t)value;
    } else goto done;
    unsigned streams=0;
    const cJSON *array=field(config,"allowed_streams");
    if (!cJSON_IsArray(array)) goto done;
    for (const cJSON *s=array->child;s;s=s->next) {
        if (!cJSON_IsString(s)) goto done;
        unsigned flag=!strcmp(s->valuestring,"ble_windows")?1:!strcmp(s->valuestring,"address_summaries")?2:!strcmp(s->valuestring,"node_status")?4:!strcmp(s->valuestring,"ble_reports")?8:0;
        if (!flag || (streams&flag)) goto done;
        streams|=flag;
    }
    if (streams!=(out->raw_enabled?15u:7u)) goto done;
    if (!KEYS(upload,"max_items","max_body_bytes","flush_max_age_ms","warn_pct","raw_pause_pct","critical_pct","resume_pct","overload_action") ||
        !number(upload,"max_items",4,128,&value)) goto done;
    out->max_items=(uint32_t)(value>CP_NETWORK_ITEMS_MAX?CP_NETWORK_ITEMS_MAX:value);
    if (!number(upload,"max_body_bytes",4096,65536,&value)) goto done;
    out->max_body_bytes=(uint32_t)(value>CP_NETWORK_BODY_MAX?CP_NETWORK_BODY_MAX:value);
    if (!number(upload,"flush_max_age_ms",1,UINT32_MAX,&value)) goto done;
    out->flush_max_age_ms=(uint32_t)value;
    if (!number(upload,"resume_pct",0,100,&value)) goto done;
    out->resume_pct=(uint8_t)value;
    if (!number(upload,"warn_pct",out->resume_pct+1,100,&value)) goto done;
    out->warn_pct=(uint8_t)value;
    if (!number(upload,"raw_pause_pct",out->warn_pct+1,100,&value)) goto done;
    out->raw_pause_pct=(uint8_t)value;
    if (!number(upload,"critical_pct",out->raw_pause_pct+1,100,&value)) goto done;
    out->critical_pct=(uint8_t)value;
    if (!(equals(upload,"overload_action","pause_scan")||equals(upload,"overload_action","pause_raw"))) goto done;
    out->overload_pause_scan=equals(upload,"overload_action","pause_scan");
    out->core.ingress_queue_bytes=8192; out->core.required_capabilities=CP_CAP_BLE_SCAN; out->core.max_addresses=out->max_addresses;
    out->core.collection_enabled=!*expired; out->core.requires_trusted_clock=true;
    ok=true;
done:
    cJSON_Delete(root);
    if (!ok) memset(out,0,sizeof(*out));
    return ok;
}
static bool uuid_valid(const char *s)
{
    if (strlen(s)!=36 || s[14]!='4' || !(s[19]=='8'||s[19]=='9'||s[19]=='a'||s[19]=='b')) return false;
    for (unsigned i=0;i<36;++i) {
        if (i==8||i==13||i==18||i==23) { if (s[i]!='-') return false; }
        else if (!((s[i]>='0'&&s[i]<='9')||(s[i]>='a'&&s[i]<='f'))) return false;
    }
    return true;
}
bool cp_network_identity_valid(const char *node,const char *boot)
{
    if (!node || !boot || strlen(node)!=15 || strncmp(node,"cp_",3) || !uuid_valid(boot)) return false;
    for (unsigned i=3;i<15;++i) if (!((node[i]>='0'&&node[i]<='9')||(node[i]>='a'&&node[i]<='f'))) return false;
    return true;
}
bool cp_network_batch_valid(const cp_network_batch_t *batch)
{
    if (!batch || !memchr(batch->node_id,0,sizeof(batch->node_id)) || !memchr(batch->boot_id,0,sizeof(batch->boot_id)) ||
        !memchr(batch->batch_id,0,sizeof(batch->batch_id)) || !memchr(batch->stream,0,sizeof(batch->stream)) ||
        !memchr(batch->body_sha256,0,sizeof(batch->body_sha256)) ||
        !cp_network_identity_valid(batch->node_id,batch->boot_id) || !uuid_valid(batch->batch_id) ||
        strlen(batch->body_sha256)!=64 || !batch->accepted_count || batch->accepted_count>CP_NETWORK_ITEMS_MAX) return false;
    for (unsigned i=0;i<64;++i) if (!((batch->body_sha256[i]>='0'&&batch->body_sha256[i]<='9')||
        (batch->body_sha256[i]>='a'&&batch->body_sha256[i]<='f'))) return false;
    return !strcmp(batch->stream,"ble_windows")||!strcmp(batch->stream,"address_summaries")||
        !strcmp(batch->stream,"ble_reports")||!strcmp(batch->stream,"node_status");
}
bool cp_network_parse_ack(const char *json, size_t length, const cp_network_batch_t *e, cp_network_ack_t *ack)
{
    if (!cp_network_batch_valid(e) || !ack) return false;
    cJSON *o=parse(json,length);
    if (!o) return false;
    bool ok=KEYS(o,"node_id","boot_id","stream","batch_id","body_sha256","accepted_count","durability","receipt_id","received_at") &&
        equals(o,"node_id",e->node_id) && equals(o,"boot_id",e->boot_id) && equals(o,"stream",e->stream) &&
        equals(o,"batch_id",e->batch_id) && equals(o,"body_sha256",e->body_sha256) &&
        equals(o,"durability","committed") && number(o,"accepted_count",e->accepted_count,e->accepted_count,NULL) &&
        copy_string(o,"receipt_id",ack->receipt_id,sizeof(ack->receipt_id));
    char timestamp[25]; uint64_t ignored;
    ok=ok && copy_string(o,"received_at",timestamp,sizeof(timestamp)) && date_ms(timestamp,&ignored);
    cJSON_Delete(o); return ok;
}
typedef struct { const char *p,*end; } ack_reader_t;
typedef struct { const char *p; size_t length; } ack_string_t;
static void ack_space(ack_reader_t *r) {
    while(r->p<r->end&&(*r->p==' '||*r->p=='\t'||*r->p=='\r'||*r->p=='\n'))++r->p;
}
static bool ack_plain_string(ack_reader_t *r,ack_string_t *out) {
    if(r->p>=r->end||*r->p++!='"')return false;
    out->p=r->p;
    while(r->p<r->end&&*r->p!='"') {
        unsigned char c=(unsigned char)*r->p++;
        if(c<0x20||c>0x7e||c=='\\')return false;
    }
    if(r->p>=r->end)return false;
    out->length=(size_t)(r->p-out->p);++r->p;return true;
}
static bool ack_string_equals(ack_string_t s,const char *text) {
    return s.length==strlen(text)&&!memcmp(s.p,text,s.length);
}
cp_ack_canonical_result_t cp_network_parse_ack_canonical(const char *json,size_t length,
    const cp_network_batch_t *e,cp_network_ack_t *ack)
{
    if(!json||!ack||!length||length>CP_NETWORK_BODY_MAX||memchr(json,0,length)||
       !cp_network_batch_valid(e))return CP_ACK_CANONICAL_INVALID;
    ack_reader_t r={json,json+length};ack_space(&r);
    if(r.p>=r.end||*r.p++!='{')return CP_ACK_NEEDS_GENERAL;
    static const char *const keys[]={"node_id","boot_id","stream","batch_id","body_sha256",
        "accepted_count","durability","receipt_id","received_at"};
    const char *expected[]={e->node_id,e->boot_id,e->stream,e->batch_id,e->body_sha256,
        NULL,"committed",NULL,NULL};
    static const size_t capacities[]={16,37,24,65,65,0,10,65,25};
    char receipt[65]={0},timestamp[25]={0};unsigned seen=0;bool matches=true;
    for(;;) {
        ack_space(&r);ack_string_t key;
        if(!ack_plain_string(&r,&key))return CP_ACK_NEEDS_GENERAL;
        unsigned field=0;while(field<9&&!ack_string_equals(key,keys[field]))++field;
        if(field==9||(seen&(1u<<field)))return CP_ACK_CANONICAL_INVALID;
        seen|=1u<<field;ack_space(&r);
        if(r.p>=r.end||*r.p++!=':')return CP_ACK_NEEDS_GENERAL;
        ack_space(&r);
        if(field==5) {
            /* Only a short, canonical decimal integer reaches the fast path.
             * General JSON numbers (including exponents) are parsed only after
             * the caller has released retained TLS. No strtod here. */
            const char *start=r.p;unsigned count=0;
            while(r.p<r.end&&*r.p>='0'&&*r.p<='9') {
                if(r.p-start>=3)return CP_ACK_NEEDS_GENERAL;
                count=count*10u+(unsigned)(*r.p++-'0');
            }
            if(r.p==start||*start=='0'||count<1||count>128)return CP_ACK_NEEDS_GENERAL;
            if(r.p<r.end&&*r.p!=','&&*r.p!='}'&&*r.p!=' '&&*r.p!='\t'&&*r.p!='\r'&&*r.p!='\n')
                return CP_ACK_NEEDS_GENERAL;
            matches=matches&&count==e->accepted_count;
        } else {
            ack_string_t value;if(!ack_plain_string(&r,&value))return CP_ACK_NEEDS_GENERAL;
            if(!value.length||value.length>=capacities[field])return CP_ACK_CANONICAL_INVALID;
            if(expected[field])matches=matches&&ack_string_equals(value,expected[field]);
            else {char *target=field==7?receipt:timestamp;memcpy(target,value.p,value.length);target[value.length]=0;}
        }
        ack_space(&r);if(r.p>=r.end)return CP_ACK_NEEDS_GENERAL;
        if(*r.p=='}'){++r.p;break;}
        if(*r.p++!=',')return CP_ACK_NEEDS_GENERAL;
    }
    ack_space(&r);uint64_t ignored;
    if(r.p!=r.end||seen!=511u||!matches||!date_ms(timestamp,&ignored))return CP_ACK_CANONICAL_INVALID;
    strcpy(ack->receipt_id,receipt);return CP_ACK_CANONICAL_MATCH;
}
bool cp_network_sha256(const void *bytes, size_t length, char output[65])
{
    if (!bytes || !output) return false;
    unsigned char digest[32];
#ifdef CP_NETWORK_HOST_TEST
    if (!SHA256(bytes,length,digest)) return false;
#else
    if (mbedtls_sha256(bytes,length,digest,0)!=0) return false;
#endif
    static const char hex[]="0123456789abcdef";
    for (unsigned i=0;i<32;++i) { output[i*2]=hex[digest[i]>>4]; output[i*2+1]=hex[digest[i]&15]; }
    output[64]=0; return true;
}

bool cp_network_control_ack_matches(const char *json, size_t length,
    const char *node, const char *boot, uint64_t sequence,
    const char *config_id, const char *state, const char *reason)
{
    cJSON *o=parse(json,length);
    if (!o) return false;
    bool ok=equals(o,"node_id",node) && equals(o,"boot_id",boot);
    if (config_id) ok=ok && state &&
        (reason ? KEYS(o,"node_id","boot_id","capture_config_id","apply_seq","state","received_at","message") && equals(o,"message",reason) :
            KEYS(o,"node_id","boot_id","capture_config_id","apply_seq","state","received_at")) &&
        number(o,"apply_seq",sequence,sequence,NULL) && equals(o,"capture_config_id",config_id) && equals(o,"state",state);
    else ok=ok && KEYS(o,"node_id","boot_id","contact_seq","received_at","control") &&
        number(o,"contact_seq",sequence,sequence,NULL) && KEYS(field(o,"control"),"lease_ms") &&
        number(field(o,"control"),"lease_ms",1,CP_NETWORK_LEASE_MS,NULL);
    char timestamp[25]; uint64_t ignored;
    ok=ok && copy_string(o,"received_at",timestamp,sizeof(timestamp)) && date_ms(timestamp,&ignored);
    cJSON_Delete(o); return ok;
}
bool cp_network_parse_server_time(const char *json,size_t length,uint64_t *utc_ms)
{
    if (!utc_ms) return false;
    cJSON *o=parse(json,length);
    if (!o) return false;
    char timestamp[25];
    bool ok=copy_string(o,"server_time",timestamp,sizeof(timestamp)) && date_ms(timestamp,utc_ms);
    cJSON_Delete(o); return ok;
}

bool cp_network_candidate_id(const char *json,size_t length,const char *node,char out[65])
{
    if (!out || !node) return false;
    out[0]=0;
    cJSON *o=parse(json,length);
    if (!o) return false;
    const cJSON *config=field(o,"config");
    bool ok=equals(o,"protocol",CP_PROTOCOL) && equals(config,"node_id",node) &&
        copy_string(config,"capture_config_id",out,65) && id_valid(out);
    cJSON_Delete(o);
    if (!ok) out[0]=0;
    return ok;
}
