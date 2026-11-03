#include "cp_v3_transport.h"
#include "mbedtls/x509_crt.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
static char *load(const char *path) {
    FILE *f=fopen(path,"rb");assert(f);assert(!fseek(f,0,SEEK_END));long n=ftell(f);assert(n>0&&n<8192);rewind(f);
    char *p=calloc(1,(size_t)n+1);assert(p&&fread(p,1,(size_t)n,f)==(size_t)n&&!fclose(f));return p;
}
static int verify(const char *ca,const char *leaf,const char *domain,uint32_t *flags) {
    mbedtls_x509_crt root,peer;mbedtls_x509_crt_init(&root);mbedtls_x509_crt_init(&peer);
    assert(!mbedtls_x509_crt_parse(&root,(const unsigned char *)ca,strlen(ca)+1));
    assert(!mbedtls_x509_crt_parse(&peer,(const unsigned char *)leaf,strlen(leaf)+1));
    int result=mbedtls_x509_crt_verify(&peer,&root,NULL,domain,flags,NULL,NULL);
    mbedtls_x509_crt_free(&peer);mbedtls_x509_crt_free(&root);return result;
}
int main(int argc,char **argv) {
    assert(argc==10);char *ca=load(argv[1]),*leaf=load(argv[2]),*wrong=load(argv[3]),*expired=load(argv[4]),*future=load(argv[5]);
    char *expired_ca=load(argv[6]),*expired_ca_leaf=load(argv[7]),*future_ca=load(argv[8]),*bad_usage=load(argv[9]);
    assert(cp_v3_ca_validate(ca)&&!cp_v3_ca_validate(NULL)&&!cp_v3_ca_validate(""));
    assert(!cp_v3_ca_validate(leaf)&&!cp_v3_ca_validate(bad_usage));
    char doubled[8192];int n=snprintf(doubled,sizeof doubled,"%s%s",ca,ca);assert(n>0&&(size_t)n<sizeof doubled);assert(!cp_v3_ca_validate(doubled));
    n=snprintf(doubled,sizeof doubled,"prefix\n%s",ca);assert(n>0&&(size_t)n<sizeof doubled);assert(!cp_v3_ca_validate(doubled));
    memset(doubled,'A',4097);doubled[4097]=0;assert(!cp_v3_ca_validate(doubled));
    const char *valid[]={"radius","radius.synthetic.invalid","RADIUS.Example","a-b.local"};
    for(size_t i=0;i<sizeof valid/sizeof *valid;i++)assert(cp_v3_eap_validate(ca,valid[i]));
    const char *invalid[]={NULL,"","1.2.3.4","127.1","123","::1","https://radius.invalid","*.example.invalid","-a.test","a-.test","a..test","a.test.","a.test;b.test","a test","a\n.test"};
    for(size_t i=0;i<sizeof invalid/sizeof *invalid;i++)assert(!cp_v3_eap_validate(ca,invalid[i]));
    char label[65];memset(label,'a',64);label[64]=0;assert(!cp_v3_eap_domain_validate(label));
    cp_settings_t s={.version=CP_SETTINGS_VERSION};strcpy(s.node_id,"cp_001122334455");strcpy(s.api_origin,CP_API_ORIGIN);strcpy(s.ssid,"Synthetic WiFi");memset(s.device_token,'x',40);
    s.wifi_security=CP_WIFI_OPEN;assert(cp_v3_wifi_validate(&s,NULL,NULL));assert(!cp_v3_wifi_validate(&s,ca,NULL));
    s.wifi_security=CP_WIFI_PERSONAL;strcpy(s.password,"synthetic-pass");assert(cp_v3_wifi_validate(&s,NULL,NULL));assert(!cp_v3_wifi_validate(&s,NULL,"radius"));
    s.wifi_security=CP_WIFI_ENTERPRISE_PEAP;s.password[0]=0;strcpy(s.eap_username,"synthetic-user");strcpy(s.eap_identity,"synthetic-outer");strcpy(s.eap_password,"synthetic-eap-pass");
    assert(cp_v3_wifi_validate(&s,ca,"radius.synthetic.invalid"));assert(!cp_v3_wifi_validate(&s,NULL,"radius"));assert(!cp_v3_wifi_validate(&s,ca,NULL));
    uint32_t flags=0;assert(!verify(ca,leaf,"radius.synthetic.invalid",&flags)&&!flags);
    assert(verify(wrong,leaf,"radius.synthetic.invalid",&flags)&&flags);
    assert(verify(ca,leaf,"different.synthetic.invalid",&flags)&&(flags&MBEDTLS_X509_BADCERT_CN_MISMATCH));
    assert(verify(ca,expired,"radius.synthetic.invalid",&flags)&&(flags&MBEDTLS_X509_BADCERT_EXPIRED));
    assert(verify(ca,future,"radius.synthetic.invalid",&flags)&&(flags&MBEDTLS_X509_BADCERT_FUTURE));
    assert(verify(expired_ca,expired_ca_leaf,"radius.synthetic.invalid",&flags)&&(flags&MBEDTLS_X509_BADCERT_EXPIRED));
    assert(verify(future_ca,leaf,"radius.synthetic.invalid",&flags)&&(flags&MBEDTLS_X509_BADCERT_FUTURE));
    free(ca);free(leaf);free(wrong);free(expired);free(future);free(expired_ca);free(expired_ca_leaf);free(future_ca);free(bad_usage);
    puts("Wi-Fi mode/CA/domain preflight and real mbedTLS chain/name/time negatives passed; no PEAP radio-handshake claim");
}
