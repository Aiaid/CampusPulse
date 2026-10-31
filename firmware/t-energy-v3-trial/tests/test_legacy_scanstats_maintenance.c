/* Real maintenance C source; SDK substitutes reject every namespace/key other
 * than the one explicitly authorized. No stored values are needed or printed. */
#include "legacy_scanstats_maintenance.h"
#include "nvs_flash.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
static bool present,ns_present,opened,erase_error,erase_error_after_change,commit_error,stale_readback;
static bool contradictory_blob_readback,contradictory_key_readback;
static bool fail_init,fail_before_stats,fail_after_stats,fail_readback_open,mutate_type_on_rw,mutate_length_on_rw;
static nvs_type_t type;
static size_t length;
static unsigned opens,readonly_opens,write_opens,erases,commits,closes,stats_calls,blob_queries,initializations;
static int mode;
static te_legacy_maintenance_report_t report;
/* These represent the explicitly protected namespaces/queue. No API provided
 * below can address them, and their sentinel bytes must remain unchanged. */
static unsigned char protected_state[5][32],protected_before[5][32];
static void key(const char *name){assert(!strcmp(name,"devs"));}
esp_err_t nvs_flash_init(void){initializations++;return fail_init?ESP_FAIL:ESP_OK;}
esp_err_t nvs_get_stats(const char *partition,nvs_stats_t *out){
    assert(partition==NULL);stats_calls++;
    if((stats_calls==1&&fail_before_stats)||(stats_calls>1&&fail_after_stats))return ESP_FAIL;
    *out=(nvs_stats_t){.total_entries=756,.namespace_count=7,.used_entries=present?596:206,
        .free_entries=present?160:550,.available_entries=present?34:424};return ESP_OK;
}
esp_err_t nvs_open(const char *name,int requested,nvs_handle_t *out){
    assert(!strcmp(name,"scanstats"));assert(!opened);opens++;
    assert(requested==NVS_READONLY||requested==NVS_READWRITE);
    if(!ns_present){assert(requested==NVS_READONLY);return ESP_ERR_NVS_NOT_FOUND;}
    if(requested==NVS_READONLY){readonly_opens++;if(readonly_opens>1&&fail_readback_open)return ESP_FAIL;}
    else {write_opens++;if(mutate_type_on_rw)type=NVS_TYPE_U32;if(mutate_length_on_rw)length--;}
    mode=requested;opened=true;*out=37;return ESP_OK;
}
esp_err_t nvs_find_key(nvs_handle_t h,const char *name,nvs_type_t *out){
    assert(opened&&h==37);key(name);
    if(!present&&!((stale_readback||contradictory_key_readback)&&readonly_opens>1))return ESP_ERR_NVS_NOT_FOUND;
    *out=type;return ESP_OK;
}
esp_err_t nvs_get_blob(nvs_handle_t h,const char *name,void *out,size_t *bytes){
    assert(opened&&h==37);key(name);assert(out==NULL);blob_queries++;
    if(!present&&!((stale_readback||contradictory_blob_readback)&&readonly_opens>1))return ESP_ERR_NVS_NOT_FOUND;
    if(type!=NVS_TYPE_BLOB)return ESP_ERR_NVS_TYPE_MISMATCH;
    *bytes=length;return ESP_OK;
}
esp_err_t nvs_erase_key(nvs_handle_t h,const char *name){
    assert(opened&&h==37&&mode==NVS_READWRITE);key(name);assert(++erases==1);
    assert(present&&type==NVS_TYPE_BLOB&&length==12300);
    assert(readonly_opens==1&&write_opens==1&&blob_queries==2);
    if(erase_error){if(erase_error_after_change)present=false;return ESP_FAIL;}
    present=false;return ESP_OK;
}
esp_err_t nvs_commit(nvs_handle_t h){
    assert(opened&&h==37&&mode==NVS_READWRITE&&erases==1);assert(++commits==1);
    return commit_error?ESP_FAIL:ESP_OK;
}
void nvs_close(nvs_handle_t h){assert(opened&&h==37);opened=false;closes++;}
static void unchanged(void){assert(!opened);assert(!memcmp(protected_state,protected_before,sizeof protected_state));}
static void reset(void){
    present=ns_present=true;opened=false;erase_error=erase_error_after_change=commit_error=stale_readback=false;
    contradictory_blob_readback=contradictory_key_readback=false;
    fail_init=fail_before_stats=fail_after_stats=fail_readback_open=mutate_type_on_rw=mutate_length_on_rw=false;
    type=NVS_TYPE_BLOB;length=12300;
    opens=readonly_opens=write_opens=erases=commits=closes=stats_calls=blob_queries=initializations=0;
    memset(protected_state,0xa5,sizeof protected_state);memcpy(protected_before,protected_state,sizeof protected_state);
}
static void rejected_without_write(void){
    assert(te_legacy_scanstats_clear(&report)==TE_LEGACY_MAINT_REJECTED);
    assert(!erases&&!commits&&!report.erase_attempted);unchanged();
}
int main(void){
    reset();assert(te_legacy_scanstats_clear(NULL)==TE_LEGACY_MAINT_REJECTED);assert(!initializations);
    reset();fail_init=true;rejected_without_write();assert(!opens&&!stats_calls);
    reset();fail_before_stats=true;rejected_without_write();assert(!opens);
    reset();type=NVS_TYPE_U32;rejected_without_write();assert(!write_opens&&!blob_queries);
    const size_t bad_lengths[]={0,1,12299,12301,24576};
    for(unsigned i=0;i<sizeof bad_lengths/sizeof *bad_lengths;i++){reset();length=bad_lengths[i];rejected_without_write();assert(!write_opens);}
    reset();mutate_type_on_rw=true;rejected_without_write();assert(write_opens==1);
    reset();mutate_length_on_rw=true;rejected_without_write();assert(write_opens==1);
    reset();ns_present=false;assert(te_legacy_scanstats_clear(&report)==TE_LEGACY_MAINT_ALREADY_ABSENT);assert(!erases&&!write_opens);unchanged();
    reset();present=false;assert(te_legacy_scanstats_clear(&report)==TE_LEGACY_MAINT_ALREADY_ABSENT);assert(!erases&&!write_opens);unchanged();
    reset();assert(te_legacy_scanstats_clear(&report)==TE_LEGACY_MAINT_CLEARED);
    assert(initializations==1&&erases==1&&commits==1&&readonly_opens==2&&write_opens==1&&closes==3);
    assert(report.before_known&&report.after_known&&report.before.available_entries==34&&report.after.available_entries==424);
    assert(report.blob_bytes==12300&&report.commit_ok&&report.absent_verified&&report.stage==TE_LEGACY_STAGE_DONE);unchanged();
    /* A repeat boot reports absence, not a second deletion. */
    unsigned old_erases=erases,old_commits=commits;
    assert(te_legacy_scanstats_clear(&report)==TE_LEGACY_MAINT_ALREADY_ABSENT);
    assert(erases==old_erases&&commits==old_commits&&!report.erase_attempted&&!report.commit_ok);unchanged();
    reset();erase_error=true;assert(te_legacy_scanstats_clear(&report)==TE_LEGACY_MAINT_UNCERTAIN);assert(erases==1&&!commits);unchanged();
    reset();erase_error=erase_error_after_change=true;assert(te_legacy_scanstats_clear(&report)==TE_LEGACY_MAINT_UNCERTAIN);assert(!present&&erases==1&&!commits);unchanged();
    reset();commit_error=true;assert(te_legacy_scanstats_clear(&report)==TE_LEGACY_MAINT_UNCERTAIN);
    assert(!present&&erases==1&&commits==1&&!report.commit_ok&&!report.absent_verified);unchanged();
    reset();stale_readback=true;assert(te_legacy_scanstats_clear(&report)==TE_LEGACY_MAINT_UNCERTAIN);
    assert(report.commit_ok&&!report.absent_verified&&report.stage==TE_LEGACY_STAGE_VERIFY_ABSENT);unchanged();
    reset();fail_readback_open=true;assert(te_legacy_scanstats_clear(&report)==TE_LEGACY_MAINT_UNCERTAIN);unchanged();
    reset();contradictory_blob_readback=true;assert(te_legacy_scanstats_clear(&report)==TE_LEGACY_MAINT_UNCERTAIN);
    assert(report.commit_ok&&!report.absent_verified);unchanged();
    reset();contradictory_key_readback=true;assert(te_legacy_scanstats_clear(&report)==TE_LEGACY_MAINT_UNCERTAIN);
    assert(report.commit_ok&&!report.absent_verified);unchanged();
    reset();fail_after_stats=true;assert(te_legacy_scanstats_clear(&report)==TE_LEGACY_MAINT_UNCERTAIN);
    assert(report.commit_ok&&report.absent_verified&&!report.after_known);unchanged();
    puts("legacy maintenance: only scanstats/devs, exact type/12300-byte guards, one erase+commit, NOT_FOUND, idempotency and uncertain failures passed");
}
