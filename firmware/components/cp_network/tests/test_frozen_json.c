#include "cp_frozen_json.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
static unsigned hashes;
bool cp_network_sha256(const void *body,size_t length,char out[65]) {
    assert(body&&length);++hashes;memset(out,'a',64);out[64]=0;return true;
}
static void envelope(char *out,size_t capacity,const char *items) {
    int n=snprintf(out,capacity,"{\"protocol\":\"campuspulse/2\",\"node_id\":\"cp_020000000001\",\"boot_id\":\"00000000-0000-4000-8000-000000000001\",\"placement_id\":\"synthetic-place\",\"capture_config_id\":\"synthetic-config\",\"dataset\":\"controlled_test\",\"firmware_version\":\"test\",\"batch_id\":\"00000000-0000-4000-8000-000000000002\",\"stream\":\"ble_windows\",\"items\":%s}",items);
    assert(n>0&&(size_t)n<capacity);
}
int main(void) {
    char body[CP_NETWORK_BODY_MAX+1];cp_network_batch_t m;
    envelope(body,sizeof body,"[ { \"a\":1, \"nested\": {\"x\":[true,false,null,-1.25e+3,\"\\uD83D\\uDE00\"]} },{} ]");
    assert(cp_frozen_metadata(body,strlen(body),&m));
    assert(m.accepted_count==2&&!strcmp(m.node_id,"cp_020000000001")&&!strcmp(m.stream,"ble_windows"));
    for(size_t n=0;n<strlen(body);++n)assert(!cp_frozen_metadata(body,n,&m));
    const char *invalid[]={"[]","[1]","[null]","[{} ,]","[{\"a\":01}]","[{\"a\":1.}]",
        "[{\"a\":1e}]","[{\"a\":NaN}]","[{\"a\":truefalse}]","[{\"a\":\"\\uD800\"}]",
        "[{\"a\":\"\\uDC00\"}]","[{\"a\":\"\\x01\"}]","[{\"a\":1,\"a\":2}]",
        "[{\"a\":1,\"\\u0061\":2}]","[{\"x\":{\"a\":1, \"a\":2}}]"};
    for(size_t i=0;i<sizeof invalid/sizeof invalid[0];++i){envelope(body,sizeof body,invalid[i]);assert(!cp_frozen_metadata(body,strlen(body),&m));}
    envelope(body,sizeof body,"[{}]");size_t n=strlen(body);
    body[n-1]=',';strcpy(body+n,"\"node\\u005fid\":\"cp_020000000002\"}");
    assert(!cp_frozen_metadata(body,strlen(body),&m));
    envelope(body,sizeof body,"[{}]");n=strlen(body);body[n++]='x';
    assert(!cp_frozen_metadata(body,n,&m));
    envelope(body,sizeof body,"[{\"a\":\"xx\"}]");char *bad=strstr(body,"xx");assert(bad);bad[0]=(char)0xc0;bad[1]=(char)0x80;
    assert(!cp_frozen_metadata(body,strlen(body),&m));
    char nested[128];size_t used=0;for(unsigned i=0;i<14;i++)nested[used++]='[';nested[used++]='0';for(unsigned i=0;i<14;i++)nested[used++]=']';nested[used]=0;
    char items[256];snprintf(items,sizeof items,"[{\"deep\":%s}]",nested);envelope(body,sizeof body,items);
    assert(!cp_frozen_metadata(body,strlen(body),&m));
    char *large=malloc(7600);assert(large);memset(large,'x',7599);large[7599]=0;
    char *large_items=malloc(7630);assert(large_items);snprintf(large_items,7630,"[{\"padding\":\"%s\"}]",large);
    envelope(body,sizeof body,large_items);assert(cp_frozen_metadata(body,strlen(body),&m));
    free(large_items);free(large);
    assert(hashes==2);
    puts("frozen JSON: allocation-free syntax, full-length hash, item count, escaped duplicates, UTF8/depth bounds passed");
}
