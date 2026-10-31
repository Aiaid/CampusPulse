#include "local_guard.h"
#include <assert.h>
#include <openssl/sha.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define ORIGIN UINT64_C(1898553600000)
static char originals[8][4096],body[4096];
static size_t lengths[8],length;
static cp_v3_expected_t expected;
static te_local_guard_time_t clock_input;
static te_local_guard_report_t result;
static cp_v3_queue_kind_t kind;
static const char *node;
static bool sha_failure;
static unsigned checks;
static bool hash(void *ctx,const void *p,size_t n,uint8_t out[32]) {
    (void)ctx;return !sha_failure&&SHA256(p,n,out)!=NULL;
}
static void refresh_hash(void) {
    uint8_t digest[32];assert(hash(NULL,body,length,digest));
    for(unsigned i=0;i<32;++i)snprintf(expected.body_sha256+2*i,3,"%02x",digest[i]);
    expected.body_bytes=length;
}
static void reset(unsigned index) {
    memcpy(body,originals[index],lengths[index]+1);length=lengths[index];memset(&expected,0,sizeof expected);
    strcpy(expected.scope.node_id,"synthetic-template-only");
    strcpy(expected.scope.boot_id,"00000000-0000-4000-8000-000000000002");
    strcpy(expected.scope.policy_id,"synthetic-template-policy");
    strcpy(expected.scope.placement_id,"synthetic-placement-not-on-wire");
    memset(expected.scope.policy_sha256,'0',64);strcpy(expected.scope.dataset,"controlled_test");
    expected.scope.assignment_generation=1;expected.scope.window_seq=1;
    strcpy(expected.batch_id,"00000000-0000-4000-8000-000000000001");
    kind=index==2||index==5?CP_V3_QUEUE_STATUS:index==4?CP_V3_QUEUE_EVENT:CP_V3_QUEUE_WINDOW;
    strcpy(expected.stream,kind==CP_V3_QUEUE_STATUS?"node_status":kind==CP_V3_QUEUE_EVENT?"candidate_events":"window_statistics");
    expected.seq_first=expected.seq_last=expected.accepted_count=1;sha_failure=false;refresh_hash();
    clock_input=(te_local_guard_time_t){.upload_now={.mono_ms=90000,.utc_ms=ORIGIN+90000,.clock_epoch=2,.uncertainty_ms=10},
        .source_expires_at_ms=ORIGIN+3600000,.max_source_age_ms=3600000};
    node="synthetic-template-only";
}
static void inspect(void) {
    char before[sizeof body];memcpy(before,body,sizeof body);cp_v3_expected_t previous=expected;
    te_local_guard_inspect(kind,&expected,node,body,length,&clock_input,hash,NULL,&result);
    assert(!memcmp(before,body,sizeof body)&&!memcmp(&previous,&expected,sizeof expected));
    assert(result.obligations==TE_LOCAL_GUARD_OBLIGATIONS);++checks;
}
static void want(te_local_guard_check_t check) {
    inspect();if(result.check!=check){fprintf(stderr,"check %u: expected %d got %d\n",checks,(int)check,(int)result.check);abort();}
}
static void replace(const char *from,const char *to) {
    char *at=strstr(body,from);assert(at);size_t start=(size_t)(at-body),old=strlen(from),n=strlen(to);
    assert(length-old+n<sizeof body);memmove(at+n,at+old,length-start-old+1);memcpy(at,to,n);length=length-old+n;refresh_hash();
}
static void bad(unsigned index,const char *from,const char *to,te_local_guard_check_t check) {
    reset(index);replace(from,to);want(check);
}
static void fixture(unsigned slot,const char *path) {
    FILE *f=fopen(path,"rb");assert(f);lengths[slot]=fread(originals[slot],1,sizeof originals[slot]-1,f);
    assert(feof(f)&&!ferror(f));fclose(f);
}
int main(int argc,char **argv) {
    assert(argc==9);for(unsigned i=0;i<8;++i)fixture(i,argv[i+1]);
    for(unsigned i=0;i<3;++i){reset(i);want(TE_LOCAL_GUARD_STRUCTURE_MATCHED);
        assert(result.observation_end_upper_ms==ORIGIN+(i==0?30000:60000));
        assert(result.observation_start_lower_ms==ORIGIN+(i==2?60000:0));
        assert(result.clock_epoch==1&&result.current_lower_ms==ORIGIN+89990);
    }
    reset(6);want(TE_LOCAL_GUARD_STRUCTURE_MATCHED); // Real synthetic dense aggregate, no addresses.
    reset(3);want(TE_LOCAL_GUARD_UNKNOWN_TIME);
    reset(4);want(TE_LOCAL_GUARD_UNSUPPORTED);
    reset(5);want(TE_LOCAL_GUARD_UNSUPPORTED);
    reset(7);want(TE_LOCAL_GUARD_BAD_INPUT); // Backend-legal width stress exceeds local 1024-byte profile.
    reset(0);kind=CP_V3_QUEUE_FEATURE;want(TE_LOCAL_GUARD_UNSUPPORTED);
    reset(0);kind=CP_V3_QUEUE_CONTROL;want(TE_LOCAL_GUARD_UNSUPPORTED);
    reset(0);kind=CP_V3_QUEUE_STATUS;want(TE_LOCAL_GUARD_SCOPE_MISMATCH);
    reset(0);node="different-node";want(TE_LOCAL_GUARD_SCOPE_MISMATCH);
    reset(0);expected.scope.node_id[0]='x';want(TE_LOCAL_GUARD_SCOPE_MISMATCH);
    reset(0);expected.scope.boot_id[0]='1';want(TE_LOCAL_GUARD_SCOPE_MISMATCH);
    reset(0);expected.scope.policy_id[0]='x';want(TE_LOCAL_GUARD_SCOPE_MISMATCH);
    reset(0);expected.scope.policy_sha256[0]='1';want(TE_LOCAL_GUARD_SCOPE_MISMATCH);
    reset(0);++expected.scope.assignment_generation;want(TE_LOCAL_GUARD_SCOPE_MISMATCH);
    reset(0);strcpy(expected.scope.dataset,"field");want(TE_LOCAL_GUARD_SCOPE_MISMATCH);
    reset(0);++expected.scope.window_seq;want(TE_LOCAL_GUARD_SCOPE_MISMATCH);
    reset(0);expected.batch_id[0]='1';want(TE_LOCAL_GUARD_SCOPE_MISMATCH);
    reset(0);expected.seq_first=expected.seq_last=2;want(TE_LOCAL_GUARD_SCOPE_MISMATCH);
    reset(0);++expected.seq_last;want(TE_LOCAL_GUARD_BAD_INPUT);
    reset(0);++expected.accepted_count;want(TE_LOCAL_GUARD_BAD_INPUT);
    reset(0);++expected.body_bytes;want(TE_LOCAL_GUARD_BAD_INPUT);
    reset(0);expected.body_sha256[0]=expected.body_sha256[0]=='0'?'1':'0';want(TE_LOCAL_GUARD_HASH_MISMATCH);
    reset(0);sha_failure=true;want(TE_LOCAL_GUARD_HASH_MISMATCH);
    reset(0);memset(expected.scope.node_id,'n',sizeof expected.scope.node_id);want(TE_LOCAL_GUARD_BAD_INPUT);
    reset(0);memset(expected.stream,'s',sizeof expected.stream);want(TE_LOCAL_GUARD_BAD_INPUT);
    reset(0);expected.scope.assignment_generation=UINT64_MAX;want(TE_LOCAL_GUARD_BAD_INPUT);
    reset(0);expected.scope.placement_id[0]='!';want(TE_LOCAL_GUARD_BAD_INPUT);
    reset(0);strcpy(expected.scope.placement_id,"other-valid-placement");want(TE_LOCAL_GUARD_STRUCTURE_MATCHED);
    // placement is not transmitted: the obligation is deliberately NOT cleared.
    assert(result.obligations&TE_LOCAL_GUARD_NEEDS_BACKEND_AUTHORIZATION);
    bad(0,"\"p\":3","\"p\":3,\"p\":3",TE_LOCAL_GUARD_BAD_BODY);
    bad(0,"\"q\":1","\"q\":1,\"q\":1",TE_LOCAL_GUARD_BAD_BODY);
    bad(0,"\"q\":1","\"q\":1,\"\\u0071\":1",TE_LOCAL_GUARD_BAD_BODY);
    bad(0,"\"q\":1","\"q\":1,\"addresses\":[\"aa:bb:cc:dd:ee:ff\"]",TE_LOCAL_GUARD_BAD_BODY);
    bad(0,"\"p\":3","\"p\":3,\"raw\":[1,2,3]",TE_LOCAL_GUARD_BAD_BODY);
    bad(0,"\"v\":[\"cp-v3-stats/1\",\"unclassified-v1\"]","\"v\":[\"aa:bb:cc:dd:ee:ff\",\"unclassified-v1\"]",TE_LOCAL_GUARD_BAD_BODY);
    bad(0,"[10,2,10,-600]","{\"address\":\"aa:bb:cc:dd:ee:ff\"}",TE_LOCAL_GUARD_BAD_BODY);
    bad(0,"\"x\":[{","\"x\":[{},{",TE_LOCAL_GUARD_BAD_BODY);
    bad(0,"\"k\":\"window_statistics\"","\"k\":\"raw\"",TE_LOCAL_GUARD_SCOPE_MISMATCH);
    bad(0,"\"p\":3","\"p\":3.0",TE_LOCAL_GUARD_BAD_BODY);
    bad(0,"\"p\":3","\"p\":03",TE_LOCAL_GUARD_BAD_BODY);
    bad(0,"\"p\":3","\"p\":3e0",TE_LOCAL_GUARD_BAD_BODY);
    bad(0,"\"q\":1","\"q\":true",TE_LOCAL_GUARD_BAD_BODY);
    bad(0,"\"g\":1","\"g\":9007199254740992",TE_LOCAL_GUARD_BAD_BODY);
    bad(0,"-600","-9007199254740992",TE_LOCAL_GUARD_BAD_BODY);
    bad(0,"-600","-0",TE_LOCAL_GUARD_BAD_BODY);
    bad(0,"-600","600",TE_LOCAL_GUARD_BAD_BODY);
    bad(0,"-600","-599",TE_LOCAL_GUARD_BAD_BODY);
    bad(0,"\"c\":[0,0,0,0,2,0]","\"c\":[1,0,0,0,1,0]",TE_LOCAL_GUARD_BAD_BODY);
    bad(0,"\"c\":[0,0,0,0,2,0]","\"c\":[0,0,0,0,513,0]",TE_LOCAL_GUARD_BAD_BODY);
    bad(0,"\"r\":[60,60,48,12]","\"r\":[59,60,48,12]",TE_LOCAL_GUARD_BAD_BODY);
    bad(0,"\"r\":[60,60,48,12]","\"r\":[60,60,48,11]",TE_LOCAL_GUARD_BAD_BODY);
    bad(0,"[10,2,10,-600]","[10,3,10,-600]",TE_LOCAL_GUARD_BAD_BODY);
    bad(0,"[10,2,10,-600]","[10,2,11,-660]",TE_LOCAL_GUARD_BAD_BODY);
    bad(0,"[10,2,10,-600]","[10,2,10,-1280]",TE_LOCAL_GUARD_BAD_BODY);
    bad(0,"\"s\":[60,-3600,-60,-60]","\"s\":[60,-3600,null,null]",TE_LOCAL_GUARD_BAD_BODY);
    bad(0,"\"s\":[60,-3600,-60,-60]","\"s\":[60,-3600,-128,20]",TE_LOCAL_GUARD_BAD_BODY);
    bad(0,"\"s\":[60,-3600,-60,-60]","\"s\":[0,0,-60,-60]",TE_LOCAL_GUARD_BAD_BODY);
    bad(0,"\"l\":[30000,0,0,0]","\"l\":[29999,0,0,0]",TE_LOCAL_GUARD_BAD_BODY);
    bad(0,"\"l\":[30000,0,0,0]","\"l\":[30001,0,0,0]",TE_LOCAL_GUARD_BAD_BODY);
    bad(0,"\"l\":[30000,0,0,0]","\"l\":[30000,1,0,0]",TE_LOCAL_GUARD_BAD_BODY);
    bad(0,"\"l\":[30000,0,0,0]","\"l\":[30000,0,0,61]",TE_LOCAL_GUARD_BAD_BODY);
    bad(0,"\"f\":0","\"f\":64",TE_LOCAL_GUARD_BAD_BODY);
    bad(0,"\"d\":30000","\"d\":30001",TE_LOCAL_GUARD_BAD_BODY);
    bad(0,"\"b\":5000","\"b\":4999",TE_LOCAL_GUARD_BAD_BODY);
    bad(0,"\"b\":5000","\"b\":0",TE_LOCAL_GUARD_BAD_BODY);
    bad(0,"\"t\":[30000,1898553630000,1,0]","\"t\":[30000,null,1,0]",TE_LOCAL_GUARD_UNKNOWN_TIME);
    bad(0,"\"t\":[30000,1898553630000,1,0]","\"t\":[30000,1898553630000,0,0]",TE_LOCAL_GUARD_UNKNOWN_TIME);
    bad(0,"\"t\":[30000,1898553630000,1,0]","\"t\":[30000,1898553630000,1,5001]",TE_LOCAL_GUARD_UNKNOWN_TIME);
    bad(0,"\"t\":[30000,1898553630000,1,0]","\"t\":[30000,1898553630000,1,1]",TE_LOCAL_GUARD_BAD_BODY);
    bad(0,"1898553630000","18446744073709551615",TE_LOCAL_GUARD_BAD_BODY);
    bad(0,"1898553630000","9007199254740991",TE_LOCAL_GUARD_UNKNOWN_TIME);
    bad(0,"1898553630000","1704067200000",TE_LOCAL_GUARD_UNKNOWN_TIME);
    bad(2,"\"u\":60000","\"u\":60001",TE_LOCAL_GUARD_BAD_BODY);
    bad(2,"\"s\":\"running\"","\"s\":\"device-address\"",TE_LOCAL_GUARD_BAD_BODY);
    bad(2,"\"j\":[1,700,0,0,1,500]","\"j\":[0,700,0,0,1,500]",TE_LOCAL_GUARD_BAD_BODY);
    bad(2,"\"l\":[0,0,0,0,0,0]","\"l\":[0,0,null,0,0,0]",TE_LOCAL_GUARD_BAD_BODY);
    bad(2,"\"r\":[null,null,null,null,null]","\"r\":[100,101,10,null,null]",TE_LOCAL_GUARD_BAD_BODY);
    bad(2,"\"r\":[null,null,null,null,null]","\"r\":[100,10,101,null,null]",TE_LOCAL_GUARD_BAD_BODY);
    bad(2,"\"q\":1","\"q\":1,\"a\":null",TE_LOCAL_GUARD_STRUCTURE_MATCHED);
    bad(2,"\"q\":1","\"q\":1,\"a\":{\"raw\":[]}",TE_LOCAL_GUARD_UNSUPPORTED);
    reset(0);replace("\"r\":[60,60,48,12]","\"r\":[61,60,48,12]");
    replace("\"l\":[30000,0,0,0]","\"l\":[29999,1,0,0]");replace("\"f\":0","\"f\":20");want(TE_LOCAL_GUARD_STRUCTURE_MATCHED);
    reset(0);replace("\"t\":[30000,1898553630000,1,0]","\"t\":[30000,1898553630000,1,100]");
    replace("\"f\":0","\"f\":2");want(TE_LOCAL_GUARD_STRUCTURE_MATCHED);
    assert(result.observation_start_lower_ms==ORIGIN-100&&result.observation_end_upper_ms==ORIGIN+30100);
    reset(0);replace("\"q\":1","\"q\":4294967295");expected.seq_first=expected.seq_last=UINT32_MAX;
    replace("\"g\":1","\"g\":9007199254740991");expected.scope.assignment_generation=UINT64_C(9007199254740991);
    want(TE_LOCAL_GUARD_STRUCTURE_MATCHED);
    reset(0);replace("\"r\":[60,60,48,12]","\"r\":[9007199254740991,9007199254740991,9007199254740991,0]");
    replace("\"s\":[60,-3600,-60,-60]","\"s\":[9007199254740991,0,-127,20]");
    want(TE_LOCAL_GUARD_BAD_BODY); // Safe-int extreme RSSI products run, then bin totals disagree.
    reset(0);replace("\"r\":[60,60,48,12]","\"r\":[9007199254740991,9007199254740991,9007199254740991,1]");
    want(TE_LOCAL_GUARD_BAD_BODY); // Addition must reject above-safe totals before wrap.
    reset(0);replace("\"c\":[0,0,0,0,2,0]","\"c\":[0,0,0,0,0,0]");
    replace("\"r\":[60,60,48,12]","\"r\":[0,0,0,0]");
    replace("\"s\":[60,-3600,-60,-60]","\"s\":[0,0,null,null]");
    for(unsigned i=0;i<6;++i)replace("[10,2,10,-600]","[0,0,0,0]");
    want(TE_LOCAL_GUARD_STRUCTURE_MATCHED);
    reset(0);clock_input.upload_now.utc_ms=0;want(TE_LOCAL_GUARD_UNKNOWN_TIME);
    reset(0);clock_input.upload_now.utc_ms=UINT64_MAX;want(TE_LOCAL_GUARD_UNKNOWN_TIME);
    reset(0);clock_input.upload_now.mono_ms=UINT64_MAX;want(TE_LOCAL_GUARD_UNKNOWN_TIME);
    reset(0);clock_input.upload_now.clock_epoch=0;want(TE_LOCAL_GUARD_UNKNOWN_TIME);
    reset(0);clock_input.upload_now.uncertainty_ms=UINT32_MAX;want(TE_LOCAL_GUARD_UNKNOWN_TIME);
    reset(0);clock_input.source_expires_at_ms=0;want(TE_LOCAL_GUARD_UNKNOWN_TIME);
    reset(0);clock_input.source_expires_at_ms=UINT64_MAX;want(TE_LOCAL_GUARD_UNKNOWN_TIME);
    reset(0);clock_input.upload_now.utc_ms=ORIGIN+30000;want(TE_LOCAL_GUARD_FUTURE);
    reset(0);clock_input.upload_now.utc_ms=ORIGIN+30010;want(TE_LOCAL_GUARD_STRUCTURE_MATCHED);
    reset(0);clock_input.source_expires_at_ms=ORIGIN+90010;want(TE_LOCAL_GUARD_EXPIRED);
    reset(0);clock_input.source_expires_at_ms=ORIGIN+90011;want(TE_LOCAL_GUARD_STRUCTURE_MATCHED);
    reset(0);clock_input.max_source_age_ms=60010;want(TE_LOCAL_GUARD_EXPIRED);
    reset(0);clock_input.max_source_age_ms=60011;want(TE_LOCAL_GUARD_STRUCTURE_MATCHED);
    reset(0);clock_input.max_source_age_ms=0;want(TE_LOCAL_GUARD_BAD_INPUT);
    reset(0);clock_input.max_source_age_ms=UINT64_MAX;want(TE_LOCAL_GUARD_BAD_INPUT);
    reset(0);memset(body+length,' ',TE_LOCAL_GUARD_BODY_MAX-length);length=TE_LOCAL_GUARD_BODY_MAX;body[length]=0;refresh_hash();
    want(TE_LOCAL_GUARD_STRUCTURE_MATCHED);body[length++]=' ';body[length]=0;refresh_hash();want(TE_LOCAL_GUARD_BAD_INPUT);
    reset(0);body[length++]=0;refresh_hash();want(TE_LOCAL_GUARD_BAD_BODY);
    reset(0);strcpy(body+length,"{}");length+=2;refresh_hash();want(TE_LOCAL_GUARD_BAD_BODY);
    for(size_t n=0;n<lengths[0];++n){reset(0);length=n;refresh_hash();inspect();assert(result.check!=TE_LOCAL_GUARD_STRUCTURE_MATCHED);}
    for(size_t at=0;at<lengths[0];++at){reset(0);body[at]=(char)((unsigned char)body[at]|0x80);refresh_hash();inspect();assert(result.check!=TE_LOCAL_GUARD_STRUCTURE_MATCHED);}
    // NUL, delimiters, nesting, signs and digits at every byte; any surviving
    // semantic variant still must retain every external obligation and be pure.
    const unsigned char mutations[]={0,'{','}','[',']','"','\\','-',':',',','0','9'};
    for(size_t at=0;at<lengths[0];++at)for(unsigned m=0;m<sizeof mutations;++m){reset(0);body[at]=(char)mutations[m];refresh_hash();inspect();}
    reset(0);te_local_guard_inspect(kind,NULL,node,body,length,&clock_input,hash,NULL,&result);
    assert(result.check==TE_LOCAL_GUARD_BAD_INPUT&&result.obligations==TE_LOCAL_GUARD_OBLIGATIONS);
    te_local_guard_inspect(kind,&expected,node,body,length,&clock_input,hash,NULL,NULL);
    printf("local guard: %u checks with actual backend synthetic fixture validation, real SHA, ASan/UBSan; diagnostic only, all obligations retained\n",checks);
    return 0;
}
