/* Synthetic stdin peer: executes the pinned SDK Security2/SRP/GCM C code.
 * No real credentials, hardware, network listeners or source vendoring. */
#include "cp_provision_security2.h"
#include "protocomm_security2.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
static unsigned failures;
static bool locked,expired,gate_busy;
static bool enter(void){return !locked&&!expired&&!gate_busy&&failures<5;}
static void leave(void){}
static void failure(void){failures++;}
static void fatal(void){locked=true;}
static int hex(const char *s,uint8_t *b,size_t cap){size_t n=strlen(s);while(n&&(s[n-1]=='\n'||s[n-1]=='\r'))n--;if(n%2||n/2>cap)return -1;for(size_t i=0;i<n/2;i++){unsigned v;if(sscanf(s+2*i,"%2x",&v)!=1)return -1;b[i]=(uint8_t)v;}return (int)n/2;}
void esp_fill_random(void *p,size_t n) {
    const char *fixed=getenv("CP_TEST_SRP_B");
    if(fixed&&n==32&&hex(fixed,p,n)==32)return;
    arc4random_buf(p,n);
}
int main(int argc,char **argv){
    if(argc!=3)return 2;
    uint8_t salt[16],verifier[384];if(hex(argv[2],salt,16)!=16||!cp_provision_sec2_verifier(argv[1],salt,verifier))return 3;
    protocomm_security2_params_t params={.salt=(const char *)salt,.salt_len=16,.verifier=(const char *)verifier,.verifier_len=384};
    cp_provision_security_hooks_t hooks={enter,leave,failure,fatal};const protocomm_security_t *security=cp_provision_security2(&hooks);
    protocomm_security_handle_t handle=NULL;if(security->init(&handle)!=ESP_OK||security->new_transport_session(handle,7)!=ESP_OK)return 4;
    char line[2200];uint8_t input[1024];
    while(fgets(line,sizeof line,stdin)){
        uint8_t *out=NULL;ssize_t outlen=0;int result=0,n=0;
        if(line[0]=='S'||line[0]=='D'||line[0]=='E')n=hex(line+2,input,sizeof input);
        if(n<0)result=ESP_ERR_INVALID_SIZE;
        else if(line[0]=='S')result=security->security_req_handler(handle,&params,7,input,n,&out,&outlen,NULL);
        else if(line[0]=='D')result=security->decrypt(handle,7,input,n,&out,&outlen);
        else if(line[0]=='E')result=security->encrypt(handle,7,input,n,&out,&outlen);
        else if(line[0]=='N'){security->close_transport_session(handle,7);result=security->new_transport_session(handle,7);}
        else if(line[0]=='X'){expired=true;result=0;}
        else if(line[0]=='G'){gate_busy=line[2]=='1';result=0;}
        else if(line[0]=='F'){unsigned command;result=cp_provision_sec2_frame(input,0,&command)?0:ESP_ERR_INVALID_ARG;}
        else result=ESP_ERR_INVALID_ARG;
        printf("%d %u ",result,failures);for(ssize_t i=0;i<outlen;i++)printf("%02x",out[i]);putchar('\n');fflush(stdout);free(out);
    }
    security->cleanup(handle);return 0;
}
