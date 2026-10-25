/*
 * CampusPulse board bring-up for LILYGO T-Energy-S3 V1.0.
 *
 * Scope: verify the three settings this board actually depends on (Octal PSRAM,
 * the custom partition layout, the console port) plus the battery ADC that the
 * vendor pin map defines. There is no BLE scan, no Wi-Fi upload and no queue
 * here, so a successful build says nothing about radio behaviour or whether the
 * node can collect observations.
 */

#include <inttypes.h>

#include "board.h"
#include "esp_chip_info.h"
#include "esp_flash.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_partition.h"
#include "esp_psram.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "sdkconfig.h"

static const char *TAG = "bringup";

static const char *psram_mode_name(void)
{
#ifdef CONFIG_SPIRAM_MODE_OCT
    return "octal";
#elif defined(CONFIG_SPIRAM_MODE_QUAD)
    return "quad";
#else
    return "disabled";
#endif
}

static void log_board_report(void)
{
    esp_chip_info_t chip = {0};
    esp_chip_info(&chip);
    ESP_LOGI(TAG, "target %s, %d core(s), silicon rev v%d.%d", CONFIG_IDF_TARGET, chip.cores,
             chip.revision / 100, chip.revision % 100);

    uint32_t flash_bytes = 0;
    if (esp_flash_get_size(NULL, &flash_bytes) == ESP_OK) {
        ESP_LOGI(TAG, "flash %lu MiB", (unsigned long)(flash_bytes / (1024U * 1024U)));
    } else {
        ESP_LOGW(TAG, "flash size unavailable");
    }

    bool psram_up = esp_psram_is_initialized();
    ESP_LOGI(TAG, "psram %s, mode %s, %lu bytes, %lu bytes in heap",
             psram_up ? "initialized" : "NOT initialized", psram_mode_name(),
             (unsigned long)(psram_up ? esp_psram_get_size() : 0U),
             (unsigned long)heap_caps_get_total_size(MALLOC_CAP_SPIRAM));
    if (!psram_up) {
        ESP_LOGE(TAG, "octal PSRAM did not come up; check CONFIG_SPIRAM_MODE_OCT");
    }

    const esp_partition_t *storage =
        esp_partition_find_first(ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_ANY, "storage");
    if (storage != NULL) {
        ESP_LOGI(TAG, "storage partition at 0x%08lx, %lu bytes",
                 (unsigned long)storage->address, (unsigned long)storage->size);
    } else {
        ESP_LOGE(TAG, "storage partition missing; check partitions.csv");
    }
}

void app_main(void)
{
    ESP_LOGI(TAG, "CampusPulse bring-up on %s", BOARD_NAME);
    ESP_LOGI(TAG, "bring-up only: no BLE scan, no Wi-Fi upload, no queue");
    log_board_report();

    esp_err_t err = board_init();
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "battery ADC init failed: %s", esp_err_to_name(err));
        return;
    }

    while (true) {
        int32_t pack_mv = 0;
        err = board_battery_read_mv(&pack_mv);
        if (err == ESP_OK) {
            ESP_LOGI(TAG, "battery %" PRId32 " mV%s", pack_mv,
                     pack_mv < BOARD_BATTERY_LOW_MV ? " (below provisional cut-off)" : "");
        } else {
            ESP_LOGW(TAG, "battery read failed: %s", esp_err_to_name(err));
        }
        vTaskDelay(pdMS_TO_TICKS(2000));
    }
}
