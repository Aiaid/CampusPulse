#include "cp_settings.h"
#include "nvs.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
typedef struct { bool have_slot[2],have_active,have_proof; uint8_t active; cp_settings_t slot[2]; char proof[33]; } db_t;
static db_t saved,pending;
static int operation,fail_at,entropy_enabled,random_calls;
static bool fail(void) { return fail_at && ++operation==fail_at; }
esp_err_t nvs_flash_init(void) { return fail()?ESP_FAIL:ESP_OK; }
esp_err_t nvs_open(const char *name,int mode,nvs_handle_t *h)
{ assert(!strcmp(name,"cp_settings")); (void)mode; if (fail()) return ESP_FAIL; pending=saved; *h=1; return ESP_OK; }
void nvs_close(nvs_handle_t h) { assert(h==1); pending=saved; }
esp_err_t nvs_get_u8(nvs_handle_t h,const char *k,uint8_t *v)
{ (void)h; assert(!strcmp(k,"active")); if(fail())return ESP_FAIL; if(!pending.have_active)return ESP_ERR_NVS_NOT_FOUND; *v=pending.active;return ESP_OK; }
esp_err_t nvs_set_u8(nvs_handle_t h,const char *k,uint8_t v)
{ (void)h; assert(!strcmp(k,"active")); if(fail())return ESP_FAIL;pending.active=v;pending.have_active=true;return ESP_OK; }
static unsigned slot_index(const char *k) { assert(!strcmp(k,"settings_a")||!strcmp(k,"settings_b")); return k[9]=='b'; }
esp_err_t nvs_get_blob(nvs_handle_t h,const char *k,void *v,size_t *n)
{ (void)h;unsigned i=slot_index(k); if(fail())return ESP_FAIL;if(!pending.have_slot[i])return ESP_ERR_NVS_NOT_FOUND; assert(*n>=sizeof(cp_settings_t));*n=sizeof(cp_settings_t);memcpy(v,&pending.slot[i],*n);return ESP_OK; }
esp_err_t nvs_set_blob(nvs_handle_t h,const char *k,const void *v,size_t n)
{ (void)h;unsigned i=slot_index(k);if(fail())return ESP_FAIL; assert(n==sizeof(cp_settings_t));memcpy(&pending.slot[i],v,n);pending.have_slot[i]=true;return ESP_OK; }
esp_err_t nvs_get_str(nvs_handle_t h,const char *k,char *out,size_t *n)
{ (void)h;assert(!strcmp(k,"setup_proof"));if(fail())return ESP_FAIL;if(!pending.have_proof)return ESP_ERR_NVS_NOT_FOUND;assert(*n>=33);memcpy(out,pending.proof,33);*n=33;return ESP_OK; }
esp_err_t nvs_set_str(nvs_handle_t h,const char *k,const char *v)
{ (void)h;assert(!strcmp(k,"setup_proof"));if(fail())return ESP_FAIL;strcpy(pending.proof,v);pending.have_proof=true;return ESP_OK; }
esp_err_t nvs_commit(nvs_handle_t h) { (void)h;if(fail())return ESP_FAIL;saved=pending;return ESP_OK; }
void bootloader_random_enable(void) { assert(!entropy_enabled);entropy_enabled=1; }
void bootloader_random_disable(void) { assert(entropy_enabled);entropy_enabled=0; }
void esp_fill_random(void *p,size_t n) { assert(entropy_enabled);++random_calls;memset(p,0xab,n); }
static cp_settings_t good(void)
{ cp_settings_t s={.version=1};strcpy(s.node_id,"cp_aabbccddeeff");strcpy(s.ssid,"synthetic-test-ap");strcpy(s.password,"test-only-pass");memset(s.device_token,'x',40);strcpy(s.api_origin,CP_API_ORIGIN);return s; }
int main(void)
{
    cp_settings_t s=good(),out;
    assert(cp_settings_validate(&s));
    cp_settings_t bad=s;strcpy(bad.api_origin,"https://evil.invalid");assert(!cp_settings_validate(&bad));
    bad=s;strcpy(bad.password,"short");assert(!cp_settings_validate(&bad));
    bad=s;memset(bad.ssid,'s',sizeof(bad.ssid));assert(!cp_settings_validate(&bad));
    bad=s;bad.device_token[8]='\n';assert(!cp_settings_validate(&bad));
    bad=s;bad.node_id[4]='A';assert(!cp_settings_validate(&bad));
    bad=s;memset(bad.password,'g',64);assert(!cp_settings_validate(&bad));
    bad=s;memset(bad.password,'a',64);assert(cp_settings_validate(&bad));
    assert(cp_settings_load(&out)==ESP_ERR_NOT_FOUND);
    assert(cp_settings_save(&s)==ESP_OK);
    assert(cp_settings_load(&out)==ESP_OK&&!memcmp(&s,&out,sizeof(s)));
    db_t baseline=saved;
    cp_settings_t candidate=s;strcpy(candidate.ssid,"replacement-test-ap");
    for(int n=1;n<=6;++n) {
        saved=baseline;operation=0;fail_at=n;
        assert(cp_settings_save(&candidate)!=ESP_OK);
        fail_at=0;
        assert(cp_settings_load(&out)==ESP_OK&&!memcmp(&s,&out,sizeof(s)));
    }
    assert(cp_settings_save(&candidate)==ESP_OK);
    assert(cp_settings_load(&out)==ESP_OK&&!memcmp(&candidate,&out,sizeof(candidate)));
    saved.active=9;assert(cp_settings_load(&out)==ESP_ERR_INVALID_STATE);
    for(size_t i=0;i<sizeof(out);++i)assert(((unsigned char *)&out)[i]==0);
    saved=baseline;char proof[33],again[33];
    assert(cp_settings_setup_proof(proof)==ESP_OK&&strlen(proof)==32&&random_calls==1);
    assert(cp_settings_setup_proof(again)==ESP_OK&&!strcmp(proof,again)&&random_calls==1);
    operation=0;fail_at=2;assert(cp_settings_setup_proof(again)==ESP_FAIL&&again[0]==0&&random_calls==1);fail_at=0;
    saved.proof[0]='z';assert(cp_settings_setup_proof(again)==ESP_ERR_INVALID_STATE&&random_calls==1);
    cp_settings_clear_sensitive(&s);for(size_t i=0;i<sizeof(s);++i)assert(((unsigned char *)&s)[i]==0);
    puts("settings: validation, atomic slot faults, secret proof and zeroing passed");
}
