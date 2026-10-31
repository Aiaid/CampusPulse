#include "legacy_scanstats_maintenance.h"
#include "nvs_flash.h"
#include <string.h>

static esp_err_t metadata(nvs_handle_t h,te_legacy_maintenance_report_t *r,bool writing){
    nvs_type_t type;
    r->stage=writing?TE_LEGACY_STAGE_WRITE_TYPE:TE_LEGACY_STAGE_READONLY_TYPE;
    esp_err_t e=nvs_find_key(h,TE_LEGACY_SCANSTATS_KEY,&type);
    if(e!=ESP_OK)return e;
    if(type!=NVS_TYPE_BLOB)return ESP_ERR_NVS_TYPE_MISMATCH;
    r->stage=writing?TE_LEGACY_STAGE_WRITE_LENGTH:TE_LEGACY_STAGE_READONLY_LENGTH;
    size_t bytes=0;e=nvs_get_blob(h,TE_LEGACY_SCANSTATS_KEY,NULL,&bytes);
    if(e!=ESP_OK)return e;
    r->blob_bytes=bytes;
    return bytes==TE_LEGACY_SCANSTATS_BYTES?ESP_OK:ESP_ERR_INVALID_SIZE;
}
static bool absent(te_legacy_maintenance_report_t *r){
    nvs_handle_t h;r->stage=TE_LEGACY_STAGE_VERIFY_OPEN;
    esp_err_t e=nvs_open(TE_LEGACY_SCANSTATS_NAMESPACE,NVS_READONLY,&h);
    /* erase_key does not delete the namespace. Its disappearance is unexpected. */
    if(e!=ESP_OK){r->error=e;return false;}
    r->stage=TE_LEGACY_STAGE_VERIFY_ABSENT;nvs_type_t type;
    e=nvs_find_key(h,TE_LEGACY_SCANSTATS_KEY,&type);
    size_t bytes=0;esp_err_t value=nvs_get_blob(h,TE_LEGACY_SCANSTATS_KEY,NULL,&bytes);
    nvs_close(h);
    if(e!=ESP_ERR_NVS_NOT_FOUND||value!=ESP_ERR_NVS_NOT_FOUND){
        r->error=e!=ESP_ERR_NVS_NOT_FOUND?e:value;
        if(r->error==ESP_OK)r->error=ESP_FAIL;
        return false;
    }
    r->absent_verified=true;return true;
}
te_legacy_maintenance_result_t te_legacy_scanstats_clear(te_legacy_maintenance_report_t *r){
    if(!r)return TE_LEGACY_MAINT_REJECTED;
    memset(r,0,sizeof *r);r->result=TE_LEGACY_MAINT_REJECTED;r->stage=TE_LEGACY_STAGE_INIT;
    r->error=nvs_flash_init();if(r->error!=ESP_OK)return r->result;
    r->stage=TE_LEGACY_STAGE_STATS_BEFORE;r->error=nvs_get_stats(NULL,&r->before);
    if(r->error!=ESP_OK)return r->result;
    r->before_known=true;
    nvs_handle_t h;r->stage=TE_LEGACY_STAGE_READONLY_OPEN;
    r->error=nvs_open(TE_LEGACY_SCANSTATS_NAMESPACE,NVS_READONLY,&h);
    if(r->error==ESP_ERR_NVS_NOT_FOUND){r->result=TE_LEGACY_MAINT_ALREADY_ABSENT;goto finish;}
    if(r->error!=ESP_OK)return r->result;
    r->error=metadata(h,r,false);nvs_close(h);
    if(r->error==ESP_ERR_NVS_NOT_FOUND){r->result=TE_LEGACY_MAINT_ALREADY_ABSENT;goto finish;}
    if(r->error!=ESP_OK)return r->result;
    r->stage=TE_LEGACY_STAGE_WRITE_OPEN;r->error=nvs_open(TE_LEGACY_SCANSTATS_NAMESPACE,NVS_READWRITE,&h);
    if(r->error!=ESP_OK)return r->result;
    r->error=metadata(h,r,true);
    if(r->error!=ESP_OK){nvs_close(h);return r->result;}
    r->stage=TE_LEGACY_STAGE_ERASE_KEY;r->erase_attempted=true;
    r->error=nvs_erase_key(h,TE_LEGACY_SCANSTATS_KEY);
    if(r->error!=ESP_OK){nvs_close(h);r->result=TE_LEGACY_MAINT_UNCERTAIN;goto finish;}
    r->stage=TE_LEGACY_STAGE_COMMIT;r->error=nvs_commit(h);nvs_close(h);
    if(r->error!=ESP_OK){r->result=TE_LEGACY_MAINT_UNCERTAIN;goto finish;}
    r->commit_ok=true;
    if(!absent(r)){r->result=TE_LEGACY_MAINT_UNCERTAIN;goto finish;}
    r->result=TE_LEGACY_MAINT_CLEARED;
finish: {
        /* Preserve the original uncertainty/error stage; never retry deletion. */
        te_legacy_maintenance_stage_t stage=r->stage;esp_err_t prior=r->error;
        esp_err_t stats=nvs_get_stats(NULL,&r->after);r->after_known=stats==ESP_OK;
        if(stats!=ESP_OK){r->error=stats;r->stage=TE_LEGACY_STAGE_STATS_AFTER;
            if(r->erase_attempted)r->result=TE_LEGACY_MAINT_UNCERTAIN;else r->result=TE_LEGACY_MAINT_REJECTED;
        }else if(r->result==TE_LEGACY_MAINT_CLEARED||r->result==TE_LEGACY_MAINT_ALREADY_ABSENT){
            r->stage=TE_LEGACY_STAGE_DONE;r->error=ESP_OK;
        }else {r->stage=stage;r->error=prior;}
    }
    return r->result;
}
