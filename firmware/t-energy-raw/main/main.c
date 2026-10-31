/* Development-only raw ingress: no network, storage, or payload logging. */
#include "raw_ingress.h"
#include "esp_err.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "nvs_flash.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "host/ble_gap.h"
#include "host/ble_hs.h"
#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#include <stdatomic.h>
#include <stddef.h>
#include <string.h>

#define SLOT_COUNT 1024u
static const char *TAG = "te_raw";
static te_raw_ingress_t s_ingress;
static te_raw_report_t *s_slots;
/* NimBLE invokes the discovery callback on its single host task. */
static te_raw_report_t s_meta;
static _Atomic bool s_scanning;

static int discovery(struct ble_gap_event *event, void *unused) {
    (void)unused;
    if (event->type == BLE_GAP_EVENT_DISC_COMPLETE) {
        atomic_store(&s_scanning, false);
        ESP_LOGW(TAG, "scan_ended reason=%d", event->disc_complete.reason);
        return 0;
    }
    if (event->type != BLE_GAP_EVENT_DISC && event->type != BLE_GAP_EVENT_EXT_DISC) return 0;
    memset(&s_meta, 0, offsetof(te_raw_report_t, payload));
    s_meta.mono_us = (uint64_t)esp_timer_get_time();
    s_meta.rssi = 127; s_meta.tx_power = 127; s_meta.sid = 255;
    const uint8_t *data; size_t length;
    if (event->type == BLE_GAP_EVENT_DISC) {
        const struct ble_gap_disc_desc *d = &event->disc;
        data = d->data; length = d->length_data;
        s_meta.event_type = d->event_type; s_meta.addr_type = d->addr.type;
        memcpy(s_meta.addr, d->addr.val, sizeof s_meta.addr);
        s_meta.direct_addr_type = d->direct_addr.type;
        memcpy(s_meta.direct_addr, d->direct_addr.val, sizeof s_meta.direct_addr);
        s_meta.rssi = d->rssi; s_meta.primary_phy = BLE_HCI_LE_PHY_1M;
    } else {
        const struct ble_gap_ext_disc_desc *d = &event->ext_disc;
        data = d->data; length = d->length_data;
        s_meta.kind = 1; s_meta.event_type = d->legacy_event_type;
        s_meta.props = d->props; s_meta.data_status = d->data_status;
        s_meta.addr_type = d->addr.type; memcpy(s_meta.addr, d->addr.val, sizeof s_meta.addr);
        s_meta.direct_addr_type = d->direct_addr.type;
        memcpy(s_meta.direct_addr, d->direct_addr.val, sizeof s_meta.direct_addr);
        s_meta.rssi = d->rssi; s_meta.tx_power = d->tx_power; s_meta.sid = d->sid;
        s_meta.primary_phy = d->prim_phy; s_meta.secondary_phy = d->sec_phy;
        s_meta.periodic_interval = d->periodic_adv_itvl;
    }
    (void)te_raw_ingress_push(&s_ingress, &s_meta, data, length);
    return 0;
}
static void synced(void) {
    struct ble_gap_ext_disc_params p = {.itvl = 160, .window = 160, .passive = 1};
    int err = ble_gap_ext_disc(BLE_OWN_ADDR_PUBLIC, 0, 0, 0, 0, 0, &p, &p, discovery, NULL);
    atomic_store(&s_scanning, err == 0);
    if (err) ESP_LOGE(TAG, "scan_start_failed=%d", err);
}
static void reset(int reason) {
    atomic_store(&s_scanning, false);
    ESP_LOGE(TAG, "ble_reset=%d", reason);
}
static void host(void *unused) { (void)unused; nimble_port_run(); nimble_port_freertos_deinit(); }
static void status(void *unused) {
    (void)unused;
    for (;;) {
        te_raw_ingress_stats_t x; te_raw_ingress_stats(&s_ingress, &x);
        ESP_LOGI(TAG, "scanning=%u uploader=unavailable offline=1 capacity=%u received=%lu buffered=%lu dropped_full=%lu dropped_oversize=%lu dropped_invalid=%lu unconfirmed_volatile=1",
            (unsigned)atomic_load(&s_scanning), SLOT_COUNT, (unsigned long)x.received,
            (unsigned long)x.enqueued, (unsigned long)x.dropped_full,
            (unsigned long)x.dropped_oversize, (unsigned long)x.dropped_invalid);
        vTaskDelay(pdMS_TO_TICKS(10000));
    }
}
void app_main(void) {
    esp_err_t err = nvs_flash_init();
    if (err != ESP_OK) { ESP_LOGE(TAG, "nvs_init_failed=%d", (int)err); return; }
    s_slots = heap_caps_calloc(SLOT_COUNT, sizeof *s_slots, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!s_slots || !esp_ptr_external_ram(s_slots) || !te_raw_ingress_init(&s_ingress, s_slots, SLOT_COUNT)) {
        ESP_LOGE(TAG, "psram_ingress_unavailable"); return;
    }
    if (xTaskCreate(status, "raw_status", 4096, NULL, 2, NULL) != pdPASS) {
        ESP_LOGE(TAG, "status_task_failed"); return;
    }
    err = nimble_port_init();
    if (err != ESP_OK) { ESP_LOGE(TAG, "nimble_init_failed=%d", (int)err); return; }
    ble_hs_cfg.sync_cb = synced; ble_hs_cfg.reset_cb = reset;
    ESP_LOGW(TAG, "development_capture_only uploader_unavailable buffer_volatile no_tf=1");
    nimble_port_freertos_init(host);
}
