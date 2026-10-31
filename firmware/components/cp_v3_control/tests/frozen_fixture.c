#include "../internal.h"
#include <assert.h>
#include <openssl/sha.h>
#include <stdio.h>
#include <string.h>
static cp_v3_control_workspace_t workspace;
static bool hash(void *ctx,const void *p,size_t n,uint8_t out[32]){(void)ctx;return SHA256(p,n,out)!=NULL;}
static size_t read_file(const char *path,char out[8192]){FILE *f=fopen(path,"rb");assert(f);size_t n=fread(out,1,8192,f);assert(!ferror(f)&&feof(f)&&n<8192);fclose(f);out[n]=0;return n;}
int main(int argc,char **argv){assert(argc==3);char body[8192],reply[8192],changed[8192];size_t bn=read_file(argv[1],body),rn=read_file(argv[2],reply);cp_v3_scope_t scope={0};
 assert(v3_parse(&workspace,body,bn));strcpy(scope.node_id,"synthetic-stats-notregister");
 assert(v3_string(&workspace,v3_field(&workspace,0,"boot_id"),scope.boot_id,sizeof scope.boot_id));
 assert(v3_string(&workspace,v3_field(&workspace,0,"policy_id"),scope.policy_id,sizeof scope.policy_id));
 assert(v3_string(&workspace,v3_field(&workspace,0,"policy_sha256"),scope.policy_sha256,sizeof scope.policy_sha256));
 assert(v3_uint(&workspace,v3_field(&workspace,0,"assignment_generation"),1,V3_SAFE,&scope.assignment_generation));
 assert(cp_v3_control_match_frozen_receipt(&workspace,&scope,body,bn,reply,rn,hash,NULL)==CP_V3_CONTROL_OK);
 body[bn]=' ';assert(cp_v3_control_match_frozen_receipt(&workspace,&scope,body,bn+1,reply,rn,hash,NULL)==CP_V3_CONTROL_BINDING_MISMATCH);
 memcpy(changed,reply,rn+1);char *p=strstr(changed,"committed");assert(p);*p='X';assert(cp_v3_control_match_frozen_receipt(&workspace,&scope,body,bn,changed,rn,hash,NULL)!=CP_V3_CONTROL_OK);
 ++scope.assignment_generation;assert(cp_v3_control_match_frozen_receipt(&workspace,&scope,body,bn,reply,rn,hash,NULL)!=CP_V3_CONTROL_OK);--scope.assignment_generation;
 memcpy(changed,reply,rn+1);p=strstr(changed,"body_sha256");assert(p);*p='X';assert(cp_v3_control_match_frozen_receipt(&workspace,&scope,body,bn,changed,rn,hash,NULL)!=CP_V3_CONTROL_OK);
 memcpy(changed,reply,rn+1);p=strstr(changed,"policy_sha256");assert(p);*p='X';assert(cp_v3_control_match_frozen_receipt(&workspace,&scope,body,bn,changed,rn,hash,NULL)!=CP_V3_CONTROL_OK);
 puts("exact synthetic backend control receipt matched; altered bytes/scope/receipt rejected");return 0;}
