#pragma once
/* Host-only ESP/RTOS declarations for compiling the actual pipeline. */
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include "esp_err.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include "freertos/queue.h"

#define configMAX_PRIORITIES 25
#define MALLOC_CAP_INTERNAL 1u
#define MALLOC_CAP_8BIT 2u
#define ESP_PARTITION_TYPE_DATA 1
#define BLE_GAP_EVENT_DISC_COMPLETE 1
#define BLE_GAP_EVENT_DISC 2
#define BLE_HS_EINVAL 3
#define BLE_HS_FOREVER INT32_MAX
#define ESP_LOGI(tag, ...) do { (void)(tag); if (false) printf(__VA_ARGS__); } while (0)
#define ESP_LOGW ESP_LOGI
#define ESP_LOGE ESP_LOGI

typedef unsigned EventBits_t;
typedef void *EventGroupHandle_t;
typedef struct { uint32_t address, size; } esp_partition_t;
typedef struct { uint8_t val[6], type; } ble_addr_t;
struct ble_gap_disc_desc {
    ble_addr_t addr;
    int16_t rssi;
    uint8_t event_type, length_data;
    const uint8_t *data;
};
struct ble_gap_event { unsigned type; struct ble_gap_disc_desc disc; };
struct ble_gap_disc_params { bool passive, filter_duplicates; uint16_t itvl, window; };
typedef struct { void (*sync_cb)(void); void (*reset_cb)(int); } test_ble_hs_cfg_t;
extern test_ble_hs_cfg_t ble_hs_cfg;

int esp_bt_controller_get_status(void);
size_t esp_get_free_heap_size(void);
size_t heap_caps_get_free_size(uint32_t caps);
size_t heap_caps_get_largest_free_block(uint32_t caps);
size_t heap_caps_get_minimum_free_size(uint32_t caps);
void esp_fill_random(void *data, size_t size);
uint32_t esp_random(void);
int64_t esp_timer_get_time(void);
esp_err_t esp_partition_read(const esp_partition_t *, size_t, void *, size_t);
esp_err_t esp_partition_write(const esp_partition_t *, size_t, const void *, size_t);
esp_err_t esp_partition_erase_range(const esp_partition_t *, size_t, size_t);
const esp_partition_t *esp_partition_find_first(unsigned, unsigned, const char *);
SemaphoreHandle_t xSemaphoreCreateBinary(void);
void vSemaphoreDelete(SemaphoreHandle_t);
void vQueueDelete(QueueHandle_t);
void vTaskDelete(TaskHandle_t);
void vTaskSuspend(TaskHandle_t);
unsigned uxTaskGetStackHighWaterMark(TaskHandle_t);
EventGroupHandle_t xEventGroupCreate(void);
void vEventGroupDelete(EventGroupHandle_t);
EventBits_t xEventGroupSetBits(EventGroupHandle_t, EventBits_t);
EventBits_t xEventGroupClearBits(EventGroupHandle_t, EventBits_t);
EventBits_t xEventGroupWaitBits(EventGroupHandle_t, EventBits_t, bool, bool, TickType_t);
int ble_gap_disc_cancel(void);
int ble_hs_util_ensure_addr(unsigned);
int ble_hs_id_infer_auto(unsigned, uint8_t *);
int ble_gap_disc(uint8_t, int32_t, const struct ble_gap_disc_params *,
                 int (*)(struct ble_gap_event *, void *), void *);
void ble_svc_gap_init(void);
void ble_svc_gatt_init(void);
esp_err_t nimble_port_init(void);
void nimble_port_run(void);
int nimble_port_stop(void);
esp_err_t nimble_port_deinit(void);
