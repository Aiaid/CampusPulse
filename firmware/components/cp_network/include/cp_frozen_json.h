#pragma once
#include "cp_network.h"
#include <string.h>

/* Allocation-free JSON syntax/identity reader. Full server semantic validation
 * remains authoritative. Bounded input, depth and work also bound rescanning
 * used to reject duplicate object keys without a key table on the task stack. */
typedef struct { const unsigned char *p,*end; size_t work; } cp_fjson_t;
typedef struct { const unsigned char *begin,*end; } cp_fjson_string_t;
#define CP_FJSON_DEPTH 12u
#define CP_FJSON_WORK (CP_NETWORK_BODY_MAX * 128u)
static inline bool cp_fjson_tick(cp_fjson_t *j) { return ++j->work<=CP_FJSON_WORK; }
static inline void cp_fjson_space(cp_fjson_t *j) {
    while(j->p<j->end && (*j->p==' '||*j->p=='\t'||*j->p=='\r'||*j->p=='\n')) ++j->p;
}
static inline int cp_fjson_hex(unsigned char c) {
    return c>='0'&&c<='9'?c-'0':c>='a'&&c<='f'?c-'a'+10:c>='A'&&c<='F'?c-'A'+10:-1;
}
static inline bool cp_fjson_codepoint(cp_fjson_t *j,uint32_t *out) {
    if(j->p>=j->end || !cp_fjson_tick(j)) return false;
    uint32_t c=*j->p++;
    if(c=='\\') {
        if(j->p>=j->end) return false;
        c=*j->p++;
        if(c=='u') {
            c=0;
            for(unsigned i=0;i<4;i++) {
                if(j->p>=j->end) return false;
                int h=cp_fjson_hex(*j->p++);if(h<0)return false;c=c*16u+(unsigned)h;
            }
            if(c>=0xd800 && c<=0xdbff) {
                if(j->end-j->p<6 || j->p[0]!='\\'||j->p[1]!='u')return false;
                j->p+=2;uint32_t low=0;
                for(unsigned i=0;i<4;i++){int h=cp_fjson_hex(*j->p++);if(h<0)return false;low=low*16u+(unsigned)h;}
                if(low<0xdc00||low>0xdfff)return false;
                c=0x10000u+((c-0xd800u)<<10)+(low-0xdc00u);
            } else if(c>=0xdc00&&c<=0xdfff)return false;
        } else if(c=='b')c=8;else if(c=='f')c=12;else if(c=='n')c=10;
        else if(c=='r')c=13;else if(c=='t')c=9;
        else if(c!='"'&&c!='\\'&&c!='/')return false;
    } else {
        if(c<0x20)return false;
        if(c>=0x80) {
            unsigned tail;uint32_t minimum;
            if(c>=0xc2&&c<=0xdf){tail=1;minimum=0x80;c&=0x1f;}
            else if(c>=0xe0&&c<=0xef){tail=2;minimum=0x800;c&=0x0f;}
            else if(c>=0xf0&&c<=0xf4){tail=3;minimum=0x10000;c&=7;}
            else return false;
            while(tail--){if(j->p>=j->end||(*j->p&0xc0)!=0x80)return false;c=(c<<6)|(*j->p++&0x3f);}
            if(c<minimum||c>0x10ffff||(c>=0xd800&&c<=0xdfff))return false;
        }
    }
    *out=c;return true;
}
static inline bool cp_fjson_string(cp_fjson_t *j,cp_fjson_string_t *span) {
    if(j->p>=j->end||*j->p++!='"')return false;
    span->begin=j->p;
    while(j->p<j->end && *j->p!='"') {
        uint32_t c;if(!cp_fjson_codepoint(j,&c))return false;
    }
    if(j->p>=j->end)return false;
    span->end=j->p++;return true;
}
static inline bool cp_fjson_equal(cp_fjson_string_t a,cp_fjson_string_t b) {
    cp_fjson_t x={a.begin,a.end,0},y={b.begin,b.end,0};
    while(x.p<x.end && y.p<y.end){uint32_t l,r;if(!cp_fjson_codepoint(&x,&l)||!cp_fjson_codepoint(&y,&r)||l!=r)return false;}
    return x.p==x.end&&y.p==y.end;
}
static inline bool cp_fjson_copy(cp_fjson_string_t span,char *out,size_t capacity) {
    cp_fjson_t j={span.begin,span.end,0};size_t used=0;
    while(j.p<j.end){uint32_t c;if(!cp_fjson_codepoint(&j,&c)||!c||c>0x7f||used+1>=capacity)return false;out[used++]=(char)c;}
    out[used]=0;return used>0;
}
static inline bool cp_fjson_value(cp_fjson_t *,unsigned);
static inline bool cp_fjson_duplicate(cp_fjson_t *j,const unsigned char *start,
    const unsigned char *current,cp_fjson_string_t key,unsigned depth) {
    cp_fjson_t scan={start,current,j->work};
    cp_fjson_space(&scan);
    while(scan.p<current) {
        cp_fjson_space(&scan);cp_fjson_string_t prior;
        if(!cp_fjson_string(&scan,&prior))return true;
        if(cp_fjson_equal(prior,key))return true;
        cp_fjson_space(&scan);
        if(scan.p>=scan.end||*scan.p++!=':')return true;
        if(!cp_fjson_value(&scan,depth+1))return true;
        cp_fjson_space(&scan);
        if(scan.p<scan.end&&*scan.p==',')++scan.p;
        cp_fjson_space(&scan);
    }
    j->work=scan.work;return scan.p!=current;
}
static inline bool cp_fjson_value(cp_fjson_t *j,unsigned depth) {
    if(depth>CP_FJSON_DEPTH||!cp_fjson_tick(j))return false;
    cp_fjson_space(j);if(j->p>=j->end)return false;
    unsigned char c=*j->p;
    if(c=='"'){cp_fjson_string_t s;return cp_fjson_string(j,&s);}
    if(c=='{'||c=='[') {
        bool object=c=='{';unsigned char close=object?'}':']';++j->p;
        const unsigned char *start=j->p;
        cp_fjson_space(j);if(j->p<j->end&&*j->p==close){++j->p;return true;}
        for(;;) {
            cp_fjson_space(j);
            if(object){const unsigned char *current=j->p;cp_fjson_string_t key;
                if(!cp_fjson_string(j,&key)||cp_fjson_duplicate(j,start,current,key,depth))return false;
                cp_fjson_space(j);if(j->p>=j->end||*j->p++!=':')return false;}
            if(!cp_fjson_value(j,depth+1))return false;
            cp_fjson_space(j);if(j->p>=j->end)return false;
            if(*j->p==close){++j->p;return true;}
            if(*j->p++!=',')return false;
        }
    }
    const char *literal=c=='t'?"true":c=='f'?"false":c=='n'?"null":NULL;
    if(literal){size_t n=strlen(literal);if((size_t)(j->end-j->p)<n||memcmp(j->p,literal,n))return false;j->p+=n;return true;}
    if(c=='-'){++j->p;if(j->p>=j->end)return false;}
    if(*j->p=='0')++j->p;
    else {if(*j->p<'1'||*j->p>'9')return false;do{++j->p;}while(j->p<j->end&&*j->p>='0'&&*j->p<='9');}
    if(j->p<j->end&&*j->p=='.'){++j->p;const unsigned char *begin=j->p;while(j->p<j->end&&*j->p>='0'&&*j->p<='9')++j->p;if(j->p==begin)return false;}
    if(j->p<j->end&&(*j->p=='e'||*j->p=='E')){++j->p;if(j->p<j->end&&(*j->p=='+'||*j->p=='-'))++j->p;const unsigned char *begin=j->p;while(j->p<j->end&&*j->p>='0'&&*j->p<='9')++j->p;if(j->p==begin)return false;}
    return true;
}
static inline bool cp_frozen_metadata(const char *body,size_t length,cp_network_batch_t *out) {
    if(!body||!out||!length||length>CP_NETWORK_BODY_MAX)return false;
    cp_fjson_t j={(const unsigned char *)body,(const unsigned char *)body+length,0};
    cp_fjson_space(&j);if(j.p>=j.end||*j.p++!='{')return false;
    static const char *const names[]={"protocol","node_id","boot_id","placement_id","capture_config_id","dataset","firmware_version","batch_id","stream","items"};
    unsigned seen=0;memset(out,0,sizeof *out);
    for(;;) {
        cp_fjson_space(&j);cp_fjson_string_t key;char name[24];
        if(!cp_fjson_string(&j,&key)||!cp_fjson_copy(key,name,sizeof name))return false;
        unsigned field=0;while(field<10&&strcmp(name,names[field]))++field;
        if(field==10||(seen&(1u<<field)))return false;
        seen|=1u<<field;cp_fjson_space(&j);if(j.p>=j.end||*j.p++!=':')return false;cp_fjson_space(&j);
        if(field==9) {
            if(j.p>=j.end||*j.p++!='[')return false;
            cp_fjson_space(&j);if(j.p>=j.end||*j.p==']')return false;
            for(;;){cp_fjson_space(&j);if(j.p>=j.end||*j.p!='{'||out->accepted_count>=128||!cp_fjson_value(&j,1))return false;++out->accepted_count;cp_fjson_space(&j);if(j.p>=j.end)return false;if(*j.p==']'){++j.p;break;}if(*j.p++!=',')return false;}
        } else {
            cp_fjson_string_t value;if(!cp_fjson_string(&j,&value))return false;
            char ignored[81];char *dest=ignored;size_t capacity=sizeof ignored;
            if(field==1){dest=out->node_id;capacity=sizeof out->node_id;}
            else if(field==2){dest=out->boot_id;capacity=sizeof out->boot_id;}
            else if(field==7){dest=out->batch_id;capacity=sizeof out->batch_id;}
            else if(field==8){dest=out->stream;capacity=sizeof out->stream;}
            if(!cp_fjson_copy(value,dest,capacity)||(field==0&&strcmp(dest,CP_PROTOCOL)))return false;
        }
        cp_fjson_space(&j);if(j.p>=j.end)return false;
        if(*j.p=='}'){++j.p;break;}if(*j.p++!=',')return false;
    }
    cp_fjson_space(&j);
    return seen==1023u&&j.p==j.end&&cp_network_sha256(body,length,out->body_sha256);
}
