#include "local_guard.h"
#include <string.h>

#define SAFE INT64_C(9007199254740991)
#define UTC_MIN UINT64_C(1704067200000)
#define UTC_MAX UINT64_C(7258118400000)
typedef struct { const unsigned char *p; size_t n, at; } reader_t;
typedef struct { const unsigned char *p; size_t n; } value_t;
typedef struct { uint64_t mono, utc, epoch, error; } observation_time_t;

/* Shared control JSON is unsigned-only; shared receipt JSON is flat. Neither
 * accepts negative RSSI in these nested compact bodies. This bounded parser is
 * deliberately schema-directed and rejects escapes/non-ASCII in all strings.
 * Thus duplicate decoded aliases cannot evade the duplicate-key checks. */
static void space(reader_t *r) {
    while(r->at<r->n&&(r->p[r->at]==' '||r->p[r->at]=='\t'||r->p[r->at]=='\r'||r->p[r->at]=='\n'))++r->at;
}
static bool take(reader_t *r,unsigned char c) {
    space(r);if(r->at==r->n||r->p[r->at]!=c)return false;++r->at;return true;
}
static bool literal(reader_t *r,const char *text) {
    size_t n=strlen(text);space(r);if(n>r->n-r->at||memcmp(r->p+r->at,text,n))return false;r->at+=n;return true;
}
static bool string(reader_t *r,value_t *v) {
    if(!take(r,'"'))return false;
    size_t start=r->at;
    while(r->at<r->n){unsigned char c=r->p[r->at++];
        if(c=='"'){*v=(value_t){r->p+start,r->at-start-1};return true;}
        if(c<32||c>126||c=='\\')return false;
    }return false;
}
static bool integer(reader_t *r,int64_t *out) {
    space(r);bool negative=r->at<r->n&&r->p[r->at]=='-';if(negative)++r->at;
    if(r->at==r->n||r->p[r->at]<'0'||r->p[r->at]>'9')return false;
    size_t start=r->at;uint64_t n=0;
    while(r->at<r->n&&r->p[r->at]>='0'&&r->p[r->at]<='9'){
        unsigned digit=r->p[r->at++]-'0';if(n>((uint64_t)SAFE-digit)/10)return false;n=n*10+digit;
    }
    if((r->at-start>1&&r->p[start]=='0')||(negative&&!n))return false;
    *out=negative?-(int64_t)n:(int64_t)n;return true;
}
static bool skip_value(reader_t *r,unsigned depth) {
    if(depth>5)return false;
    space(r);if(r->at==r->n)return false;
    unsigned char c=r->p[r->at];value_t text;int64_t number;
    if(c=='"')return string(r,&text);
    if(c=='n')return literal(r,"null");
    if(c!='{'&&c!='[')return integer(r,&number);
    ++r->at;space(r);unsigned char close=c=='{'?'}':']';
    if(r->at<r->n&&r->p[r->at]==close){++r->at;return true;}
    for(;;){
        if(c=='{'&&(!string(r,&text)||!take(r,':')))return false;
        if(!skip_value(r,depth+1))return false;
        space(r);
        if(r->at<r->n&&r->p[r->at]==close){++r->at;return true;}
        if(!take(r,','))return false;
    }
}
static bool done(reader_t *r) {space(r);return r->at==r->n;}
static bool eq(value_t v,const char *text) {return v.n==strlen(text)&&!memcmp(v.p,text,v.n);}
static bool text_is(value_t v,const char *text) {
    reader_t r={v.p,v.n,0};value_t s;return string(&r,&s)&&done(&r)&&eq(s,text);
}
static bool uint_value(value_t v,uint64_t min,uint64_t max,uint64_t *out) {
    reader_t r={v.p,v.n,0};int64_t n;
    if(!integer(&r,&n)||!done(&r)||n<0||(uint64_t)n<min||(uint64_t)n>max)return false;
    *out=(uint64_t)n;return true;
}
static bool object(value_t input,const char *const *keys,unsigned count,unsigned required,value_t *values) {
    reader_t r={input.p,input.n,0};unsigned seen=0;if(count>16||!take(&r,'{'))return false;
    for(;;){
        value_t key;if(!string(&r,&key)||!take(&r,':'))return false;
        unsigned i=0;while(i<count&&!eq(key,keys[i]))++i;
        if(i==count||(seen&(1u<<i)))return false;
        seen|=1u<<i;
        space(&r);size_t start=r.at;if(!skip_value(&r,0))return false;
        values[i]=(value_t){r.p+start,r.at-start};space(&r);
        if(r.at<r.n&&r.p[r.at]=='}'){++r.at;break;}if(!take(&r,','))return false;
    }
    return (seen&required)==required&&done(&r);
}
static bool array(value_t input,value_t *values,unsigned count) {
    reader_t r={input.p,input.n,0};if(!take(&r,'['))return false;
    for(unsigned i=0;i<count;++i){
        if(i&&!take(&r,','))return false;
        space(&r);size_t start=r.at;
        if(!skip_value(&r,0))return false;
        values[i]=(value_t){r.p+start,r.at-start};
    }return take(&r,']')&&done(&r);
}
static bool numbers(value_t input,int64_t *out,unsigned count,bool nullable,unsigned *null_mask) {
    value_t values[6];if(count>6||!array(input,values,count))return false;
    if(null_mask)*null_mask=0;
    for(unsigned i=0;i<count;++i){reader_t r={values[i].p,values[i].n,0};
        if(nullable&&literal(&r,"null")&&done(&r)){out[i]=0;if(null_mask)*null_mask|=1u<<i;continue;}
        r.at=0;if(!integer(&r,&out[i])||!done(&r))return false;
    }return true;
}
static bool nonnegative(const int64_t *v,unsigned n) {for(unsigned i=0;i<n;++i)if(v[i]<0)return false;return true;}
static bool add(uint64_t *total,uint64_t n) {if(n>(uint64_t)SAFE-*total)return false;*total+=n;return true;}
static bool terminated(const char *s,size_t n) {
    if(!s)return false;
    for(size_t i=0;i<n;++i)if(!s[i])return true;
    return false;
}
static bool identifier(const char *s,size_t cap) {
    if(!terminated(s,cap)||!*s)return false;
    for(size_t i=0;s[i];++i)if(!((s[i]>='a'&&s[i]<='z')||(s[i]>='0'&&s[i]<='9')||(i&&(s[i]=='-'||s[i]=='_'))))return false;
    return true;
}
static bool hex(const char *s,size_t cap,size_t length) {
    if(!terminated(s,cap)||strlen(s)!=length)return false;
    for(size_t i=0;i<length;++i)if(!strchr("0123456789abcdef",s[i]))return false;
    return true;
}
static bool uuid(const char *s,size_t cap) {
    if(!terminated(s,cap)||strlen(s)!=36||s[14]!='4'||!strchr("89ab",s[19]))return false;
    for(unsigned i=0;i<36;++i){if(i==8||i==13||i==18||i==23){if(s[i]!='-')return false;}
        else if(!strchr("0123456789abcdef",s[i]))return false;}return true;
}
static bool expected_valid(const cp_v3_expected_t *e) {
    const cp_v3_scope_t *s=&e->scope;
    return identifier(s->node_id,sizeof s->node_id)&&uuid(s->boot_id,sizeof s->boot_id)&&
        identifier(s->policy_id,sizeof s->policy_id)&&identifier(s->placement_id,sizeof s->placement_id)&&
        hex(s->policy_sha256,sizeof s->policy_sha256,64)&&uuid(e->batch_id,sizeof e->batch_id)&&
        hex(e->body_sha256,sizeof e->body_sha256,64)&&terminated(e->stream,sizeof e->stream)&&
        terminated(s->dataset,sizeof s->dataset)&&(!strcmp(s->dataset,"field")||!strcmp(s->dataset,"demo")||!strcmp(s->dataset,"controlled_test"))&&
        s->assignment_generation>0&&s->assignment_generation<=(uint64_t)SAFE&&
        e->seq_first&&e->seq_first==e->seq_last&&e->accepted_count==1;
}
static bool time_value(value_t value,observation_time_t *t) {
    int64_t v[4];unsigned nulls;
    if(!numbers(value,v,4,true,&nulls)||nulls||!nonnegative(v,4)||!v[2]||v[2]>UINT32_MAX||v[3]>5000)return false;
    *t=(observation_time_t){(uint64_t)v[0],(uint64_t)v[1],(uint64_t)v[2],(uint64_t)v[3]};
    return t->utc>=UTC_MIN+t->error&&t->utc<UTC_MAX-t->error;
}
static bool versions(value_t value) {
    value_t v[2];return array(value,v,2)&&text_is(v[0],"cp-v3-stats/1")&&text_is(v[1],"unclassified-v1");
}
static bool rssi_ok(int64_t n,int64_t sum,int64_t min,int64_t max) {
    return n>=0&&min>=-127&&min<=max&&max<=20&&sum>=n*min&&sum<=n*max;
}
static te_local_guard_check_t window(value_t item,const cp_v3_expected_t *e,observation_time_t *t,uint64_t *duration) {
    static const char *const keys[]={"q","w","t","d","b","c","r","x","s","l","f","v"};
    value_t v[12]={0};uint64_t seq,win,bin,flags;
    if(!object(item,keys,12,(1u<<12)-1,v)||!uint_value(v[0],1,UINT32_MAX,&seq)||
       !uint_value(v[1],1,UINT32_MAX,&win))return TE_LOCAL_GUARD_BAD_BODY;
    if(seq!=e->seq_first||win!=e->scope.window_seq)return TE_LOCAL_GUARD_SCOPE_MISMATCH;
    if(!time_value(v[2],t))return TE_LOCAL_GUARD_UNKNOWN_TIME;
    if(!uint_value(v[3],1,300000,duration)||!uint_value(v[4],1,300000,&bin)||
       *duration>t->mono||!uint_value(v[10],0,63,&flags)||!versions(v[11])||
       (t->error&&!(flags&2)))return TE_LOCAL_GUARD_BAD_BODY;
    int64_t c[6],r[4],s[4],l[4];unsigned nulls;
    if(!numbers(v[5],c,6,false,NULL)||!nonnegative(c,6)||!numbers(v[6],r,4,false,NULL)||!nonnegative(r,4)||
       !numbers(v[8],s,4,true,&nulls)||!numbers(v[9],l,4,false,NULL)||!nonnegative(l,4))return TE_LOCAL_GUARD_BAD_BODY;
    for(unsigned i=0;i<6;++i)if((i!=4&&c[i])||c[i]>512)return TE_LOCAL_GUARD_BAD_BODY;
    uint64_t worker=(uint64_t)r[2],source=(uint64_t)r[1];
    if(!add(&worker,(uint64_t)r[3])||worker!=(uint64_t)r[1]||c[4]>r[1]||
       !add(&source,(uint64_t)l[1])||!add(&source,(uint64_t)l[2])||source>(uint64_t)r[0]||
       l[0]>(int64_t)*duration||l[3]>r[1]||s[0]<0||s[0]>r[1]||
       (s[0]==0?(nulls!=12||s[1]!=0):(nulls||!rssi_ok(s[0],s[1],s[2],s[3])||
        s[1]<s[3]+s[2]*(s[0]-1)||s[1]>s[2]+s[3]*(s[0]-1)))||
       (l[0]<(int64_t)*duration&&!(flags&4))||(l[1]&&!(flags&16))||
       (l[2]&&!(flags&32))||(l[3]&&!(flags&8)))return TE_LOCAL_GUARD_BAD_BODY;
    reader_t bins={v[7].p,v[7].n,0};if(!take(&bins,'['))return TE_LOCAL_GUARD_BAD_BODY;
    unsigned count=0;uint64_t reports=0,ids=0,samples=0;int64_t sums=0;bool has_min=false,has_max=false;
    do {
        if(count&&!take(&bins,','))return TE_LOCAL_GUARD_BAD_BODY;
        space(&bins);size_t start=bins.at;if(!skip_value(&bins,0))return TE_LOCAL_GUARD_BAD_BODY;
        int64_t b[4];if(!numbers((value_t){bins.p+start,bins.at-start},b,4,false,NULL)||
           !nonnegative(b,3)||b[0]>r[1]||b[1]>c[4]||b[1]>b[0]||b[2]>b[0]||
           !rssi_ok(b[2],b[3],s[0]?s[2]:-127,s[0]?s[3]:20)||
           !add(&reports,(uint64_t)b[0])||!add(&ids,(uint64_t)b[1])||!add(&samples,(uint64_t)b[2]))return TE_LOCAL_GUARD_BAD_BODY;
        /* At most 60 safe integers: signed sum remains inside int64_t. */
        sums+=b[3];
        if(b[2]){has_min|=b[3]-s[2]>=(b[2]-1)*s[2]&&b[3]-s[2]<=(b[2]-1)*s[3];
            has_max|=b[3]-s[3]>=(b[2]-1)*s[2]&&b[3]-s[3]<=(b[2]-1)*s[3];}
        if(++count>60)return TE_LOCAL_GUARD_BAD_BODY;
        space(&bins);
    }while(bins.at<bins.n&&bins.p[bins.at]!=']');
    if(!take(&bins,']')||!done(&bins)||count!=(*duration+bin-1)/bin||reports!=(uint64_t)r[1]||
       ids<(uint64_t)c[4]||samples!=(uint64_t)s[0]||sums!=s[1]||(s[0]&&(!has_min||!has_max)))return TE_LOCAL_GUARD_BAD_BODY;
    return TE_LOCAL_GUARD_STRUCTURE_MATCHED;
}
static te_local_guard_check_t status(value_t item,const cp_v3_expected_t *e,observation_time_t *t) {
    static const char *const keys[]={"q","t","u","s","r","j","l","a"};value_t v[8]={0};uint64_t seq,uptime;
    if(!object(item,keys,8,(1u<<7)-1,v)||!uint_value(v[0],1,UINT32_MAX,&seq))return TE_LOCAL_GUARD_BAD_BODY;
    if(seq!=e->seq_first)return TE_LOCAL_GUARD_SCOPE_MISMATCH;
    if(!time_value(v[1],t))return TE_LOCAL_GUARD_UNKNOWN_TIME;
    if(!uint_value(v[2],0,SAFE,&uptime)||uptime!=t->mono||
       !(text_is(v[3],"running")||text_is(v[3],"paused")||text_is(v[3],"failed")))return TE_LOCAL_GUARD_BAD_BODY;
    int64_t r[5],q[6],l[6];unsigned nulls;
    if(!numbers(v[4],r,5,true,&nulls)||!nonnegative(r,5)||!numbers(v[5],q,6,false,NULL)||!nonnegative(q,6)||
       !numbers(v[6],l,6,false,NULL)||!nonnegative(l,6)||
       (!(nulls&1)&&((!(nulls&2)&&r[1]>r[0])||(!(nulls&4)&&r[2]>r[0]))))return TE_LOCAL_GUARD_BAD_BODY;
    uint64_t items=0,bytes=0;for(unsigned i=0;i<6;i+=2)
        if((q[i]==0)!=(q[i+1]==0)||!add(&items,(uint64_t)q[i])||!add(&bytes,(uint64_t)q[i+1]))return TE_LOCAL_GUARD_BAD_BODY;
    /* T-Energy local_raw=off. TF counters are valid in other profiles but this
     * narrow serializer subset accepts only absent/null, never raw structures. */
    if(v[7].p){reader_t raw={v[7].p,v[7].n,0};if(!literal(&raw,"null")||!done(&raw))return TE_LOCAL_GUARD_UNSUPPORTED;}
    return TE_LOCAL_GUARD_STRUCTURE_MATCHED;
}
void te_local_guard_inspect(cp_v3_queue_kind_t kind,const cp_v3_expected_t *e,const char *node,
        const void *body,size_t length,const te_local_guard_time_t *time,cp_v3_sha256_fn sha,
        void *hash_context,te_local_guard_report_t *out) {
    if(!out)return;
    memset(out,0,sizeof *out);out->obligations=TE_LOCAL_GUARD_OBLIGATIONS;out->check=TE_LOCAL_GUARD_BAD_INPUT;
    if(!e||!node||!body||!length||length>TE_LOCAL_GUARD_BODY_MAX||!time||!sha||
       !expected_valid(e)||!identifier(node,65)||e->body_bytes!=length||!time->max_source_age_ms||
       time->max_source_age_ms>(uint64_t)SAFE)return;
    const char *stream=kind==CP_V3_QUEUE_WINDOW?"window_statistics":kind==CP_V3_QUEUE_STATUS?"node_status":NULL;
    if(!stream){out->check=TE_LOCAL_GUARD_UNSUPPORTED;return;}
    if(strcmp(node,e->scope.node_id)||strcmp(stream,e->stream)||(kind==CP_V3_QUEUE_WINDOW&&!e->scope.window_seq)){
        out->check=TE_LOCAL_GUARD_SCOPE_MISMATCH;return;
    }
    uint8_t digest[32];char hash[65];static const char digits[]="0123456789abcdef";
    if(!sha(hash_context,body,length,digest)){out->check=TE_LOCAL_GUARD_HASH_MISMATCH;return;}
    for(unsigned i=0;i<32;++i){hash[2*i]=digits[digest[i]>>4];hash[2*i+1]=digits[digest[i]&15];}hash[64]=0;
    if(strcmp(hash,e->body_sha256)){out->check=TE_LOCAL_GUARD_HASH_MISMATCH;return;}
    static const char *const keys[]={"p","z","b","n","o","c","h","g","d","k","x"};value_t v[11]={0},item[1];uint64_t protocol,generation;
    out->check=TE_LOCAL_GUARD_BAD_BODY;
    if(!object((value_t){body,length},keys,11,(1u<<11)-1,v)||!uint_value(v[0],3,3,&protocol)||
       !text_is(v[1],"statistics/1")||!uint_value(v[7],1,SAFE,&generation)||!array(v[10],item,1))return;
    if(!text_is(v[2],e->batch_id)||!text_is(v[3],e->scope.node_id)||!text_is(v[4],e->scope.boot_id)||
       !text_is(v[5],e->scope.policy_id)||!text_is(v[6],e->scope.policy_sha256)||generation!=e->scope.assignment_generation||
       !text_is(v[8],e->scope.dataset)||!text_is(v[9],stream)){out->check=TE_LOCAL_GUARD_SCOPE_MISMATCH;return;}
    observation_time_t original={0};uint64_t duration=0;
    out->check=kind==CP_V3_QUEUE_WINDOW?window(item[0],e,&original,&duration):status(item[0],e,&original);
    if(out->check!=TE_LOCAL_GUARD_STRUCTURE_MATCHED)return;
    cp_v3_time_t now=time->upload_now;
    out->check=TE_LOCAL_GUARD_UNKNOWN_TIME;
    if(!now.clock_epoch||now.mono_ms>(uint64_t)SAFE||now.uncertainty_ms>5000||
       now.utc_ms<UTC_MIN+now.uncertainty_ms||now.utc_ms>=UTC_MAX-now.uncertainty_ms||
       time->source_expires_at_ms<UTC_MIN||time->source_expires_at_ms>=UTC_MAX||
       original.utc<duration+original.error||original.utc-duration-original.error<UTC_MIN)return;
    out->observation_start_lower_ms=original.utc-duration-original.error;
    out->observation_end_lower_ms=original.utc-original.error;
    out->observation_end_upper_ms=original.utc+original.error;
    out->clock_epoch=(uint32_t)original.epoch;
    out->current_lower_ms=now.utc_ms-now.uncertainty_ms;out->current_upper_ms=now.utc_ms+now.uncertainty_ms;
    if(out->observation_end_upper_ms>out->current_lower_ms){out->check=TE_LOCAL_GUARD_FUTURE;return;}
    if(out->current_upper_ms>=time->source_expires_at_ms||
       out->current_upper_ms-out->observation_end_lower_ms>=time->max_source_age_ms){out->check=TE_LOCAL_GUARD_EXPIRED;return;}
    out->check=TE_LOCAL_GUARD_STRUCTURE_MATCHED;
}
