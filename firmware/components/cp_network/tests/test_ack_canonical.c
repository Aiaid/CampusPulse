#include "ack_transport.h"
#include "cJSON.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
static bool tls_live;
static unsigned allocations,releases;
static void *checked_malloc(size_t n) { assert(!tls_live);++allocations;return malloc(n); }
static void release_client(void *unused) { (void)unused;tls_live=false;++releases; }
static void make_ack(char *out,size_t capacity,const cp_network_batch_t *e,
    const char *number,const char *receipt)
{
    int n=snprintf(out,capacity,"{\"node_id\":\"%s\",\"boot_id\":\"%s\",\"stream\":\"%s\",\"batch_id\":\"%s\",\"body_sha256\":\"%s\",\"accepted_count\":%s,\"durability\":\"committed\",\"receipt_id\":%s,\"received_at\":\"2026-10-24T12:00:00.000Z\"}",
        e->node_id,e->boot_id,e->stream,e->batch_id,e->body_sha256,number,receipt);
    assert(n>0&&(size_t)n<capacity);
}
static void replace(char *out,size_t capacity,const char *source,const char *needle,const char *value) {
    const char *p=strstr(source,needle);assert(p);size_t first=(size_t)(p-source),n=strlen(value),tail=strlen(p+strlen(needle));
    assert(first+n+tail<capacity);memcpy(out,source,first);memcpy(out+first,value,n);memcpy(out+first+n,p+strlen(needle),tail+1);
}
static bool transport(const char *text,size_t length,const cp_network_batch_t *e,
    cp_network_ack_t *ack,cp_ack_canonical_result_t expected)
{
    tls_live=true;allocations=releases=0;cp_ack_canonical_result_t kind;
    bool ok=cp_network_parse_ack_transport(text,length,e,ack,release_client,NULL,&kind);
    assert(kind==expected);
    if(kind==CP_ACK_CANONICAL_MATCH)assert(tls_live&&!allocations&&!releases);
    else assert(!tls_live&&releases==1);
    return ok;
}
int main(void) {
    cp_network_batch_t e={.accepted_count=3};
    strcpy(e.node_id,"cp_aabbccddeeff");strcpy(e.boot_id,"12345678-1234-4234-8234-123456789abc");
    strcpy(e.stream,"address_summaries");strcpy(e.batch_id,"abcdef12-1234-4234-8234-123456789abc");
    assert(cp_network_sha256("abc",3,e.body_sha256));
    cJSON_Hooks hooks={checked_malloc,free};cJSON_InitHooks(&hooks);
    char valid[1024],body[8193];cp_network_ack_t ack={.http_status=200};
    make_ack(valid,sizeof valid,&e,"3","\"receipt_test\"");
    assert(transport(valid,strlen(valid),&e,&ack,CP_ACK_CANONICAL_MATCH));
    assert(!strcmp(ack.receipt_id,"receipt_test")&&ack.http_status==200);
    for(unsigned count=1;count<=CP_NETWORK_ITEMS_MAX;++count){char token[8];snprintf(token,sizeof token,"%u",count);e.accepted_count=count;
        make_ack(body,sizeof body,&e,token,"\"receipt\"");assert(transport(body,strlen(body),&e,&ack,CP_ACK_CANONICAL_MATCH));}
#if CONFIG_CP_NETWORK_MAX_BATCH_ITEMS == 64
    /* Current S3 batches coexist with old nine-item frozen bodies. */
    e.accepted_count=9;make_ack(body,sizeof body,&e,"9","\"legacy_receipt\"");
    assert(transport(body,strlen(body),&e,&ack,CP_ACK_CANONICAL_MATCH));
    e.accepted_count=64;make_ack(body,sizeof body,&e,"64.0","\"receipt64\"");
    assert(transport(body,strlen(body),&e,&ack,CP_ACK_NEEDS_GENERAL));
    make_ack(body,sizeof body,&e,"63","\"wrong_count\"");
    assert(!transport(body,strlen(body),&e,&ack,CP_ACK_CANONICAL_INVALID));
#endif
    e.accepted_count=3;
    const char *needles[]={"cp_aabbccddeeff","12345678-1234-4234-8234-123456789abc","address_summaries",
        "abcdef12-1234-4234-8234-123456789abc","ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad","committed","2026-10-24T12:00:00.000Z"};
    for(size_t i=0;i<sizeof needles/sizeof needles[0];++i){replace(body,sizeof body,valid,needles[i],i==6?"2026-02-30T12:00:00.000Z":"wrong");
        assert(!transport(body,strlen(body),&e,&ack,CP_ACK_CANONICAL_INVALID));assert(!allocations);}
    const char *dates[]={"2024-02-29T23:59:59.999Z","2023-02-29T23:59:59.999Z",
        "2020-01-01T00:00:00.000Z","2199-12-31T23:59:59.999Z","2200-01-01T00:00:00.000Z",
        "2026-10-24T24:00:00.000Z","2026-10-24T12:00:60.000Z"};
    const bool valid_date[]={true,false,true,true,false,false,false};
    for(size_t i=0;i<sizeof dates/sizeof dates[0];++i){replace(body,sizeof body,valid,needles[6],dates[i]);
        assert(transport(body,strlen(body),&e,&ack,valid_date[i]?CP_ACK_CANONICAL_MATCH:CP_ACK_CANONICAL_INVALID)==valid_date[i]);assert(!allocations);}
    make_ack(body,sizeof body,&e,"128","\"receipt\"");assert(!transport(body,strlen(body),&e,&ack,CP_ACK_CANONICAL_INVALID));
    make_ack(body,sizeof body,&e,"3.0","\"receipt\"");assert(transport(body,strlen(body),&e,&ack,CP_ACK_NEEDS_GENERAL));assert(allocations);
    make_ack(body,sizeof body,&e,"3e0","\"receipt\"");assert(transport(body,strlen(body),&e,&ack,CP_ACK_NEEDS_GENERAL));
    replace(body,sizeof body,valid,"node_id","node\\u005fid");assert(transport(body,strlen(body),&e,&ack,CP_ACK_NEEDS_GENERAL));
    make_ack(body,sizeof body,&e,"3","\"receipt\\u005ftest\"");assert(transport(body,strlen(body),&e,&ack,CP_ACK_NEEDS_GENERAL));
    assert(!strcmp(ack.receipt_id,"receipt_test"));
    make_ack(body,sizeof body,&e,"3","\"receipt\\u0000suffix\"");assert(!transport(body,strlen(body),&e,&ack,CP_ACK_NEEDS_GENERAL));assert(!allocations);
    strcpy(body,valid);size_t length=strlen(body);char *receipt=strstr(body,"receipt_test");assert(receipt);receipt[3]=0;
    assert(!transport(body,length,&e,&ack,CP_ACK_CANONICAL_INVALID));assert(!allocations);
    char huge[7001];memset(huge,'9',7000);huge[7000]=0;make_ack(body,sizeof body,&e,huge,"\"receipt\"");
    assert(!transport(body,strlen(body),&e,&ack,CP_ACK_NEEDS_GENERAL));assert(allocations);
    make_ack(body,sizeof body,&e,"3e0","\"receipt\"");char bad_identity[8193];replace(bad_identity,sizeof bad_identity,body,e.body_sha256,"wrong");
    assert(!transport(bad_identity,strlen(bad_identity),&e,&ack,CP_ACK_NEEDS_GENERAL));
    strcpy(body,valid);length=strlen(body);snprintf(body+length-1,sizeof body-length+1,",\"node_id\":\"%s\"}",e.node_id);
    assert(!transport(body,strlen(body),&e,&ack,CP_ACK_CANONICAL_INVALID));
    strcpy(body,valid);length=strlen(body);snprintf(body+length-1,sizeof body-length+1,",\"node\\u005fid\":\"%s\"}",e.node_id);
    assert(!transport(body,strlen(body),&e,&ack,CP_ACK_NEEDS_GENERAL));
    make_ack(body,sizeof body,&e,"3.0","\"receipt\"");tls_live=true;allocations=0;
    assert(!cp_network_parse_ack_transport(body,strlen(body),&e,&ack,NULL,NULL,NULL)&&!allocations);
    tls_live=false;cJSON_InitHooks(NULL);
    puts("ACK transport: zero-allocation canonical/date/identity, release-before-general, huge numbers, NUL and legacy forms passed");
}
