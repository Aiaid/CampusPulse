#include "cp_v3_control.h"
#include <assert.h>
#include <openssl/sha.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
static cp_v3_control_t control,candidate,saved;
static cp_v3_control_workspace_t workspace;
static cp_v3_apply_result_t outcome;
static unsigned apply_calls;
static bool hash(void *ctx,const void *p,size_t n,uint8_t out[32]){(void)ctx;return SHA256(p,n,out)!=NULL;}
static void digest(const void *p,size_t n,char out[65]){uint8_t h[32];assert(hash(NULL,p,n,h));for(unsigned i=0;i<32;++i)snprintf(out+2*i,3,"%02x",h[i]);}
static cp_v3_time_t now(uint64_t offset){return(cp_v3_time_t){.mono_ms=60000+offset,.utc_ms=1793318460000ULL+offset,.clock_epoch=1,.uncertainty_ms=10};}
static void timestamp(uint64_t utc,char out[25]){time_t sec=(time_t)(utc/1000);struct tm *t=gmtime(&sec);assert(t);assert(strftime(out,25,"%Y-%m-%dT%H:%M:%S",t)==19);snprintf(out+19,6,".%03uZ",(unsigned)(utc%1000));}
static cp_v3_apply_result_t apply(void *ctx,const cp_v3_trial_policy_t *p,cp_v3_boundary_t *b){(void)ctx;(void)b;++apply_calls;
 assert(p->statistics&&p->stats_max_addresses>=256&&p->stats_max_addresses<=512&&p->evidence.max_identifiers==0&&p->evidence.max_evidence_bytes==0);
 assert(p->window_ms==30000||p->window_ms==60000);assert(p->bin_ms==5000&&p->max_body_bytes>=512&&p->window_reserve_items==1&&p->status_reserve_items==1);
 return outcome;}
static size_t read_file(const char *path,char out[CP_V3_CONTROL_JSON_MAX]){FILE *f=fopen(path,"rb");assert(f);size_t n=fread(out,1,CP_V3_CONTROL_JSON_MAX,f);assert(!ferror(f)&&feof(f));fclose(f);return n;}
static size_t ack_reply(char out[4096],bool applied){const char *body;size_t n;body=cp_v3_control_ack_bytes(&control,&n);char sha[65];digest(body,n,sha);memcpy(out,body,n-1);
 int extra=snprintf(out+n-1,4096-n+1,",\"node_id\":\"synthetic-node\",\"received_at\":\"2026-10-30T00:01:00.000Z\",\"body_sha256\":\"%s\",\"durability\":\"committed\",\"evidence\":\"device_ack\"%s}",sha,
 applied?",\"server_time\":\"2026-10-30T00:01:00.000Z\",\"lease_until_ms\":1793318580000,\"contact_seq\":0":"");assert(extra>0);return n-1+(size_t)extra;}
static size_t lease_reply(char out[4096],uint64_t offset,uint32_t span,bool contiguous){char sha[65],at[25];digest(control.lease_json,control.lease_length,sha);timestamp(now(offset).utc_ms,at);
 int n=snprintf(out,4096,"{\"protocol\":\"campuspulse/3\",\"schema\":\"device-lease/3\",\"node_id\":\"synthetic-node\",\"boot_id\":\"%s\",\"policy_id\":\"%s\",\"policy_sha256\":\"%s\",\"assignment_generation\":1,\"contact_seq\":%u,\"uptime_ms\":%llu,\"body_sha256\":\"%s\",\"durability\":\"committed\",\"server_time\":\"%s\",\"lease_until_ms\":%llu,\"span_seq\":%u,\"contiguous\":%s}",
 control.boot_id,control.policy.scope.policy_id,control.policy.scope.policy_sha256,(unsigned)control.pending_contact_seq,(unsigned long long)control.pending_uptime_ms,sha,at,(unsigned long long)(now(offset).utc_ms+120000),(unsigned)span,contiguous?"true":"false");assert(n>0);return(size_t)n;}
int main(int argc,char **argv){assert(argc==8);char caps[8192],response[8192],next[8192],reply[4096],lease[4096],wrong[4096];size_t cn=read_file(argv[2],caps),rn=read_file(argv[3],response);
 assert(cp_v3_control_init(&control,&workspace,"synthetic-node","11111111-1111-4111-8111-111111111111",caps,cn,now(0),hash,NULL)==CP_V3_CONTROL_OK);assert(control.small_statistics&&!strcmp(control.capability_sha256,argv[4]));
 const char *body;size_t bodylen;assert(cp_v3_control_registration(&control,1,60000,&body,&bodylen)==CP_V3_CONTROL_OK);
 int reg=snprintf(reply,sizeof reply,"{\"protocol\":\"campuspulse/3\",\"node_id\":\"synthetic-node\",\"boot_id\":\"%s\",\"registration_seq\":1,\"capability_sha256\":\"%s\",\"registered_at\":\"2026-10-30T00:00:50.000Z\",\"applied\":false,\"capability_evidence\":\"device_claim\"}",control.boot_id,control.capability_sha256);
 assert(cp_v3_control_registration_receipt(&control,reply,(size_t)reg,now(0))==CP_V3_CONTROL_OK);
 cp_v3_control_result_t offered=cp_v3_control_offer(&control,response,rn,now(0));if(!strcmp(argv[1],"reject")){assert(offered!=CP_V3_CONTROL_OK&&!apply_calls);return 0;}
 assert(offered==CP_V3_CONTROL_OK&&!strcmp(control.policy.scope.policy_sha256,argv[5]));saved=control;cp_v3_boundary_t b={0};
 outcome=CP_V3_APPLY_STORAGE_FAILED;assert(cp_v3_control_apply(&control,now(0),b,1,apply,NULL)==CP_V3_CONTROL_OK);size_t length=ack_reply(reply,false);
 assert(cp_v3_control_ack_receipt(&control,reply,length,now(0))==CP_V3_CONTROL_OK&&control.state==CP_V3_CONTROL_FAILED);assert(!cp_v3_control_permissions(&control,now(0)).collection);
 control=saved;outcome=CP_V3_APPLY_OK;assert(cp_v3_control_apply(&control,now(0),b,1,apply,NULL)==CP_V3_CONTROL_OK);length=ack_reply(reply,true);
 memcpy(wrong,reply,length+1);char *sha=strstr(wrong,"body_sha256");assert(sha);sha[14]=sha[14]=='0'?'1':'0';
 assert(cp_v3_control_ack_receipt(&control,wrong,length,now(0))!=CP_V3_CONTROL_OK);assert(cp_v3_control_ack_receipt(&control,reply,length,now(0))==CP_V3_CONTROL_OK);
 uint64_t start_guard=((uint64_t)control.policy.window_ms+1999)/2000+1;
 uint64_t ready=now(0).uncertainty_ms+start_guard;
 cp_v3_control_permissions_t waiting=cp_v3_control_permissions(&control,now(ready-1));
 assert(!waiting.collection&&waiting.reason==CP_V3_CONTROL_WAIT);
 assert(cp_v3_control_permissions(&control,now(ready)).collection);
 uint64_t first_end=now(ready).utc_ms-1+control.policy.window_ms;
 assert(first_end-now(ready).uncertainty_ms-(start_guard-1)-control.policy.window_ms>=control.capture_span_start_utc_ms);
 uint64_t ack_horizon=control.deadline_mono_ms-now(0).mono_ms;
 assert(now(0).utc_ms+now(0).uncertainty_ms+ack_horizon+(ack_horizon+1999)/2000<control.deadline_utc_ms);saved=control;
 assert(cp_v3_control_lease_request(&control,1,120000,&body,&bodylen)==CP_V3_CONTROL_OK);char frozen[2048];memcpy(frozen,body,bodylen);
 const char *again;size_t againlen;assert(cp_v3_control_lease_request(&control,1,120000,&again,&againlen)==CP_V3_CONTROL_OK&&againlen==bodylen&&!memcmp(frozen,again,bodylen));
 assert(cp_v3_control_lease_request(&control,2,120000,&again,&againlen)==CP_V3_CONTROL_STATE);
 size_t ll=lease_reply(lease,60000,1,true);assert(cp_v3_control_lease_receipt(&control,lease,ll,now(60000))==CP_V3_CONTROL_OK);uint64_t deadline=control.deadline_mono_ms;
 uint64_t lease_horizon=deadline-now(60000).mono_ms;
 assert(now(60000).utc_ms+now(60000).uncertainty_ms+lease_horizon+(lease_horizon+1999)/2000<control.deadline_utc_ms);
 assert(cp_v3_control_ack_receipt(&control,reply,length,now(60000))==CP_V3_CONTROL_OK&&control.deadline_mono_ms==deadline);
 assert(cp_v3_control_lease_receipt(&control,lease,ll,now(60001))==CP_V3_CONTROL_OK&&control.deadline_mono_ms==deadline);
 assert(cp_v3_control_permissions(&control,now(60001)).collection); /* Continuous span does not wait again. */
 cp_v3_control_permissions_t permission=cp_v3_control_permissions(&control,now(180000));assert(!permission.collection&&permission.uplink&&permission.frozen_only&&control.state==CP_V3_CONTROL_PAUSED);
 assert(cp_v3_control_lease_receipt(&control,lease,ll,now(180001))==CP_V3_CONTROL_OK&&control.state==CP_V3_CONTROL_PAUSED&&control.deadline_mono_ms==deadline);
 assert(cp_v3_control_match_frozen_receipt(&workspace,&control.policy.scope,control.acknowledgement_json,control.acknowledgement_length,reply,length,hash,NULL)==CP_V3_CONTROL_OK&&control.state==CP_V3_CONTROL_PAUSED);
 assert(cp_v3_control_lease_request(&control,2,300000,&body,&bodylen)==CP_V3_CONTROL_OK);ll=lease_reply(lease,240000,2,false);
 assert(cp_v3_control_lease_receipt(&control,lease,ll,now(240000))==CP_V3_CONTROL_OK&&control.capture_span_start_utc_ms==now(240000).utc_ms&&!control.lease_contiguous);
 waiting=cp_v3_control_permissions(&control,now(240000+ready-1));
 assert(!waiting.collection&&waiting.reason==CP_V3_CONTROL_WAIT);
 assert(cp_v3_control_permissions(&control,now(240000+ready)).collection);
 uint64_t resumed_end=now(240000+ready).utc_ms-1+control.policy.window_ms;
 assert(resumed_end-now(240000+ready).uncertainty_ms-(start_guard-1)-control.policy.window_ms>=control.capture_span_start_utc_ms);
 cp_v3_time_t changed=now(240000+ready+10);changed.clock_epoch=2;uint64_t utc_deadline=control.deadline_utc_ms;
 assert(cp_v3_control_clock_boundary(&control,changed,b)==CP_V3_CONTROL_OK&&control.deadline_utc_ms==utc_deadline&&control.clock_epoch==2);
 assert(cp_v3_control_clock_boundary(&control,changed,b)==CP_V3_CONTROL_BOUNDARY&&control.state==CP_V3_CONTROL_PAUSED);
 control=saved;size_t nn=read_file(argv[6],next);assert(cp_v3_control_offer(&control,next,nn,now(ready))==CP_V3_CONTROL_STATE);
 assert(cp_v3_control_stage(&control,&candidate,next,nn,now(ready))==CP_V3_CONTROL_OK&&control.policy.scope.assignment_generation==1&&candidate.policy.scope.assignment_generation==2);
 b.window_open=true;assert(cp_v3_control_activate_staged(&control,&candidate,now(ready),b,2,apply,NULL)==CP_V3_CONTROL_BOUNDARY&&control.policy.scope.assignment_generation==1);
 b.window_open=false;assert(cp_v3_control_activate_staged(&control,&candidate,now(ready),b,2,apply,NULL)==CP_V3_CONTROL_OK&&control.state==CP_V3_CONTROL_ACK_PENDING&&control.policy.scope.assignment_generation==2);
 assert(!cp_v3_control_permissions(&control,now(ready)).collection);
 control=saved;assert(cp_v3_control_stage(&control,&candidate,next,nn,now(ready))==CP_V3_CONTROL_OK);outcome=CP_V3_APPLY_STORAGE_FAILED;
 assert(cp_v3_control_activate_staged(&control,&candidate,now(ready),b,2,apply,NULL)==CP_V3_CONTROL_OK);length=ack_reply(reply,false);
 assert(cp_v3_control_ack_receipt(&control,reply,length,now(ready))==CP_V3_CONTROL_OK&&control.state==CP_V3_CONTROL_FAILED&&control.last_applied_generation==1);
 nn=read_file(argv[7],next);assert(cp_v3_control_stage(&control,&candidate,next,nn,now(ready))==CP_V3_CONTROL_OK&&candidate.policy.scope.assignment_generation==3);
 outcome=CP_V3_APPLY_OK;assert(cp_v3_control_activate_staged(&control,&candidate,now(ready),b,3,apply,NULL)==CP_V3_CONTROL_OK&&control.policy.scope.assignment_generation==3&&!cp_v3_control_permissions(&control,now(ready)).collection);
 puts("small control: capacity, exact ACK/lease, replay, gap, frozen drain and staged boundary passed");return 0;}
