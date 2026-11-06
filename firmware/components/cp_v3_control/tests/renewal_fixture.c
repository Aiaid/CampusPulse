#include "cp_v3_control.h"
#include <assert.h>
#include <openssl/sha.h>
#include <stdio.h>
#include <string.h>
#include <time.h>

static cp_v3_control_t active,candidate,original,staged,offered,clock_saved,clock_expected;
static cp_v3_control_workspace_t workspace,other_workspace;
static unsigned apply_calls,checkpoint_calls;
static bool checkpoint_ok;
static cp_v3_apply_result_t apply_result=CP_V3_APPLY_OK;
static const char *checkpoint_body;
static size_t checkpoint_bytes;
static bool hash(void *ctx,const void *p,size_t n,uint8_t out[32]){(void)ctx;return SHA256(p,n,out)!=NULL;}
static cp_v3_time_t now(uint64_t offset,uint32_t epoch){return(cp_v3_time_t){60000+offset,1793318460000ULL+offset,epoch,10};}
static void timestamp(uint64_t utc,char out[25]){time_t sec=(time_t)(utc/1000);struct tm *t=gmtime(&sec);assert(t);assert(strftime(out,25,"%Y-%m-%dT%H:%M:%S",t)==19);snprintf(out+19,6,".%03uZ",(unsigned)(utc%1000));}
static size_t read_file(const char *path,char out[8192]){FILE *f=fopen(path,"rb");assert(f);size_t n=fread(out,1,8191,f);assert(!ferror(f)&&feof(f));fclose(f);out[n]=0;return n;}
static cp_v3_apply_result_t apply(void *ctx,const cp_v3_trial_policy_t *p,cp_v3_boundary_t *b){(void)ctx;assert(p->statistics&&!b->window_open&&!b->segment_open);apply_calls++;return apply_result;}
static bool checkpoint(void *ctx,const cp_v3_scope_t *scope,const void *body,size_t bytes){(void)ctx;checkpoint_calls++;assert(scope->assignment_generation==1&&bytes==checkpoint_bytes&&!memcmp(body,checkpoint_body,bytes));return checkpoint_ok;}
static size_t registration_reply(const cp_v3_control_t *c,char out[4096],cp_v3_time_t t){char at[25];timestamp(t.utc_ms,at);int n=snprintf(out,4096,"{\"protocol\":\"campuspulse/3\",\"node_id\":\"%s\",\"boot_id\":\"%s\",\"registration_seq\":%u,\"capability_sha256\":\"%s\",\"registered_at\":\"%s\",\"applied\":false,\"capability_evidence\":\"device_claim\"}",c->node_id,c->boot_id,c->registration_seq,c->capability_sha256,at);assert(n>0&&n<4096);return(size_t)n;}
static size_t ack_reply(const cp_v3_control_t *c,char out[4096],cp_v3_time_t t){size_t bytes;const char *body=cp_v3_control_ack_bytes(c,&bytes);assert(body&&bytes);uint8_t digest[32];char sha[65],at[25];assert(hash(NULL,body,bytes,digest));for(unsigned i=0;i<32;i++)snprintf(sha+i*2,3,"%02x",digest[i]);timestamp(t.utc_ms,at);memcpy(out,body,bytes-1);
 int n=snprintf(out+bytes-1,4096-bytes+1,",\"node_id\":\"%s\",\"received_at\":\"%s\",\"body_sha256\":\"%s\",\"durability\":\"committed\",\"evidence\":\"device_ack\"",c->node_id,at,sha);assert(n>0);bytes+=n-1;
 n=c->apply_result==CP_V3_APPLY_OK?snprintf(out+bytes,4096-bytes,",\"server_time\":\"%s\",\"lease_until_ms\":%llu,\"contact_seq\":0}",at,(unsigned long long)(t.utc_ms+120000)):snprintf(out+bytes,4096-bytes,"}");assert(n>0);return bytes+(size_t)n;}
static void mutate(char *out,const char *source,const char *needle){strcpy(out,source);char *p=strstr(out,needle);assert(p);p[strlen(needle)]=(p[strlen(needle)]=='a'?'b':'a');}
static void clock_change(cp_v3_control_t *c,cp_v3_time_t t,cp_v3_boundary_t b){
 clock_saved=*c;assert(cp_v3_control_clock_boundary(c,t,b)==CP_V3_CONTROL_OK);clock_expected=clock_saved;
 clock_expected.clock_epoch=t.clock_epoch;clock_expected.last_mono_ms=t.mono_ms;clock_expected.trusted_utc_lower_ms=t.utc_ms-t.uncertainty_ms;
 if(clock_saved.applied_at_utc_ms){assert(c->deadline_mono_ms<=clock_saved.deadline_mono_ms);clock_expected.deadline_mono_ms=c->deadline_mono_ms;}
 if(clock_saved.state==CP_V3_CONTROL_APPLIED&&(t.mono_ms>=c->deadline_mono_ms||t.utc_ms+t.uncertainty_ms>=c->deadline_utc_ms))clock_expected.state=CP_V3_CONTROL_PAUSED;
 assert(!memcmp(c,&clock_expected,sizeof *c));
}
static void clock_reject(cp_v3_control_t *c,cp_v3_time_t t,cp_v3_boundary_t b){
 clock_expected=*c;if(c->state==CP_V3_CONTROL_APPLIED)clock_expected.state=CP_V3_CONTROL_PAUSED;
 assert(cp_v3_control_clock_boundary(c,t,b)==CP_V3_CONTROL_BOUNDARY&&!memcmp(c,&clock_expected,sizeof *c));
}
int main(int argc,char **argv){
 assert(argc==5);char caps[8192],response[8192],fresh[8192],next[8192],reply[4096],wrong[8192],frozen[8192],old_ack[4096],old_lease[2048];
 size_t cn=read_file(argv[1],caps),rn=read_file(argv[2],response),fn=read_file(argv[3],fresh),nn=read_file(argv[4],next),bytes,n;
 const char *body;cp_v3_boundary_t boundary={.closed_window_seq=2,.closed_segment_seq=1};
 assert(cp_v3_control_init(&active,&workspace,"synthetic-node","11111111-1111-4111-8111-111111111111",caps,cn,now(0,1),hash,NULL)==CP_V3_CONTROL_OK);
 assert(cp_v3_control_registration(&active,1,60000,&body,&bytes)==CP_V3_CONTROL_OK);n=registration_reply(&active,reply,now(0,1));
 assert(cp_v3_control_registration_receipt(&active,reply,n,now(0,1))==CP_V3_CONTROL_OK);
 assert(cp_v3_control_offer(&active,response,rn,now(0,1))==CP_V3_CONTROL_OK);
 assert(cp_v3_control_apply(&active,now(0,1),boundary,1,apply,NULL)==CP_V3_CONTROL_OK);n=ack_reply(&active,old_ack,now(0,1));
 assert(cp_v3_control_ack_receipt(&active,old_ack,n,now(0,1))==CP_V3_CONTROL_OK);
 assert(cp_v3_control_permissions(&active,now(100,1)).collection);original=active;

 // Staging is pure with respect to active and requires a stopped boundary.
 cp_v3_boundary_t bad=boundary;bad.window_open=true;
 assert(cp_v3_control_stage_capabilities(&active,&candidate,fresh,fn,now(1000,2),bad)==CP_V3_CONTROL_BOUNDARY);
 bad=boundary;bad.closed_segment_seq=0;
 assert(cp_v3_control_stage_capabilities(&active,&candidate,fresh,fn,now(1000,2),bad)==CP_V3_CONTROL_BOUNDARY);
 cp_v3_time_t back=now(1000,2);back.mono_ms=1;
 assert(cp_v3_control_stage_capabilities(&active,&candidate,fresh,fn,back,boundary)==CP_V3_CONTROL_BOUNDARY);
 back=now(1000,2);back.utc_ms-=10000;
 assert(cp_v3_control_stage_capabilities(&active,&candidate,fresh,fn,back,boundary)==CP_V3_CONTROL_BOUNDARY);
 active.clock_epoch=3;assert(cp_v3_control_stage_capabilities(&active,&candidate,fresh,fn,now(1000,2),boundary)==CP_V3_CONTROL_BOUNDARY);active=original;
 active.state=CP_V3_CONTROL_ACK_PENDING;assert(cp_v3_control_stage_capabilities(&active,&candidate,fresh,fn,now(1000,2),boundary)==CP_V3_CONTROL_STATE);active=original;
 active.registration_seq=UINT32_MAX;assert(cp_v3_control_stage_capabilities(&active,&candidate,fresh,fn,now(1000,2),boundary)==CP_V3_CONTROL_STATE);active=original;
 assert(cp_v3_control_stage_capabilities(&active,&candidate,caps,cn,now(1000,2),boundary)==CP_V3_CONTROL_BINDING_MISMATCH);
 mutate(wrong,fresh,"\"node_id\": \"");assert(cp_v3_control_stage_capabilities(&active,&candidate,wrong,strlen(wrong),now(1000,2),boundary)!=CP_V3_CONTROL_OK);
 mutate(wrong,fresh,"\"boot_id\": \"");assert(cp_v3_control_stage_capabilities(&active,&candidate,wrong,strlen(wrong),now(1000,2),boundary)!=CP_V3_CONTROL_OK);
 assert(cp_v3_control_stage_capabilities(&active,&candidate,fresh,fn,now(1000,2),boundary)==CP_V3_CONTROL_OK);
 assert(!memcmp(&active,&original,sizeof active)&&candidate.workspace==active.workspace&&candidate.clock_epoch==2&&candidate.apply_seq==1&&candidate.last_applied_generation==1);
 assert(cp_v3_control_renewal_registration(&candidate,&body,&bytes)==CP_V3_CONTROL_OK);memcpy(frozen,body,bytes);staged=candidate;
 assert(candidate.registration_seq==2&&candidate.registered_uptime_ms==61000);
 assert(cp_v3_control_stage_capabilities(&active,&candidate,fresh,fn,now(2000,2),boundary)==CP_V3_CONTROL_STATE);
 assert(cp_v3_control_registration(&candidate,3,61000,&body,&n)==CP_V3_CONTROL_STATE);
 assert(cp_v3_control_registration(&candidate,2,61001,&body,&n)==CP_V3_CONTROL_STATE);
 assert(cp_v3_control_registration(&candidate,2,61000,&body,&n)==CP_V3_CONTROL_OK&&n==bytes&&!memcmp(body,frozen,bytes));
 assert(cp_v3_control_offer(&candidate,next,nn,now(1000,2))==CP_V3_CONTROL_STATE);
 unsigned before=apply_calls;
 assert(cp_v3_control_activate_renewal(&active,&candidate,now(1000,2),boundary,2,apply,NULL)!=CP_V3_CONTROL_OK&&apply_calls==before);
 n=registration_reply(&candidate,reply,now(1000,2));
 const char *needles[]={"\"node_id\":\"","\"boot_id\":\"","\"capability_sha256\":\"","\"registration_seq\":"};
 for(unsigned i=0;i<4;i++){candidate=staged;mutate(wrong,reply,needles[i]);if(i==3)strstr(wrong,needles[i])[strlen(needles[i])]='3';assert(cp_v3_control_registration_receipt(&candidate,wrong,strlen(wrong),now(1000,2))!=CP_V3_CONTROL_OK&&!candidate.renewal_registered);}
 candidate=staged;assert(cp_v3_control_registration_receipt(&candidate,reply,n,now(1000,1))==CP_V3_CONTROL_STATE);
 assert(cp_v3_control_registration_receipt(&candidate,reply,n,now(1000,2))==CP_V3_CONTROL_OK&&candidate.renewal_registered);
 assert(cp_v3_control_registration_receipt(&candidate,reply,n,now(1001,2))==CP_V3_CONTROL_OK);
 assert(cp_v3_control_renewal_registration(&candidate,&body,&n)==CP_V3_CONTROL_OK&&n==bytes&&!memcmp(body,frozen,bytes));
 assert(cp_v3_control_offer(&candidate,response,rn,now(1001,2))!=CP_V3_CONTROL_OK);
 assert(cp_v3_control_offer(&candidate,next,nn,now(1001,2))==CP_V3_CONTROL_OK);offered=candidate;

 // Re-probe after an outage preserves every in-flight registration and ACK
 // byte, including its origin guards. Rejected maps are rollback-only for
 // pending states. The same original frozen receipt is still required.
 candidate=staged;
 clock_reject(&candidate,now(1000,2),boundary);
 back=now(1000,3);back.mono_ms=1;clock_reject(&candidate,back,boundary);
 back=now(1000,3);back.utc_ms-=10000;clock_reject(&candidate,back,boundary);
 bad=boundary;bad.window_open=true;clock_reject(&candidate,now(1002,3),bad);
 clock_change(&candidate,now(1002,3),boundary);
 assert(candidate.state==CP_V3_CONTROL_REGISTERING&&cp_v3_control_renewal_registration(&candidate,&body,&n)==CP_V3_CONTROL_OK&&n==bytes&&!memcmp(body,frozen,bytes));
 n=registration_reply(&candidate,reply,now(1000,2));
 assert(cp_v3_control_registration_receipt(&candidate,reply,n,now(1002,3))==CP_V3_CONTROL_OK);
 clock_reject(&candidate,now(1002,3),boundary);clock_change(&candidate,now(1003,4),boundary);
 assert(candidate.state==CP_V3_CONTROL_REGISTERED&&cp_v3_control_renewal_registration(&candidate,&body,&n)==CP_V3_CONTROL_OK&&n==bytes&&!memcmp(body,frozen,bytes));
 assert(cp_v3_control_offer(&candidate,next,nn,now(1003,4))==CP_V3_CONTROL_OK);
 clock_reject(&candidate,now(1003,4),boundary);clock_change(&candidate,now(1004,5),boundary);
 active=original;clock_change(&active,now(1004,5),boundary);
 assert(cp_v3_control_activate_renewal(&active,&candidate,now(1004,5),boundary,2,apply,NULL)==CP_V3_CONTROL_OK);
 assert(active.state==CP_V3_CONTROL_ACK_PENDING);body=cp_v3_control_ack_bytes(&active,&n);memcpy(wrong,body,n);size_t ack_bytes=n;
 clock_reject(&active,now(1004,5),boundary);clock_change(&active,now(1005,6),boundary);
 body=cp_v3_control_ack_bytes(&active,&n);assert(n==ack_bytes&&!memcmp(body,wrong,n)&&active.state==CP_V3_CONTROL_ACK_PENDING&&!cp_v3_control_permissions(&active,now(1005,6)).collection);
 n=ack_reply(&active,reply,now(1005,6));assert(cp_v3_control_ack_receipt(&active,reply,n,now(1005,6))==CP_V3_CONTROL_OK&&cp_v3_control_permissions(&active,now(1105,6)).collection);
 // Explicitly exercise retained old applied metadata in a pending state: the
 // boundary must not turn its in-flight ACK into PAUSED or APPLIED.
 active.state=CP_V3_CONTROL_ACK_PENDING;clock_change(&active,now(1106,7),boundary);assert(active.state==CP_V3_CONTROL_ACK_PENDING);
 active=original;clock_change(&active,now(180000,2),boundary);assert(active.state==CP_V3_CONTROL_PAUSED);
 clock_change(&active,now(180001,3),boundary);assert(active.state==CP_V3_CONTROL_PAUSED);
 active=original;clock_reject(&active,now(1000,1),boundary);assert(active.state==CP_V3_CONTROL_PAUSED);
 // Clock recovery cannot repair an expired capability; retain its immutable
 // registration while refusing an offer instead of inventing a new sequence.
 candidate=staged;clock_change(&candidate,now(7200000,3),boundary);n=registration_reply(&candidate,reply,now(1000,2));
 assert(cp_v3_control_registration_receipt(&candidate,reply,n,now(7200000,3))==CP_V3_CONTROL_OK);
 assert(cp_v3_control_offer(&candidate,next,nn,now(7200000,3))==CP_V3_CONTROL_NOT_CURRENT);
 assert(candidate.registration_seq==2&&!candidate.policy_length&&!candidate.acknowledgement_length);
 before=apply_calls;

 // No stale old snapshot, new digest, changed workspace, sequence or epoch.
 for(unsigned test=0;test<12;test++){
  active=original;candidate=offered;
  switch(test){case 0:active.capability_sha256[0]^=1;break;case 1:active.policy.scope.policy_sha256[0]^=1;break;
   case 2:active.registration_seq++;break;case 3:active.apply_seq++;break;case 4:active.policy.scope.assignment_generation++;break;
   case 5:candidate.workspace=&other_workspace;break;case 6:candidate.renewal_registered=false;break;
   case 7:strcpy(candidate.capability_sha256,active.capability_sha256);break;case 8:candidate.registration_seq++;break;
   case 9:candidate.boot_id[0]='2';break;case 10:active.lease_pending=true;break;case 11:candidate.capability_sha256[0]^=1;break;}
  assert(cp_v3_control_activate_renewal(&active,&candidate,now(1001,2),boundary,2,apply,NULL)!=CP_V3_CONTROL_OK&&apply_calls==before);
 }
 active=original;candidate=offered;
 assert(cp_v3_control_activate_staged(&active,&candidate,now(1001,2),boundary,2,apply,NULL)!=CP_V3_CONTROL_OK);
 assert(cp_v3_control_activate_renewal(&active,&candidate,now(1001,1),boundary,2,apply,NULL)==CP_V3_CONTROL_BOUNDARY);
 assert(cp_v3_control_activate_renewal(&active,&candidate,now(1000,2),boundary,2,apply,NULL)==CP_V3_CONTROL_BOUNDARY);
 assert(cp_v3_control_activate_renewal(&active,&candidate,now(1001,2),bad,2,apply,NULL)==CP_V3_CONTROL_BOUNDARY);
 assert(cp_v3_control_activate_renewal(&active,&candidate,now(1001,2),boundary,1,apply,NULL)!=CP_V3_CONTROL_OK);
 assert(cp_v3_control_activate_renewal(&active,&candidate,now(1001,2),boundary,2,apply,NULL)==CP_V3_CONTROL_OK&&apply_calls==before+1);
 assert(active.state==CP_V3_CONTROL_ACK_PENDING&&active.registration_seq==2&&active.policy.scope.assignment_generation==2&&candidate.state==CP_V3_CONTROL_EMPTY);
 assert(!cp_v3_control_permissions(&active,now(1001,2)).collection);
 assert(cp_v3_control_ack_receipt(&active,old_ack,strlen(old_ack),now(1001,2))!=CP_V3_CONTROL_OK);
 n=ack_reply(&active,reply,now(1001,2));assert(cp_v3_control_ack_receipt(&active,reply,n,now(1001,2))==CP_V3_CONTROL_OK);
 assert(cp_v3_control_permissions(&active,now(1101,2)).collection);
 // A real failed application freezes a failed ACK and grants no collection.
 active=original;candidate=offered;apply_result=CP_V3_APPLY_STORAGE_FAILED;
 assert(cp_v3_control_activate_renewal(&active,&candidate,now(1001,2),boundary,2,apply,NULL)==CP_V3_CONTROL_OK);
 n=ack_reply(&active,reply,now(1001,2));assert(cp_v3_control_ack_receipt(&active,reply,n,now(1001,2))==CP_V3_CONTROL_OK);
 assert(active.state==CP_V3_CONTROL_FAILED&&active.last_applied_generation==1&&!cp_v3_control_permissions(&active,now(1101,2)).collection);

 // A lost lease response can be detached only after exact durable checkpoint.
 active=original;assert(cp_v3_control_lease_request(&active,1,61000,&body,&bytes)==CP_V3_CONTROL_OK);memcpy(old_lease,body,bytes);checkpoint_body=old_lease;checkpoint_bytes=bytes;
 cp_v3_control_clear(&candidate);assert(cp_v3_control_stage_capabilities(&active,&candidate,fresh,fn,now(1000,2),boundary)==CP_V3_CONTROL_STATE);
 assert(cp_v3_control_detach_lease_at_boundary(&active,bad,checkpoint,NULL)==CP_V3_CONTROL_BOUNDARY&&!checkpoint_calls);
 assert(cp_v3_control_detach_lease_at_boundary(&active,boundary,checkpoint,NULL)==CP_V3_CONTROL_RESOURCE&&active.lease_pending);
 checkpoint_ok=true;uint64_t old_deadline=active.deadline_mono_ms;
 assert(cp_v3_control_detach_lease_at_boundary(&active,boundary,checkpoint,NULL)==CP_V3_CONTROL_OK&&!active.lease_pending&&active.state==CP_V3_CONTROL_PAUSED);
 assert(active.deadline_mono_ms==old_deadline&&active.lease_length==bytes&&!memcmp(active.lease_json,old_lease,bytes));
 assert(cp_v3_control_lease_receipt(&active,"{}",2,now(1000,1))==CP_V3_CONTROL_STATE);
 assert(cp_v3_control_lease_request(&active,1,61000,&body,&n)==CP_V3_CONTROL_STATE);
 assert(cp_v3_control_stage_capabilities(&active,&candidate,fresh,fn,now(1000,2),boundary)==CP_V3_CONTROL_OK);
 puts("renewal: exact registration, trusted boundary, old/new bindings, fresh ACK and durable lease detach passed");return 0;
}
