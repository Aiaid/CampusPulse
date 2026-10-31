#include "cp_v3_budget_nvs.h"
#include "nvs.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
typedef struct {bool present;size_t length;uint8_t bytes[128];} blob_t;
static blob_t slots[2],pending;
static bool have_namespace;
static unsigned set_calls,commits,pending_slot;
static int fault;
static size_t available_entries=500;
static uint8_t unrelated_settings=0xa5;
static void reset(void){memset(slots,0,sizeof slots);memset(&pending,0,sizeof pending);have_namespace=false;set_calls=commits=0;fault=0;unrelated_settings=0xa5;available_entries=500;}
esp_err_t nvs_get_stats(const char *name,nvs_stats_t *out){assert(!name);memset(out,0,sizeof *out);out->available_entries=available_entries;out->free_entries=available_entries+128;return fault==9?ESP_FAIL:ESP_OK;}
esp_err_t nvs_open(const char *name,int mode,nvs_handle_t *out){assert(!strcmp(name,"cpv3budg"));if(!have_namespace&&mode==NVS_READONLY)return ESP_ERR_NVS_NOT_FOUND;have_namespace=true;*out=mode+1;return ESP_OK;}
void nvs_close(nvs_handle_t h){assert(h==1||h==2);}
static unsigned index_of(const char *key){assert(!strcmp(key,"a")||!strcmp(key,"b"));return !strcmp(key,"b");}
esp_err_t nvs_get_blob(nvs_handle_t h,const char *key,void *out,size_t *length){assert(h==1||h==2);if(fault==1||(fault==5&&commits))return ESP_FAIL;blob_t *b=&slots[index_of(key)];if(!b->present)return ESP_ERR_NVS_NOT_FOUND;if(!out){*length=b->length;return ESP_OK;}if(*length<b->length)return ESP_FAIL;memcpy(out,b->bytes,b->length);*length=b->length;return ESP_OK;}
esp_err_t nvs_set_blob(nvs_handle_t h,const char *key,const void *bytes,size_t length){assert(h==2&&length==96);set_calls++;if(fault==2||fault==8)return ESP_ERR_NVS_NOT_ENOUGH_SPACE;pending_slot=index_of(key);pending=(blob_t){.present=true,.length=length};memcpy(pending.bytes,bytes,length);if(fault==6)pending.bytes[80]^=1;return ESP_OK;}
esp_err_t nvs_commit(nvs_handle_t h){assert(h==2);commits++;if(fault==3)return ESP_FAIL;slots[pending_slot]=pending;return fault==4?ESP_FAIL:ESP_OK;}
static cp_v3_budget_record_t record(uint64_t sequence,uint32_t day,uint64_t reserved,uint8_t owner){cp_v3_budget_record_t r={.sequence=sequence,.utc_day=day,.reserved_bytes=reserved};r.owner_key[0]=owner;return r;}
static void put(unsigned slot,cp_v3_budget_record_t r){have_namespace=true;slots[slot].present=true;slots[slot].length=96;assert(cp_v3_budget_encode(&r,slots[slot].bytes));}
static void bad_pair(cp_v3_budget_record_t a,cp_v3_budget_record_t b){reset();put(0,a);put(1,b);cp_v3_budget_nvs_t provider;cp_v3_budget_store_t store;assert(cp_v3_budget_nvs_open(&provider,"cpv3budg",&store)==ESP_ERR_INVALID_RESPONSE);assert(!store.load&&!set_calls&&unrelated_settings==0xa5);}
int main(void){
    cp_v3_budget_nvs_t provider;cp_v3_budget_store_t store;cp_v3_budget_t core;uint8_t owner[32]={1};
    const uint64_t t=1704070800000ULL;
    reset();assert(cp_v3_budget_nvs_open(&provider,"cpv3budg",&store)==ESP_OK&&!have_namespace&&store.logical_write_bytes==4096);
    assert(cp_v3_budget_open(&core,store,owner)==CP_V3_BUDGET_OK);assert(cp_v3_budget_configure(&core,200000,65536)==CP_V3_BUDGET_OK);
    assert(cp_v3_budget_charge(&core,100,t-10,t+10)==CP_V3_BUDGET_OK&&set_calls==1&&slots[0].present&&!slots[1].present);
    assert(cp_v3_budget_charge(&core,100,t-10,t+10)==CP_V3_BUDGET_OK&&set_calls==1);
    cp_v3_budget_nvs_t reopened;cp_v3_budget_store_t again;assert(cp_v3_budget_nvs_open(&reopened,"cpv3budg",&again)==ESP_OK);
    assert(cp_v3_budget_open(&core,again,owner)==CP_V3_BUDGET_OK&&!core.credit_bytes&&core.record.reserved_bytes==69632);
    assert(cp_v3_budget_configure(&core,200000,65536)==CP_V3_BUDGET_OK);
    assert(cp_v3_budget_charge(&core,100,t-10,t+10)==CP_V3_BUDGET_OK&&set_calls==2&&slots[1].present&&core.record.sequence==2);
    assert(cp_v3_budget_charge(&core,100,t+86400000-10,t+86400000+10)==CP_V3_BUDGET_OK&&set_calls==3&&core.record.sequence==3&&core.record.reserved_bytes==69632);
    assert(unrelated_settings==0xa5);
    cp_v3_budget_record_t a=record(1,19723,10000,1),b=record(2,19723,20000,1);
    bad_pair(a,record(2,19723,9999,1));bad_pair(a,record(2,19723,10000,1));bad_pair(a,record(3,19723,20000,1));bad_pair(a,record(2,19724,20000,2));bad_pair(record(1,19724,10000,1),b);bad_pair(a,record(1,19723,20000,1));
    reset();put(0,a);put(1,a);assert(cp_v3_budget_nvs_open(&provider,"cpv3budg",&store)==ESP_OK);
    reset();put(0,a);slots[1]=(blob_t){.present=true,.length=1,.bytes={0}};assert(cp_v3_budget_nvs_open(&provider,"cpv3budg",&store)==ESP_ERR_INVALID_RESPONSE);
    reset();put(0,a);put(1,b);slots[1].bytes[95]^=1;assert(cp_v3_budget_nvs_open(&provider,"cpv3budg",&store)==ESP_ERR_INVALID_RESPONSE);
    reset();put(0,record(1,19723,0,1));assert(cp_v3_budget_nvs_open(&provider,"cpv3budg",&store)==ESP_ERR_INVALID_RESPONSE);
    reset();put(0,a);assert(cp_v3_budget_nvs_open(&provider,"cpv3budg",&store)==ESP_OK);uint8_t other[32]={2};assert(cp_v3_budget_open(&core,store,other)==CP_V3_BUDGET_OWNER_MISMATCH);
    for(int mode=2;mode<=8;mode++){if(mode==7)continue;reset();assert(cp_v3_budget_nvs_open(&provider,"cpv3budg",&store)==ESP_OK);assert(cp_v3_budget_open(&core,store,owner)==CP_V3_BUDGET_OK);assert(cp_v3_budget_configure(&core,200000,65536)==CP_V3_BUDGET_OK);fault=mode;
        assert(cp_v3_budget_charge(&core,100,t-10,t+10)==CP_V3_BUDGET_IO&&core.latched);
        assert(cp_v3_budget_charge(&core,1,t-10,t+10)==CP_V3_BUDGET_LATCHED&&set_calls==1&&unrelated_settings==0xa5);
        fault=0;
        if(mode==6){assert(cp_v3_budget_nvs_open(&reopened,"cpv3budg",&again)==ESP_ERR_INVALID_RESPONSE);}
        else {assert(cp_v3_budget_nvs_open(&reopened,"cpv3budg",&again)==ESP_OK);assert(cp_v3_budget_open(&core,again,owner)==CP_V3_BUDGET_OK);if(mode==4||mode==5)assert(core.record.reserved_bytes==69632&&!core.credit_bytes);}
    }
    reset();put(0,a);fault=1;assert(cp_v3_budget_nvs_open(&provider,"cpv3budg",&store)==ESP_FAIL&&!set_calls);
    for(unsigned i=0;i<2;i++){reset();assert(cp_v3_budget_nvs_open(&provider,"cpv3budg",&store)==ESP_OK);assert(cp_v3_budget_open(&core,store,owner)==CP_V3_BUDGET_OK);assert(cp_v3_budget_configure(&core,200000,65536)==CP_V3_BUDGET_OK);if(i)fault=9;else available_entries=135;assert(cp_v3_budget_charge(&core,100,t-10,t+10)==CP_V3_BUDGET_IO&&core.latched&&!set_calls&&!have_namespace);}
    assert(cp_v3_budget_nvs_open(&provider,"invalid/name",&store)==ESP_ERR_INVALID_ARG);
    puts("NVS budget provider: dual-slot integrity, fail-closed faults, reboot burn and exact readback passed");return 0;
}
