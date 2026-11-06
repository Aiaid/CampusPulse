#include "cp_v3_control.h"
#include <assert.h>
#include <openssl/sha.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static cp_v3_control_t control,saved,candidate;
static cp_v3_control_workspace_t workspace;
static bool hash(void *ctx,const void *p,size_t n,uint8_t out[32]){(void)ctx;return SHA256(p,n,out)!=NULL;}
static size_t read_file(const char *path,char out[8192]){FILE *f=fopen(path,"rb");assert(f);size_t n=fread(out,1,8191,f);assert(!ferror(f)&&feof(f));fclose(f);out[n]=0;return n;}
int main(int argc,char **argv){
 assert(argc==8);char caps[8192],response[8192],reply[1024];size_t cn=read_file(argv[1],caps),rn=read_file(argv[2],response);
 cp_v3_time_t t={60000,1793318460000ULL,1,10};
 cp_v3_control_result_t initialized=cp_v3_control_init(&control,&workspace,"synthetic-node","11111111-1111-4111-8111-111111111111",caps,cn,t,hash,NULL);
 if(!atoi(argv[3])){assert(initialized!=CP_V3_CONTROL_OK);return 0;}
 assert(initialized==CP_V3_CONTROL_OK&&control.capability_online_scope_rebind==(atoi(argv[6])!=0)&&control.capability_online_renewal==(atoi(argv[7])!=0));
 const char *body;size_t bytes;assert(cp_v3_control_registration(&control,1,t.mono_ms,&body,&bytes)==CP_V3_CONTROL_OK);
 int n=snprintf(reply,sizeof reply,"{\"protocol\":\"campuspulse/3\",\"node_id\":\"%s\",\"boot_id\":\"%s\",\"registration_seq\":1,\"capability_sha256\":\"%s\",\"registered_at\":\"2026-10-30T00:00:50.000Z\",\"applied\":false,\"capability_evidence\":\"device_claim\"}",control.node_id,control.boot_id,control.capability_sha256);
 assert(n>0&&cp_v3_control_registration_receipt(&control,reply,(size_t)n,t)==CP_V3_CONTROL_OK);saved=control;
 cp_v3_control_result_t result=cp_v3_control_offer(&control,response,rn,t);
 if(!strcmp(argv[4],"reject")){assert(result!=CP_V3_CONTROL_OK&&result!=CP_V3_CONTROL_WAIT);return 0;}
 if(!strcmp(argv[4],"wait")){assert(result==CP_V3_CONTROL_WAIT&&control.state==CP_V3_CONTROL_REGISTERED&&!control.policy_length&&!control.acknowledgement_length);}
 else {assert(result==CP_V3_CONTROL_OK&&!strcmp(control.policy.ruleset_version,argv[5]));}
 assert(!cp_v3_control_permissions(&control,t).collection&&!control.acknowledgement_length);
 // Same parser and negotiated descriptor rules are used by staged offers.
 if(!strcmp(argv[4],"ok")&&control.capability_online_scope_rebind){
  saved.policy=control.policy;saved.policy.scope.assignment_generation=0;saved.policy_length=control.policy_length;
  assert(cp_v3_control_stage(&saved,&candidate,response,rn,t)==CP_V3_CONTROL_OK);
  assert(candidate.policy.scope.assignment_generation==1&&!candidate.acknowledgement_length&&!cp_v3_control_permissions(&candidate,t).collection);
 }
 return 0;
}
