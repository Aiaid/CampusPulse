#include <assert.h>
#include <stdio.h>
#include <string.h>
#include "probe_wire.h"
static const char *run="00112233445566778899aabbccddeeff";
static const char *hash="0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
static void receipt(char out[PROBE_RECEIPT_CAP],unsigned seq,unsigned bytes)
{
    snprintf(out,PROBE_RECEIPT_CAP,"{\"protocol\":\"cp-link-probe/1\",\"kind\":\"transport_received\",\"run_id\":\"%s\",\"seq\":%u,\"bytes\":%u,\"sha256\":\"%s\",\"connection_id\":\"10000000-0000-4000-8000-000000000001\",\"colo\":\"HKG\"}",run,seq,bytes,hash);
}
static void replace_once(char text[PROBE_RECEIPT_CAP],const char *old,const char *replacement)
{
    char copy[PROBE_RECEIPT_CAP];strcpy(copy,text);const char *at=strstr(copy,old);assert(at);
    size_t prefix=(size_t)(at-copy),tail=strlen(at+strlen(old)),n=strlen(replacement);
    assert(prefix+n+tail<PROBE_RECEIPT_CAP);
    memcpy(text,copy,prefix);memcpy(text+prefix,replacement,n);memcpy(text+prefix+n,at+strlen(old),tail+1);
}
static void decoded_nul_tests(void)
{
    char text[PROBE_RECEIPT_CAP],replacement[128];probe_receipt_t out={0};
    const char *keys[]={"protocol","kind","run_id","seq","bytes","sha256","connection_id","colo"};
    for(unsigned i=0;i<sizeof(keys)/sizeof(keys[0]);i++){
        receipt(text,7,8192);char old[64];snprintf(old,sizeof(old),"\"%s\":",keys[i]);
        snprintf(replacement,sizeof(replacement),"\"%s\\u0000suffix\":",keys[i]);replace_once(text,old,replacement);
        assert(!probe_receipt(text,strlen(text),run,7,8192,hash,&out));
    }
    const char *values[]={"cp-link-probe/1","transport_received",run,hash,"10000000-0000-4000-8000-000000000001","HKG"};
    for(unsigned i=0;i<sizeof(values)/sizeof(values[0]);i++){
        receipt(text,7,8192);snprintf(replacement,sizeof(replacement),"%s\\u0000suffix",values[i]);
        replace_once(text,values[i],replacement);assert(!probe_receipt(text,strlen(text),run,7,8192,hash,&out));
    }
    // Legitimate JSON escapes remain valid; these decode to the exact protocol.
    receipt(text,7,8192);replace_once(text,"cp-link-probe/1","cp-link-probe\\/1");
    assert(probe_receipt(text,strlen(text),run,7,8192,hash,&out));
    receipt(text,7,8192);replace_once(text,"cp-link-probe/1","cp-link-probe\\u002f1");
    assert(probe_receipt(text,strlen(text),run,7,8192,hash,&out));
    // A literal backslash-u spelling is not a decoded NUL; it is still rejected
    // because it does not exactly match the expected protocol string.
    receipt(text,7,8192);replace_once(text,"cp-link-probe/1","cp-link-probe/1\\\\u0000suffix");
    assert(!probe_receipt(text,strlen(text),run,7,8192,hash,&out));
}
int main(void)
{
    decoded_nul_tests();
    uint8_t id[16],data[8192];for(unsigned i=0;i<16;i++)id[i]=i*17;
    probe_payload(data,sizeof(data),id,0x01020304);assert(!memcmp(data,id,16));
    assert(data[16]==1&&data[17]==2&&data[18]==3&&data[19]==4);
    assert(data[8191]==(uint8_t)(8191u*31u+0x01020304u*17u));
    char text[PROBE_RECEIPT_CAP];probe_receipt_t out={0};receipt(text,7,8192);
    assert(probe_receipt(text,strlen(text),run,7,8192,hash,&out));
    assert(!probe_receipt(text,strlen(text),run,8,8192,hash,&out));
    assert(!probe_receipt(text,strlen(text),run,7,1024,hash,&out));
    assert(!probe_receipt(text,strlen(text),"ffffffffffffffffffffffffffffffff",7,8192,hash,&out));
    char bad_hash[65];strcpy(bad_hash,hash);bad_hash[63]='0';assert(!probe_receipt(text,strlen(text),run,7,8192,bad_hash,&out));
    size_t n=strlen(text);text[n-1]=0;strcat(text,",\"seq\":7}");assert(!probe_receipt(text,strlen(text),run,7,8192,hash,&out));
    receipt(text,7,8192);strcat(text,"{}");assert(!probe_receipt(text,strlen(text),run,7,8192,hash,&out));
    const char *nested="{\"nested\":[[[[]]]]}";assert(!probe_receipt(nested,strlen(nested),run,7,8192,hash,&out));
    receipt(text,7,8192);text[9]=0;assert(!probe_receipt(text,n,run,7,8192,hash,&out));
    probe_assembly_t a={0};
    assert(probe_fragment(&a,1,false,0,5,"abc",3)==0);
    assert(probe_fragment(&a,1,false,3,5,"de",2)==0);
    assert(probe_fragment(&a,0xa,true,0,0,"",0)==0); // interleaved pong
    assert(probe_fragment(&a,0,true,0,2,"fg",2)==1);
    assert(a.used==7&&!memcmp(a.buffer,"abcdefg",7));
    assert(probe_fragment(&a,0,true,0,1,"x",1)==-1); // orphan continuation
    memset(&a,0,sizeof(a));assert(probe_fragment(&a,1,true,0,5,"abc",3)==0);
    assert(probe_fragment(&a,1,true,4,5,"x",1)==-1); // skipped chunk
    memset(&a,0,sizeof(a));assert(probe_fragment(&a,1,true,0,8192,(char*)data,8192)==-1);
    memset(&a,0,sizeof(a));assert(probe_fragment(&a,1,false,0,1,"x",1)==0);
    assert(probe_fragment(&a,1,true,0,1,"y",1)==-1); // illegal overlapping message
    puts("wire framing, correlation, decoded-NUL/escape rejection, duplicate/trailing JSON and fragment bounds pass");
}
