#define main nvs_storage_fixture_main
#include "test.c"
#undef main
#include "internal.h"
#include <openssl/sha.h>
static cp_v3_control_workspace_t workspace;
static unsigned match_calls;
static bool sha(void *ctx,const void *p,size_t n,uint8_t out_hash[32]) { (void)ctx; return SHA256(p,n,out_hash)!=NULL; }
static bool match(void *ctx,const cp_v3_expected_t *e,const void *body,size_t bn,const void *reply,size_t rn) {
    match_calls++;
    return cp_v3_control_match_frozen_receipt(ctx,&e->scope,body,bn,reply,rn,sha,NULL)==CP_V3_CONTROL_OK;
}
static size_t read_fixture(const char *path,char *out,size_t cap) {
    FILE *f=fopen(path,"rb"); assert(f); size_t n=fread(out,1,cap,f); assert(!ferror(f)&&feof(f)&&n<cap); fclose(f); out[n]=0; return n;
}
static void digest_hex(const void *p,size_t n,char text[65]) {
    uint8_t digest[32]; const char *hex="0123456789abcdef"; assert(sha(NULL,p,n,digest));
    for(unsigned i=0;i<32;i++){text[i*2]=hex[digest[i]>>4];text[i*2+1]=hex[digest[i]&15];} text[64]=0;
}
/* Keep valid JSON and equal length while changing one identity/digest byte. */
static void change_field(char *json,const char *field) {
    char key[80]; int n=snprintf(key,sizeof key,"\"%s\"",field); assert(n>0 && (size_t)n<sizeof key);
    char *p=strstr(json,key); assert(p); p=strchr(p,':'); assert(p); p++;
    while(*p==' ' || *p=='\n' || *p=='\r' || *p=='\t') p++;
    if(*p=='\"') p++;
    assert(*p); *p=*p=='0'?'1':'0';
}
static void preserved(unsigned slot,const unsigned char *frozen,size_t n) {
    assert(lengths[slot]==n && !memcmp(values[slot],frozen,n));
    assert(!lengths[slot+12]);
}
int main(int argc,char **argv) {
    assert(argc==4); char body[2048],reply[4096],changed[4096];
    size_t bn=read_fixture(argv[1],body,sizeof body),rn=read_fixture(argv[2],reply,sizeof reply); assert(bn<=1024);
    cp_v3_expected_t e={0}; strcpy(e.scope.node_id,"synthetic-stats-notregister"); strcpy(e.scope.placement_id,"place"); strcpy(e.scope.dataset,"controlled_test");
    assert(v3_parse(&workspace,body,bn));
    assert(v3_string(&workspace,v3_field(&workspace,0,"boot_id"),e.scope.boot_id,sizeof e.scope.boot_id));
    assert(v3_string(&workspace,v3_field(&workspace,0,"policy_id"),e.scope.policy_id,sizeof e.scope.policy_id));
    assert(v3_string(&workspace,v3_field(&workspace,0,"policy_sha256"),e.scope.policy_sha256,sizeof e.scope.policy_sha256));
    assert(v3_uint(&workspace,v3_field(&workspace,0,"assignment_generation"),1,V3_SAFE,&e.scope.assignment_generation));
    strcpy(e.batch_id,"00000000-0000-4000-8000-000000000002"); strcpy(e.stream,argv[3]);
    e.seq_first=e.seq_last=e.accepted_count=1; e.body_bytes=(uint32_t)bn; digest_hex(body,bn,e.body_sha256);
    assert(match(&workspace,&e,body,bn,reply,rn));
    reset(); assert(te_nvs_store_set_hash(&state,sha,NULL)); clock_now=100; clock_upper_delta=1; clock_known=true;
    cp_v3_queue_profile_config_t cfg={.profile=CP_V3_QUEUE_SMALL_RESULTS,.clock=clock_mock,.expire=expire_mock,.limits={1,0,1,1,1024}};
    assert(cp_v3_queue_open_profile(&actual_queue,q,e.scope.node_id,e.scope.boot_id,sha,NULL,&cfg)==CP_V3_QUEUE_OK);
    unsigned slot=0; cp_v3_expected_t wrong_hash=e; wrong_hash.body_sha256[0]=wrong_hash.body_sha256[0]=='0'?'1':'0';
    assert(cp_v3_queue_push_expiring(&actual_queue,CP_V3_QUEUE_CONTROL,&wrong_hash,body,bn,1000,&slot)==CP_V3_QUEUE_MISMATCH && !lengths[2]);
    assert(cp_v3_queue_push_expiring(&actual_queue,CP_V3_QUEUE_CONTROL,&e,body,bn,1000,&slot)==CP_V3_QUEUE_OK && slot==2);
    assert(lengths[slot]==bn+518);
    unsigned char frozen[TE_NVS_RECORD_MAX]; size_t frozen_length=lengths[slot];
    memcpy(frozen,values[slot],frozen_length);
    prepare(); assert(te_nvs_store_set_hash(&state,sha,NULL));
    assert(cp_v3_queue_open_profile(&recovered_queue,q,e.scope.node_id,e.scope.boot_id,sha,NULL,&cfg)==CP_V3_QUEUE_OK);
    const char *new_boot="00000000-0000-4000-8000-000000000099";
    assert(strcmp(new_boot,e.scope.boot_id));
    /* Default, generic source-history and legacy profiles stay isolated. */
    assert(cp_v3_queue_open_profile(&actual_queue,q,e.scope.node_id,new_boot,sha,NULL,&cfg)==CP_V3_QUEUE_OK);
    assert(actual_queue.slots[slot].state==CP_V3_QUEUE_QUARANTINED);
    assert(cp_v3_queue_ack_control(&actual_queue,slot,reply,rn,match,&workspace)==CP_V3_QUEUE_NOT_FOUND);
    preserved(slot,frozen,frozen_length);
    cp_v3_queue_profile_config_t historical=cfg; historical.allow_historical_small=true;
    assert(cp_v3_queue_open_profile(&actual_queue,q,e.scope.node_id,new_boot,sha,NULL,&historical)==CP_V3_QUEUE_OK);
    assert(actual_queue.slots[slot].state==CP_V3_QUEUE_QUARANTINED);
    assert(cp_v3_queue_ack_control(&actual_queue,slot,reply,rn,match,&workspace)==CP_V3_QUEUE_NOT_FOUND);
    historical.allow_historical_small=false; historical.allow_historical_control_reclaim=true;
    cp_v3_queue_profile_config_t legacy=historical; legacy.profile=CP_V3_QUEUE_FEATURE_TRIAL;
    assert(cp_v3_queue_open_profile(&actual_queue,q,e.scope.node_id,new_boot,sha,NULL,&legacy)==CP_V3_QUEUE_OK);
    assert(actual_queue.slots[slot].state==CP_V3_QUEUE_QUARANTINED);
    assert(cp_v3_queue_ack_control(&actual_queue,slot,reply,rn,match,&workspace)==CP_V3_QUEUE_NOT_FOUND);
    assert(cp_v3_queue_open_profile(&actual_queue,q,"synthetic-other-node",new_boot,sha,NULL,&historical)==CP_V3_QUEUE_OK);
    assert(actual_queue.slots[slot].state==CP_V3_QUEUE_QUARANTINED);
    assert(cp_v3_queue_ack_control(&actual_queue,slot,reply,rn,match,&workspace)==CP_V3_QUEUE_NOT_FOUND);
    preserved(slot,frozen,frozen_length);
    /* The explicit control opt-in exposes the original envelope and bytes. */
    assert(cp_v3_queue_open_profile(&actual_queue,q,e.scope.node_id,new_boot,sha,NULL,&historical)==CP_V3_QUEUE_OK);
    assert(actual_queue.slots[slot].state==CP_V3_QUEUE_PENDING && actual_queue.historical_slots==1);
    char restored[2048]; size_t restored_length=0; cp_v3_expected_t saved;
    assert(cp_v3_queue_read(&actual_queue,slot,restored,sizeof restored,&restored_length,&saved)==CP_V3_QUEUE_OK);
    assert(restored_length==bn && !memcmp(restored,body,bn));
    assert(!memcmp(&saved,&e,sizeof e));
    unsigned next_slot=99;
    assert(cp_v3_queue_push_expiring(&actual_queue,CP_V3_QUEUE_CONTROL,&e,body,bn,1000,&next_slot)==CP_V3_QUEUE_RETIRED);
    assert(actual_queue.next_ordinal==2 && next_slot==99);
    assert(cp_v3_queue_ack(&actual_queue,slot,reply,rn)==CP_V3_QUEUE_MISMATCH);
    const char *fields[]={"boot_id","body_sha256","policy_sha256"};
    for(unsigned i=0;i<sizeof fields/sizeof fields[0];i++) {
        memcpy(changed,reply,rn+1); change_field(changed,fields[i]);
        assert(cp_v3_queue_ack_control(&actual_queue,slot,changed,rn,match,&workspace)==CP_V3_QUEUE_MISMATCH);
        preserved(slot,frozen,frozen_length);
    }
    if(strstr(reply,"\"lease_until_ms\"")) {
        memcpy(changed,reply,rn+1); change_field(changed,"lease_until_ms");
        assert(cp_v3_queue_ack_control(&actual_queue,slot,changed,rn,match,&workspace)==CP_V3_QUEUE_MISMATCH);
        preserved(slot,frozen,frozen_length);
    }
    cp_v3_expected_t bad=e; bad.scope.boot_id[0]=bad.scope.boot_id[0]=='0'?'1':'0'; assert(!match(&workspace,&bad,body,bn,reply,rn));
    bad=e; bad.scope.policy_sha256[0]=bad.scope.policy_sha256[0]=='0'?'1':'0'; assert(!match(&workspace,&bad,body,bn,reply,rn));
    memcpy(changed,body,bn); changed[bn/2]^=1; assert(!match(&workspace,&e,changed,bn,reply,rn));
    unsigned before=match_calls;
    clock_now=999; clock_upper_delta=1; assert(cp_v3_queue_ack_control(&actual_queue,slot,reply,rn,match,&workspace)==CP_V3_QUEUE_CLOCK_UNKNOWN);
    clock_known=false; assert(cp_v3_queue_ack_control(&actual_queue,slot,reply,rn,match,&workspace)==CP_V3_QUEUE_CLOCK_UNKNOWN);
    assert(match_calls==before); preserved(slot,frozen,frozen_length);
    clock_known=true; clock_now=100; values[slot][lengths[slot]-13]^=1;
    assert(cp_v3_queue_ack_control(&actual_queue,slot,reply,rn,match,&workspace)==CP_V3_QUEUE_IO && lengths[slot]);
    assert(match_calls==before);
    values[slot][lengths[slot]-13]^=1; prepare(); assert(te_nvs_store_set_hash(&state,sha,NULL));
    assert(cp_v3_queue_open_profile(&recovered_queue,q,e.scope.node_id,new_boot,sha,NULL,&historical)==CP_V3_QUEUE_OK);
    assert(cp_v3_queue_ack_control(&recovered_queue,slot,reply,rn,match,&workspace)==CP_V3_QUEUE_OK && !lengths[slot]);
    assert(match_calls==before+1 && !lengths[slot+12]);
    assert(cp_v3_queue_push_expiring(&recovered_queue,CP_V3_QUEUE_CONTROL,&e,body,bn,1000,&next_slot)==CP_V3_QUEUE_RETIRED && !lengths[slot]);
    /* Altering the frozen source deadline invalidates its complete envelope. */
    memcpy(values[slot],frozen,frozen_length); lengths[slot]=frozen_length; prepare(); assert(te_nvs_store_set_hash(&state,sha,NULL));
    assert(cp_v3_queue_open_profile(&actual_queue,q,e.scope.node_id,new_boot,sha,NULL,&historical)==CP_V3_QUEUE_OK);
    /* Q002: magic(8), kind(4), profile/limits(10), ordinal(8), expiry(8). */
    values[slot][30]^=1;
    before=match_calls;
    assert(cp_v3_queue_ack_control(&actual_queue,slot,reply,rn,match,&workspace)==CP_V3_QUEUE_IO);
    assert(match_calls==before && lengths[slot]==frozen_length);
    values[slot][30]^=1; preserved(slot,frozen,frozen_length);
    /* At the real deadline, failed expiry storage preserves the old body. */
    prepare(); assert(te_nvs_store_set_hash(&state,sha,NULL));
    assert(cp_v3_queue_open_profile(&actual_queue,q,e.scope.node_id,new_boot,sha,NULL,&historical)==CP_V3_QUEUE_OK);
    clock_now=1000;
    assert(cp_v3_queue_ack_control(&actual_queue,slot,reply,rn,match,&workspace)==CP_V3_QUEUE_IO);
    assert(match_calls==before); preserved(slot,frozen,frozen_length);
    puts("synthetic control receipt NVS integration passed");
}
