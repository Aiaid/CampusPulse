/* Compiled ONLY for the explicit single-key maintenance image. No V3, BLE,
 * Wi-Fi, provisioning, transport, queue or statistics-upload source is linked. */
#include "legacy_scanstats_maintenance.h"
#include "esp_partition.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include <stdio.h>

#if !CONFIG_TE_SMALL_CLEAR_LEGACY_SCANSTATS
#error "Maintenance entry must never be compiled into a normal image"
#endif
#if CONFIG_TE_SMALL_TEST_HOLD_FIRST_COMMIT
#error "Maintenance and checkpoint images are mutually exclusive"
#endif
static const char *TAG="te-key-maint";
static void stats(const char *phase,const nvs_stats_t *s){
    ESP_LOGI(TAG,"nvs_%s used=%u free=%u available=%u total=%u namespaces=%u",phase,
        (unsigned)s->used_entries,(unsigned)s->free_entries,(unsigned)s->available_entries,
        (unsigned)s->total_entries,(unsigned)s->namespace_count);
}
void app_main(void){
    const esp_partition_t *p=esp_partition_find_first(ESP_PARTITION_TYPE_DATA,ESP_PARTITION_SUBTYPE_DATA_NVS,"nvs");
    if(!p||p->address!=0x9000||p->size!=0x6000){
        ESP_LOGE(TAG,"maintenance_rejected=nvs_geometry no_key_operation=1");
    }else{
        te_legacy_maintenance_report_t r;
        te_legacy_maintenance_result_t result=te_legacy_scanstats_clear(&r);
        if(r.before_known)stats("before",&r.before);
        ESP_LOGI(TAG,"target_namespace=scanstats target_key=devs target_type=blob expected_bytes=%u observed_bytes=%u",
            TE_LEGACY_SCANSTATS_BYTES,(unsigned)r.blob_bytes);
        if(r.after_known)stats("after",&r.after);
        ESP_LOGI(TAG,"maintenance_result=%u stage=%u error=%ld erase_attempted=%u commit_ok=%u key_absent_verified=%u",
            (unsigned)result,(unsigned)r.stage,(long)r.error,r.erase_attempted,r.commit_ok,r.absent_verified);
        if(result==TE_LEGACY_MAINT_ALREADY_ABSENT)ESP_LOGI(TAG,"already_absent=1 deletion_this_run=0");
    }
    puts("MAINTENANCE USB SAFE STANDBY no_network=1 no_collection=1 restart_requires_operator=1");
    fflush(stdout);
    /* Never auto-reboot into another owner or release the power supply. */
    for(;;)vTaskDelay(pdMS_TO_TICKS(1000));
}
