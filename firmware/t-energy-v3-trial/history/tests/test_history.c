#include "history_evidence.h"
#include "internal.h"
#include <assert.h>
#include <openssl/sha.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static te_history_workspace_t workspace;
static te_history_report_t report;
static char artifacts[8][8192];
static size_t lengths[8];
static int fault_kind=-1;
static te_history_load_t fault=TE_HISTORY_PRESENT;
static bool truncate,oversize;
static bool hash(void *ctx,const void *p,size_t n,uint8_t out[32]) {(void)ctx;return SHA256(p,n,out)!=NULL;}
static te_history_load_t load(void *ctx,te_history_artifact_t kind,unsigned index,void *out,size_t cap,size_t *length) {
    (void)ctx;unsigned slot=(unsigned)kind+(kind>=TE_HISTORY_LEASE_REQUEST?index*2:0);
    assert(slot<8);*length=0;
    if((int)kind==fault_kind&&fault!=TE_HISTORY_PRESENT)return fault;
    if(lengths[slot]>cap)return TE_HISTORY_CORRUPT;
    memcpy(out,artifacts[slot],lengths[slot]);*length=lengths[slot];
    if((int)kind==fault_kind&&truncate)--*length;
    if((int)kind==fault_kind&&oversize)*length=cap+1;
    return TE_HISTORY_PRESENT;
}
static cp_v3_time_t time_at(uint64_t offset,uint32_t uncertainty) {
    return (cp_v3_time_t){.mono_ms=1000+offset,.utc_ms=1793318400000ULL+offset,.clock_epoch=1,.uncertainty_ms=uncertainty};
}
static void inspect(const te_history_query_t *q) {
    te_history_source_t source={.load=load};
    te_history_inspect(&workspace,&source,q,hash,NULL,&report);
    assert((report.blockers&TE_HISTORY_RELEASE_BLOCKERS)==TE_HISTORY_RELEASE_BLOCKERS);
}
static void scope_from_policy(cp_v3_scope_t *scope) {
    /* Scope comes from exact server fixture, never current policy. */
    cp_v3_control_workspace_t *p=&workspace.parser;
    assert(v3_parse(p,artifacts[1],lengths[1]));
    int policy=v3_field(p,0,"policy"),custody=v3_field(p,policy,"custody"),control=v3_field(p,policy,"control"),activation=v3_field(p,control,"activation");
    assert(v3_string(p,v3_field(p,policy,"node_id"),scope->node_id,sizeof scope->node_id));
    assert(v3_string(p,v3_field(p,activation,"boot_id"),scope->boot_id,sizeof scope->boot_id));
    assert(v3_string(p,v3_field(p,policy,"policy_id"),scope->policy_id,sizeof scope->policy_id));
    assert(v3_string(p,v3_field(p,custody,"placement_id"),scope->placement_id,sizeof scope->placement_id));
    assert(v3_string(p,v3_field(p,custody,"dataset"),scope->dataset,sizeof scope->dataset));
    assert(v3_string(p,v3_field(p,0,"policy_sha256"),scope->policy_sha256,sizeof scope->policy_sha256));
    assert(v3_uint(p,v3_field(p,policy,"assignment_generation"),1,V3_SAFE,&scope->assignment_generation));
}
static void mutate(unsigned slot,const char *old,const char *replacement) {
    assert(strlen(old)==strlen(replacement));char *p=strstr(artifacts[slot],old);assert(p);memcpy(p,replacement,strlen(old));
}
static void read_artifact(unsigned slot,const char *path) {
    FILE *file=fopen(path,"rb");assert(file);
    memset(artifacts[slot],0,sizeof artifacts[slot]);
    lengths[slot]=fread(artifacts[slot],1,sizeof artifacts[slot]-1,file);assert(feof(file)&&!ferror(file));fclose(file);
}
int main(int argc,char **argv) {
    assert(argc==12);
    for(unsigned i=0;i<8;++i)read_artifact(i,argv[i+1]);
    te_history_query_t q={.observation_start=time_at(10000,10),.observation_end=time_at(70000,10),
        .upload_now=time_at(400000,10),.frozen_body_bytes=512,.lease_count=2};
    scope_from_policy(&q.original_scope);inspect(&q);
    assert(report.check==TE_HISTORY_STRUCTURE_MATCHED&&report.blockers==TE_HISTORY_RELEASE_BLOCKERS);
    assert(report.span_count==2&&report.spans[0].start_utc_ms==1793318400000ULL&&report.spans[0].end_utc_ms==1793318580000ULL);
    assert(report.original_daily_upload_limit==8388608&&report.original_accept_until_ms==1793325600000ULL);
    te_history_query_t changed=q;
    strcpy(changed.original_scope.placement_id,"other-place");inspect(&changed);assert(report.blockers&TE_HISTORY_SCOPE_MISMATCH);
    changed=q;++changed.original_scope.assignment_generation;inspect(&changed);assert(report.blockers&TE_HISTORY_SCOPE_MISMATCH);
    changed=q;changed.original_scope.boot_id[0]='2';inspect(&changed);assert(report.blockers&TE_HISTORY_BAD_CAPABILITY);
    changed=q;changed.original_scope.node_id[0]='x';inspect(&changed);assert(report.blockers&TE_HISTORY_BAD_CAPABILITY);
    changed=q;changed.original_scope.policy_sha256[0]=changed.original_scope.policy_sha256[0]=='0'?'1':'0';inspect(&changed);assert(report.blockers&TE_HISTORY_SCOPE_MISMATCH);
    changed=q;changed.original_scope.policy_id[0]='x';inspect(&changed);assert(report.blockers&TE_HISTORY_SCOPE_MISMATCH);
    changed=q;strcpy(changed.original_scope.dataset,"field");inspect(&changed);assert(report.blockers&TE_HISTORY_SCOPE_MISMATCH);
    changed=q;changed.observation_start.utc_ms=0;inspect(&changed);assert(report.blockers&TE_HISTORY_UNKNOWN_TIME);
    changed=q;changed.observation_start.uncertainty_ms=5001;inspect(&changed);assert(report.blockers&TE_HISTORY_UNKNOWN_TIME);
    changed=q;++changed.observation_end.clock_epoch;inspect(&changed);assert(report.blockers&TE_HISTORY_UNKNOWN_TIME);
    changed=q;changed.observation_start=time_at(0,1);inspect(&changed);assert(report.blockers&TE_HISTORY_OUTSIDE_AUTHORITY);
    changed=q;changed.observation_start=time_at(170000,10);changed.observation_end=time_at(250000,10);inspect(&changed);assert(report.blockers&TE_HISTORY_OUTSIDE_AUTHORITY);
    changed=q;changed.observation_start=time_at(250000,10);changed.observation_end=time_at(300000,10);inspect(&changed);assert(report.check==TE_HISTORY_STRUCTURE_MATCHED);
    changed=q;changed.observation_end=time_at(180000,1);inspect(&changed);assert(report.blockers&TE_HISTORY_OUTSIDE_AUTHORITY);
    changed=q;changed.observation_end=time_at(180000,0);inspect(&changed);assert(report.check==TE_HISTORY_STRUCTURE_MATCHED);
    changed=q;changed.upload_now=time_at(7200000,0);inspect(&changed);assert(report.blockers&TE_HISTORY_EXPIRED);
    changed=q;changed.upload_now=time_at(3670000,0);inspect(&changed);assert(report.blockers&TE_HISTORY_EXPIRED);
    changed=q;changed.upload_now=time_at(86400000,10);inspect(&changed);assert(report.blockers&TE_HISTORY_UPLOAD_DAY_AMBIGUOUS);
    changed=q;changed.frozen_body_bytes=2049;inspect(&changed);assert(report.blockers&TE_HISTORY_BODY_LIMIT);
    changed=q;changed.lease_count=TE_HISTORY_MAX_LEASES+1;inspect(&changed);assert(report.blockers&TE_HISTORY_BAD_INPUT);
    changed=q;changed.lease_count=0;changed.observation_end=time_at(130000,0);inspect(&changed);assert(report.blockers&TE_HISTORY_OUTSIDE_AUTHORITY);
    for(int kind=0;kind<=5;++kind){fault_kind=kind;fault=TE_HISTORY_ABSENT;inspect(&q);assert(report.blockers&TE_HISTORY_MISSING_ARTIFACT);
        fault=TE_HISTORY_IO;inspect(&q);assert(report.blockers&TE_HISTORY_STORAGE_FAILURE);
        fault=TE_HISTORY_CORRUPT;inspect(&q);assert(report.blockers&TE_HISTORY_STORAGE_FAILURE);
        fault=TE_HISTORY_PRESENT;truncate=true;inspect(&q);assert(report.check==TE_HISTORY_NOT_CHECKED);truncate=false;
        oversize=true;inspect(&q);assert(report.blockers&TE_HISTORY_STORAGE_FAILURE);oversize=false;
    }
    fault_kind=-1;
    mutate(3,"committed","Xommitted");inspect(&q);assert(report.blockers&TE_HISTORY_BAD_APPLIED_RECEIPT);mutate(3,"Xommitted","committed");
    mutate(5,"\"span_seq\":1","\"span_seq\":2");inspect(&q);assert(report.blockers&TE_HISTORY_BAD_LEASE_CHAIN);mutate(5,"\"span_seq\":2","\"span_seq\":1");
    mutate(7,"\"span_seq\":2","\"span_seq\":3");inspect(&q);assert(report.blockers&TE_HISTORY_BAD_LEASE_CHAIN);mutate(7,"\"span_seq\":3","\"span_seq\":2");
    mutate(1,"\"max_upload_bytes_per_day\":8388608","\"max_upload_bytes_per_day\":8388609");inspect(&q);assert(report.blockers&TE_HISTORY_BAD_POLICY);
    mutate(1,"\"max_upload_bytes_per_day\":8388609","\"max_upload_bytes_per_day\":8388608");
    inspect(&q);assert(report.check==TE_HISTORY_STRUCTURE_MATCHED);
    read_artifact(1,argv[9]);read_artifact(2,argv[10]);read_artifact(3,argv[11]);
    changed=q;scope_from_policy(&changed.original_scope);changed.lease_count=0;
    changed.observation_start=time_at(250000,10);changed.observation_end=time_at(300000,10);
    inspect(&changed);
    /* The real shared matcher accepts this exact failed ACK, yet it is never
     * promoted into a successful historical applied record. */
    assert(report.control_result==CP_V3_CONTROL_OK&&report.blockers&TE_HISTORY_BAD_APPLIED_RECEIPT);
    printf("history: real backend artifacts, scope/time/gap/expiry/corruption checks passed; all release blockers retained; workspace=%zu bytes\n",sizeof workspace);
    return 0;
}
