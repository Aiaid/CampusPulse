#include "internal.h"
#include <stdio.h>
#include <string.h>

static bool white(unsigned c) { return c == ' ' || c == '\t' || c == '\r' || c == '\n'; }
static void skip(cp_v3_control_workspace_t *w) { while (w->position < w->length && white(w->input[w->position])) ++w->position; }
static bool take(cp_v3_control_workspace_t *w, char ch) { skip(w); return w->position < w->length && w->input[w->position++] == (unsigned char)ch; }
static bool text(cp_v3_control_workspace_t *w, uint16_t *start, uint16_t *end) {
    if (!take(w, '"')) return false;
    *start = (uint16_t)w->position;
    while (w->position < w->length) {
        unsigned c = w->input[w->position++];
        if (c == '"') { *end = (uint16_t)(w->position - 1); return true; }
        /* All supported policy/capability identifiers and constants are ASCII.
         * Reject escaped/NUL/non-ASCII variants rather than normalizing loosely. */
        if (c < 32 || c > 126 || c == '\\') return false;
    }
    return false;
}
static int parse_value(cp_v3_control_workspace_t *w, unsigned depth) {
    skip(w);
    if (depth > 12 || w->count == CP_V3_CONTROL_TOKENS || w->position >= w->length) return -1;
    unsigned at = w->count++;
    cp_v3_control_token_t *t = &w->tokens[at];
    memset(t, 0, sizeof *t); t->first = t->next = V3_NONE;
    unsigned c = w->input[w->position];
    if (c == '{' || c == '[') {
        t->kind = c == '{' ? V3_OBJECT : V3_ARRAY;
        ++w->position; skip(w);
        if (w->position < w->length && w->input[w->position] == (c == '{' ? '}' : ']')) { ++w->position; return (int)at; }
        uint16_t previous = V3_NONE;
        for (unsigned member = 0; member < 64; ++member) {
            uint16_t key_start = 0, key_end = 0;
            if (c == '{') {
                if (!text(w, &key_start, &key_end) || !take(w, ':')) return -1;
                for (uint16_t i = t->first; i != V3_NONE; i = w->tokens[i].next)
                    if (w->tokens[i].key_end - w->tokens[i].key_start == key_end-key_start &&
                        !memcmp(w->input + w->tokens[i].key_start, w->input + key_start, key_end-key_start)) return -1;
            }
            int child = parse_value(w, depth + 1); if (child < 0) return -1;
            w->tokens[child].key_start = key_start; w->tokens[child].key_end = key_end;
            if (previous == V3_NONE) t->first = (uint16_t)child; else w->tokens[previous].next = (uint16_t)child;
            previous = (uint16_t)child;
            skip(w); if (w->position >= w->length) return -1;
            if (w->input[w->position] == (c == '{' ? '}' : ']')) { ++w->position; return (int)at; }
            if (!take(w, ',')) return -1;
        }
        return -1;
    }
    if (c == '"') { t->kind = V3_STRING; return text(w, &t->start, &t->end) ? (int)at : -1; }
    if (c >= '0' && c <= '9') {
        t->kind = V3_NUMBER; size_t start = w->position;
        while (w->position < w->length && w->input[w->position] >= '0' && w->input[w->position] <= '9') {
            unsigned digit = w->input[w->position++] - '0';
            if (t->number > (V3_SAFE-digit)/10) return -1;
            t->number = t->number*10 + digit;
        }
        return w->position-start > 1 && c == '0' ? -1 : (int)at;
    }
    const char *words[] = {"true", "false", "null"};
    for (unsigned i = 0; i < 3; ++i) {
        size_t n = strlen(words[i]);
        if (n <= w->length-w->position && !memcmp(w->input+w->position, words[i], n)) {
            t->kind = (uint8_t)(V3_TRUE+i); w->position += n; return (int)at;
        }
    }
    return -1;
}
bool v3_parse(cp_v3_control_workspace_t *w, const void *json, size_t length) {
    if (!w || !json || !length || length > CP_V3_CONTROL_JSON_MAX) return false;
    memset(w, 0, sizeof *w); w->input = json; w->length = length;
    w->valid = parse_value(w, 0) == 0; skip(w);
    return w->valid && w->position == length;
}
bool v3_is(cp_v3_control_workspace_t *w, int at, unsigned kind) { return at >= 0 && at < w->count && w->tokens[at].kind == kind; }
int v3_field(cp_v3_control_workspace_t *w, int at, const char *name) {
    if (!v3_is(w, at, V3_OBJECT)) return -1;
    size_t n = strlen(name);
    for (uint16_t i = w->tokens[at].first; i != V3_NONE; i = w->tokens[i].next)
        if ((size_t)(w->tokens[i].key_end-w->tokens[i].key_start) == n && !memcmp(w->input+w->tokens[i].key_start, name, n)) return i;
    return -1;
}
bool v3_fields(cp_v3_control_workspace_t *w, int at, const char *names) {
    if (!v3_is(w, at, V3_OBJECT)) return false;
    unsigned actual = 0, expected = 0;
    for (uint16_t i = w->tokens[at].first; i != V3_NONE; i = w->tokens[i].next) ++actual;
    for (const char *p = names; *p;) {
        char name[48]; size_t n = 0;
        while (*p && *p != ' ') { if (n+1 >= sizeof name) return false; name[n++] = *p++; }
        name[n] = 0; if (*p) ++p; if (v3_field(w, at, name) < 0) return false; ++expected;
    }
    return actual == expected;
}
bool v3_fields_optional(cp_v3_control_workspace_t *w,int at,const char *required,const char *optional) {
    char names[1024];size_t n=strlen(required);if(n>=sizeof names)return false;memcpy(names,required,n+1);
    for(const char *p=optional;*p;){char name[48];size_t used=0;
        while(*p&&*p!=' '){if(used+1>=sizeof name)return false;name[used++]=*p++;}name[used]=0;if(*p)++p;
        if(v3_field(w,at,name)>=0){if(n+used+2>sizeof names)return false;names[n++]=' ';memcpy(names+n,name,used+1);n+=used;}}
    return v3_fields(w,at,names);
}
bool v3_body_hash(cp_v3_sha256_fn sha,void *ctx,const void *body,size_t length,char out[65]) {
    uint8_t hash[32];if(!sha||!body||!length||!sha(ctx,body,length,hash))return false;
    static const char hex[]="0123456789abcdef";for(unsigned i=0;i<32;++i){out[2*i]=hex[hash[i]>>4];out[2*i+1]=hex[hash[i]&15];}out[64]=0;return true;
}
bool v3_equal(cp_v3_control_workspace_t *w, int at, const char *value) {
    return v3_is(w, at, V3_STRING) && (size_t)(w->tokens[at].end-w->tokens[at].start) == strlen(value) &&
        !memcmp(w->input+w->tokens[at].start, value, strlen(value));
}
bool v3_string(cp_v3_control_workspace_t *w, int at, char *out, size_t capacity) {
    if (!v3_is(w, at, V3_STRING)) return false;
    size_t n = w->tokens[at].end-w->tokens[at].start;
    if (n >= capacity) return false;
    memcpy(out, w->input+w->tokens[at].start, n); out[n] = 0; return true;
}
bool v3_uint(cp_v3_control_workspace_t *w, int at, uint64_t min, uint64_t max, uint64_t *out) {
    if (!v3_is(w, at, V3_NUMBER) || w->tokens[at].number < min || w->tokens[at].number > max) return false;
    if (out) *out = w->tokens[at].number;
    return true;
}
bool v3_array_exact(cp_v3_control_workspace_t *w, int at, const char *choices) {
    if (!v3_is(w, at, V3_ARRAY)) return false;
    unsigned count = 0, expected = 0; uint64_t found = 0;
    for (const char *p = choices; *p;) { ++expected; while (*p && *p != ' ') ++p; if (*p) ++p; }
    for (uint16_t i = w->tokens[at].first; i != V3_NONE; i = w->tokens[i].next) {
        bool matched = false; unsigned bit = 0;
        for (const char *p = choices; *p; ++bit) {
            char value[48]; size_t n = 0;
            while (*p && *p != ' ') { if (n+1 >= sizeof value) return false; value[n++] = *p++; }
            value[n] = 0; if (*p) ++p;
            if (v3_equal(w, i, value)) { if (found & (UINT64_C(1)<<bit)) return false; found |= UINT64_C(1)<<bit; matched = true; }
        }
        if (!matched) return false;
        ++count;
    }
    return count == expected;
}
bool v3_id(const char *s) {
    size_t n = strlen(s); if (!n || n > 64) return false;
    for (size_t i = 0; i < n; ++i) if (!((s[i] >= 'a' && s[i] <= 'z') || (s[i] >= '0' && s[i] <= '9') || (i && (s[i] == '_' || s[i] == '-')))) return false;
    return true;
}
bool v3_uuid(const char *s) {
    if (strlen(s) != 36 || s[14] != '4' || !strchr("89ab", s[19])) return false;
    for (unsigned i = 0; i < 36; ++i) {
        if (i == 8 || i == 13 || i == 18 || i == 23) { if (s[i] != '-') return false; }
        else if (!strchr("0123456789abcdef", s[i])) return false;
    }
    return true;
}
bool v3_hash_string(const char *s) { if (strlen(s) != 64) return false; for (unsigned i = 0; i < 64; ++i) if (!strchr("0123456789abcdef",s[i])) return false; return true; }
bool v3_date(const char *s, uint64_t *out) {
    if (strlen(s) != 24) return false;
    for (unsigned i = 0; i < 24; ++i) {
        char c = i == 4 || i == 7 ? '-' : i == 10 ? 'T' : i == 13 || i == 16 ? ':' : i == 19 ? '.' : i == 23 ? 'Z' : 0;
        if (c ? s[i] != c : s[i] < '0' || s[i] > '9') return false;
    }
    unsigned year=(s[0]-48)*1000u+(s[1]-48)*100u+(s[2]-48)*10u+s[3]-48;
    unsigned month=(s[5]-48)*10u+s[6]-48, day=(s[8]-48)*10u+s[9]-48;
    unsigned hour=(s[11]-48)*10u+s[12]-48, minute=(s[14]-48)*10u+s[15]-48, second=(s[17]-48)*10u+s[18]-48;
    unsigned milli=(s[20]-48)*100u+(s[21]-48)*10u+s[22]-48;
    const unsigned md[]={31,28,31,30,31,30,31,31,30,31,30,31};
    bool leap=!(year%4)&&(year%100||!(year%400));
    if (year<1970 || !month || month>12 || !day || day>md[month-1]+(month==2&&leap) || hour>23 || minute>59 || second>59) return false;
    uint64_t days=365u*(year-1970u)+(year-1)/4u-1969u/4u-(year-1)/100u+1969u/100u+(year-1)/400u-1969u/400u;
    for (unsigned m=1;m<month;++m) days+=md[m-1]+(m==2&&leap);
    *out=(((days+day-1)*24u+hour)*60u+minute)*60000u+second*1000u+milli; return true;
}
typedef struct { char *out; size_t cap,used; bool ok; } sink_t;
static void put(sink_t *s,const char *p,size_t n) { if(!s->ok)return; if(n>=s->cap-s->used){s->ok=false;return;}memcpy(s->out+s->used,p,n);s->used+=n;s->out[s->used]=0; }
static int key_compare(cp_v3_control_workspace_t *w,unsigned a,unsigned b) {
    size_t x=w->tokens[a].key_end-w->tokens[a].key_start,y=w->tokens[b].key_end-w->tokens[b].key_start;
    int cmp=memcmp(w->input+w->tokens[a].key_start,w->input+w->tokens[b].key_start,x<y?x:y);
    return cmp?cmp:x<y?-1:x>y?1:0;
}
static void canonical_node(cp_v3_control_workspace_t *w,int at,sink_t *s) {
    cp_v3_control_token_t *t=&w->tokens[at]; char number[32];
    if(t->kind==V3_STRING){put(s,"\"",1);put(s,(const char *)w->input+t->start,t->end-t->start);put(s,"\"",1);}
    else if(t->kind==V3_NUMBER){int n=snprintf(number,sizeof number,"%llu",(unsigned long long)t->number);put(s,number,(size_t)n);}
    else if(t->kind>=V3_TRUE){const char *v=t->kind==V3_TRUE?"true":t->kind==V3_FALSE?"false":"null";put(s,v,strlen(v));}
    else {
        uint16_t children[64]; unsigned count=0;
        for(uint16_t i=t->first;i!=V3_NONE;i=w->tokens[i].next){if(count==64){s->ok=false;return;}children[count++]=i;}
        if(t->kind==V3_OBJECT) for(unsigned i=1;i<count;++i){uint16_t v=children[i];unsigned j=i;while(j&&key_compare(w,children[j-1],v)>0){children[j]=children[j-1];--j;}children[j]=v;}
        put(s,t->kind==V3_OBJECT?"{":"[",1);
        for(unsigned i=0;i<count;++i){if(i)put(s,",",1);cp_v3_control_token_t *c=&w->tokens[children[i]];
            if(t->kind==V3_OBJECT){put(s,"\"",1);put(s,(const char *)w->input+c->key_start,c->key_end-c->key_start);put(s,"\":",2);}canonical_node(w,children[i],s);}
        put(s,t->kind==V3_OBJECT?"}":"]",1);
    }
}
bool v3_canonical(cp_v3_control_workspace_t *w,int at,char *out,size_t cap,size_t *length) {
    if(at<0||at>=w->count||!cap)return false;
    sink_t s={.out=out,.cap=cap,.ok=true};out[0]=0;canonical_node(w,at,&s);*length=s.used;return s.ok;
}
bool v3_digest(cp_v3_control_t *c,int at,char digest[65]) {
    static const char prefix[]="campuspulse-v3-canonical-json/1\n";
    cp_v3_control_workspace_t *w=c->workspace;memcpy(w->canonical,prefix,sizeof prefix-1);size_t n;
    if(!v3_canonical(w,at,w->canonical+sizeof prefix-1,sizeof w->canonical-sizeof prefix+1,&n))return false;
    uint8_t hash[32];if(!c->sha256(c->hash_context,w->canonical,n+sizeof prefix-1,hash))return false;
    static const char hex[]="0123456789abcdef";for(unsigned i=0;i<32;++i){digest[2*i]=hex[hash[i]>>4];digest[2*i+1]=hex[hash[i]&15];}digest[64]=0;return true;
}
