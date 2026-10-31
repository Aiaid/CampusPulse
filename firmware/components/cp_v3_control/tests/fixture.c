#include "cp_v3_control.h"
#include <assert.h>
#include <openssl/sha.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static cp_v3_control_t control, saved;
static cp_v3_control_workspace_t workspace;
static unsigned apply_calls;
static cp_v3_apply_result_t outcome;
static bool reopen;
static bool hash(void *ctx,const void *bytes,size_t n,uint8_t out[32]){(void)ctx;return SHA256(bytes,n,out)!=NULL;}
static cp_v3_time_t now(void){return(cp_v3_time_t){.mono_ms=60000,.utc_ms=1793318460000ULL,.clock_epoch=1,.uncertainty_ms=10};}
static cp_v3_apply_result_t apply(void *ctx,const cp_v3_trial_policy_t *p,cp_v3_boundary_t *b){
    (void)ctx;++apply_calls;assert(p->evidence.max_identifiers==16&&p->evidence.max_evidence_bytes==65536);
    assert(p->queue_max_bytes==49152&&p->feature_reserve_items==8&&p->status_reserve_items==2&&p->control_reserve_items==2);
    if(reopen)b->window_open=true;
    return outcome;
}
static size_t read_file(const char *path,char out[CP_V3_CONTROL_JSON_MAX]){
    FILE *f=fopen(path,"rb");assert(f);size_t n=fread(out,1,CP_V3_CONTROL_JSON_MAX,f);assert(!ferror(f)&&feof(f));fclose(f);return n;
}
static void registration(void){
    const char *body;size_t n;
    assert(cp_v3_control_registration(&control,1,60000,&body,&n)==CP_V3_CONTROL_OK&&n&&strstr(body,"\"capabilities\""));
    char frozen[CP_V3_CONTROL_JSON_MAX];memcpy(frozen,body,n);
    const char *again;size_t again_n;
    assert(cp_v3_control_registration(&control,1,60000,&again,&again_n)==CP_V3_CONTROL_OK&&n==again_n&&!memcmp(frozen,again,n));
    assert(cp_v3_control_registration(&control,2,60000,&again,&again_n)==CP_V3_CONTROL_STATE);
    char receipt[1024];int len=snprintf(receipt,sizeof receipt,"{\"protocol\":\"campuspulse/3\",\"node_id\":\"synthetic-node\",\"boot_id\":\"11111111-1111-4111-8111-111111111111\",\"registration_seq\":1,\"capability_sha256\":\"%s\",\"registered_at\":\"2026-10-30T00:00:50.000Z\",\"applied\":false,\"capability_evidence\":\"device_claim\"}",control.capability_sha256);
    assert(cp_v3_control_registration_receipt(&control,receipt,(size_t)len,now())==CP_V3_CONTROL_OK);
    assert(!cp_v3_control_permissions(&control,now()).collection);
}
static size_t receipt(char out[4096],const char *ack,size_t n,const char *timestamp){
    assert(n&&ack[n-1]=='}');memcpy(out,ack,n-1);
    int extra=snprintf(out+n-1,4096-n+1,",\"node_id\":\"synthetic-node\",\"received_at\":\"%s\",\"durability\":\"committed\",\"evidence\":\"device_ack\"}",timestamp);
    assert(extra>0);return n-1+(size_t)extra;
}
int main(int argc,char **argv){
    assert(argc==6);char caps[CP_V3_CONTROL_JSON_MAX],response[CP_V3_CONTROL_JSON_MAX];
    size_t cn=read_file(argv[2],caps),rn=read_file(argv[3],response);
    cp_v3_control_result_t result=cp_v3_control_init(&control,&workspace,"synthetic-node","11111111-1111-4111-8111-111111111111",caps,cn,now(),hash,NULL);
    assert(result==CP_V3_CONTROL_OK&&!strcmp(control.capability_sha256,argv[4]));
    registration();result=cp_v3_control_offer(&control,response,rn,now());
    if(!strcmp(argv[1],"reject")){assert(result!=CP_V3_CONTROL_OK&&!apply_calls&&!cp_v3_control_permissions(&control,now()).collection);return 0;}
    assert(result==CP_V3_CONTROL_OK&&!strcmp(control.policy.scope.policy_sha256,argv[5]));
    assert(!cp_v3_control_permissions(&control,now()).uplink);
    saved=control;cp_v3_boundary_t b={.window_open=true};
    assert(cp_v3_control_apply(&control,now(),b,1,apply,NULL)==CP_V3_CONTROL_BOUNDARY&&!apply_calls);
    b.window_open=false;b.closed_window_seq=UINT32_MAX;
    assert(cp_v3_control_apply(&control,now(),b,1,apply,NULL)==CP_V3_CONTROL_BOUNDARY&&!apply_calls);
    b.closed_window_seq=0;outcome=CP_V3_APPLY_STORAGE_FAILED;
    assert(cp_v3_control_apply(&control,now(),b,1,apply,NULL)==CP_V3_CONTROL_OK&&apply_calls==1);
    size_t an;const char *ack=cp_v3_control_ack_bytes(&control,&an);assert(ack&&strstr(ack,"storage_failed"));
    char reply[4096];size_t len=receipt(reply,ack,an,"2026-10-30T00:01:00.000Z");
    assert(cp_v3_control_ack_receipt(&control,reply,len,now())==CP_V3_CONTROL_OK&&control.state==CP_V3_CONTROL_FAILED);
    assert(!cp_v3_control_permissions(&control,now()).collection);
    control=saved;outcome=CP_V3_APPLY_OK;reopen=true;
    assert(cp_v3_control_apply(&control,now(),b,1,apply,NULL)==CP_V3_CONTROL_OK);
    ack=cp_v3_control_ack_bytes(&control,&an);assert(strstr(ack,"boundary_failed"));
    control=saved;reopen=false;
    assert(cp_v3_control_apply(&control,now(),b,1,apply,NULL)==CP_V3_CONTROL_OK);
    ack=cp_v3_control_ack_bytes(&control,&an);assert(!strstr(ack,"error_code"));
    assert(!cp_v3_control_permissions(&control,now()).collection);
    char frozen[CP_V3_CONTROL_ACK_MAX];memcpy(frozen,ack,an);
    assert(cp_v3_control_apply(&control,now(),b,2,apply,NULL)==CP_V3_CONTROL_STATE&&!memcmp(frozen,ack,an));
    len=receipt(reply,ack,an,"2026-10-30T00:01:00.000Z");
    char wrong[4096];memcpy(wrong,reply,len);char *p=strstr(wrong,"committed");assert(p);*p='X';
    assert(cp_v3_control_ack_receipt(&control,wrong,len,now())==CP_V3_CONTROL_BINDING_MISMATCH&&!cp_v3_control_permissions(&control,now()).collection);
    assert(cp_v3_control_ack_receipt(&control,reply,len,now())==CP_V3_CONTROL_OK);
    cp_v3_time_t later=now();later.utc_ms+=20;later.mono_ms+=20;
    cp_v3_control_permissions_t permission=cp_v3_control_permissions(&control,later);
    assert(permission.collection&&permission.uplink&&permission.preserve_unacknowledged);
    assert(control.deadline_utc_ms==now().utc_ms+600000&&control.policy.scope.window_seq==1);
    uint64_t deadline=control.deadline_mono_ms;
    uint64_t horizon=deadline-now().mono_ms;
    assert(now().utc_ms+now().uncertainty_ms+horizon+(horizon+1999)/2000<control.deadline_utc_ms);
    assert(cp_v3_control_ack_receipt(&control,reply,len,later)==CP_V3_CONTROL_OK&&deadline==control.deadline_mono_ms);
    assert(cp_v3_control_offer(&control,response,rn,later)==CP_V3_CONTROL_OK&&deadline==control.deadline_mono_ms);
    cp_v3_control_t active=control;
    later.clock_epoch=2;assert(!cp_v3_control_permissions(&control,later).collection&&control.state==CP_V3_CONTROL_PAUSED);
    control=active;later.clock_epoch=1;later.mono_ms=1;
    assert(!cp_v3_control_permissions(&control,later).uplink&&control.state==CP_V3_CONTROL_PAUSED);
    control=active;later=now();later.utc_ms+=600000;later.mono_ms+=600000;
    permission=cp_v3_control_permissions(&control,later);assert(!permission.collection&&!permission.uplink&&permission.preserve_unacknowledged);
    assert(cp_v3_control_ack_receipt(&control,reply,len,later)==CP_V3_CONTROL_OK&&control.state==CP_V3_CONTROL_PAUSED);
    cp_v3_control_clear(&control);for(size_t i=0;i<sizeof control;++i)assert(((uint8_t *)&control)[i]==0);
    puts("controlled v3: full hashes, binding, actual-apply boundary, frozen ACK and nonrenewable lease passed");return 0;
}
