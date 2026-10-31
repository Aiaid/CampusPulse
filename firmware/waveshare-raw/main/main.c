/* Independent offline CPRAW recorder; V3 setup belongs to the V3 runtime. */
#include "raw_board.h"
#include "raw_display.h"
#include "raw_format.h"
#include "raw_control.h"
#include "raw_activity.h"
#include "raw_clock.h"
#include "raw_power.h"
#include "raw_export.h"
#include "raw_battery.h"
#include "raw_usb_stream.h"
#include "raw_boot_button.h"
#include "sdkconfig.h"

#include <errno.h>
#include <inttypes.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <sys/time.h>
#include "driver/usb_serial_jtag.h"
#include "driver/gpio.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "host/ble_gap.h"
#include "host/ble_hs.h"
#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#include "nvs_flash.h"

#define SLOT_COUNT 1024u
#define SEGMENT_BYTES (16u * 1024u * 1024u)
#define FREE_RESERVE (8u * 1024u * 1024u)
#define SYNC_US 1000000LL
static const char *TAG = "raw";
static raw_report_t *s_pool;
static QueueHandle_t s_free, s_ready;
static StaticQueue_t s_free_ctl, s_ready_ctl;
static uint8_t s_free_mem[SLOT_COUNT * sizeof(uint16_t)];
static uint8_t s_ready_mem[SLOT_COUNT * sizeof(uint16_t)];
static portMUX_TYPE s_mux = portMUX_INITIALIZER_UNLOCKED;
static struct {
    uint64_t received, enqueued, queue_drops, invalid, written, synced, free_bytes;
    bool scanning, free_known;
    uint32_t stop_event;
    int32_t stop_detail;
    uint64_t scan_start_us;
    uint64_t total_bytes;
    uint32_t errors;
    raw_activity_t activity;
    char state[24];
} s_stats = {.state = "STARTING"};
static bool s_accept, s_stop;
static unsigned s_callbacks;
static SemaphoreHandle_t s_lifecycle;
static StaticSemaphore_t s_lifecycle_ctl;
static uint8_t s_session[16];
static int s_cancel_error;
static TaskHandle_t s_display_task;
static uint8_t s_page;
static bool s_writer_done, s_storage_safe, s_power_requested;
static bool s_ble_ready;
static bool s_shutdown_display_done;
static SemaphoreHandle_t s_clock_lock, s_export_lock;
static StaticSemaphore_t s_clock_ctl, s_export_ctl;
static uint32_t s_clock_generation;
static uint8_t s_clock_source = RAW_CLOCK_RTC;


static esp_err_t clock_read(uint64_t *epoch) {
    xSemaphoreTake(s_clock_lock, portMAX_DELAY);
    esp_err_t result = raw_clock_get(epoch);
    xSemaphoreGive(s_clock_lock);
    return result;
}

static void state(const char *name) {
    portENTER_CRITICAL(&s_mux);
    snprintf(s_stats.state, sizeof s_stats.state, "%s", name);
    portEXIT_CRITICAL(&s_mux);
    if (s_display_task) xTaskNotifyGive(s_display_task);
}


static void stop_reason(uint32_t event, int32_t detail) {
    portENTER_CRITICAL(&s_mux);
    if (!s_stats.stop_event || s_stats.stop_event == RAW_EVENT_USER_STOP ||
        s_stats.stop_event == RAW_EVENT_SPACE_STOP || s_stats.stop_event == RAW_EVENT_POWER_STOP) {
        if (event >= RAW_EVENT_SCAN_ERROR && event <= RAW_EVENT_STORAGE_ERROR && event != s_stats.stop_event) s_stats.errors++;
        s_stats.stop_event = event;
        s_stats.stop_detail = detail;
    }
    portEXIT_CRITICAL(&s_mux);
}

static void request_stop(void) {
    xSemaphoreTake(s_lifecycle, portMAX_DELAY);
    __atomic_store_n(&s_accept, false, __ATOMIC_RELEASE);
    __atomic_store_n(&s_stop, true, __ATOMIC_RELEASE);
    if (__atomic_load_n(&s_ble_ready, __ATOMIC_ACQUIRE) && ble_gap_disc_active()) {
        int rc = ble_gap_disc_cancel();
        if (rc && rc != BLE_HS_EALREADY) {
            s_cancel_error = rc;
            ESP_LOGW(TAG, "scan cancel failed: %d; incoming reports are disabled", rc);
        }
    }
    xSemaphoreGive(s_lifecycle);
}


static int process_gap(struct ble_gap_event *event, void *unused) {
    (void)unused;
    if (event->type == BLE_GAP_EVENT_DISC_COMPLETE) {
        __atomic_store_n(&s_accept, false, __ATOMIC_RELEASE);
        portENTER_CRITICAL(&s_mux);
        s_stats.scanning = false;
        portEXIT_CRITICAL(&s_mux);
        if (!__atomic_load_n(&s_stop, __ATOMIC_ACQUIRE)) {
            stop_reason(RAW_EVENT_SCAN_ENDED, event->disc_complete.reason);
            state("SCAN ENDED");
            __atomic_store_n(&s_stop, true, __ATOMIC_RELEASE);
        }
        return 0;
    }
    if (event->type != BLE_GAP_EVENT_DISC && event->type != BLE_GAP_EVENT_EXT_DISC)
        return 0;
    if (!__atomic_load_n(&s_accept, __ATOMIC_ACQUIRE)) return 0;
    const uint64_t received_us = (uint64_t)esp_timer_get_time();
    uint64_t seq;
    portENTER_CRITICAL(&s_mux);
    seq = ++s_stats.received;
    raw_activity_report(&s_stats.activity, received_us,
        event->type == BLE_GAP_EVENT_DISC ? event->disc.rssi : event->ext_disc.rssi);
    portEXIT_CRITICAL(&s_mux);
    const uint8_t *data = event->type == BLE_GAP_EVENT_DISC
        ? event->disc.data : event->ext_disc.data;
    const unsigned length = event->type == BLE_GAP_EVENT_DISC
        ? event->disc.length_data : event->ext_disc.length_data;
    if (length > RAW_PAYLOAD_MAX || (length && !data)) {
        portENTER_CRITICAL(&s_mux);
        s_stats.invalid++;
        portEXIT_CRITICAL(&s_mux);
        return 0;
    }
    uint16_t slot;
    if (xQueueReceive(s_free, &slot, 0) != pdTRUE) {
        portENTER_CRITICAL(&s_mux);
        s_stats.queue_drops++;
        portEXIT_CRITICAL(&s_mux);
        return 0;
    }
    raw_report_t *r = &s_pool[slot];
    memset(r, 0, offsetof(raw_report_t, payload));
    r->seq = seq;
    r->mono_us = received_us;
    r->length = length;
    r->rssi = 127;
    r->tx_power = 127;
    r->sid = 255;
    if (event->type == BLE_GAP_EVENT_DISC) {
        const struct ble_gap_disc_desc *d = &event->disc;
        r->event_type = d->event_type;
        r->addr_type = d->addr.type;
        memcpy(r->addr, d->addr.val, sizeof r->addr);
        r->direct_addr_type = d->direct_addr.type;
        memcpy(r->direct_addr, d->direct_addr.val, sizeof r->direct_addr);
        r->rssi = d->rssi;
        r->primary_phy = BLE_HCI_LE_PHY_1M;
    } else {
        const struct ble_gap_ext_disc_desc *d = &event->ext_disc;
        r->kind = 1;
        r->event_type = d->legacy_event_type;
        r->props = d->props;
        r->data_status = d->data_status;
        r->addr_type = d->addr.type;
        memcpy(r->addr, d->addr.val, sizeof r->addr);
        r->direct_addr_type = d->direct_addr.type;
        memcpy(r->direct_addr, d->direct_addr.val, sizeof r->direct_addr);
        r->rssi = d->rssi;
        r->tx_power = d->tx_power;
        r->sid = d->sid;
        r->primary_phy = d->prim_phy;
        r->secondary_phy = d->sec_phy;
        r->periodic_interval = d->periodic_adv_itvl;
    }
    if (length) memcpy(r->payload, data, length);
    /* Publish accounting before the consumer can receive the completed slot.
     * The ready queue has SLOT_COUNT entries, so one borrowed free slot always
     * has room. The failure branch remains explicit rather than hiding loss. */
    portENTER_CRITICAL(&s_mux);
    s_stats.enqueued++;
    portEXIT_CRITICAL(&s_mux);
    if (xQueueSend(s_ready, &slot, 0) != pdTRUE) {
        portENTER_CRITICAL(&s_mux);
        s_stats.enqueued--;
        s_stats.queue_drops++;
        portEXIT_CRITICAL(&s_mux);
        (void)xQueueSend(s_free, &slot, 0);
    }
    return 0;
}

static int on_gap(struct ble_gap_event *event, void *unused) {
    __atomic_add_fetch(&s_callbacks, 1u, __ATOMIC_ACQ_REL);
    int result = process_gap(event, unused);
    __atomic_sub_fetch(&s_callbacks, 1u, __ATOMIC_RELEASE);
    return result;
}

static void on_sync(void) {
    xSemaphoreTake(s_lifecycle, portMAX_DELAY);
    if (__atomic_load_n(&s_stop, __ATOMIC_ACQUIRE)) {
        xSemaphoreGive(s_lifecycle);
        return;
    }
    struct ble_gap_ext_disc_params p = {.itvl = 160, .window = 160, .passive = 1};
    __atomic_store_n(&s_accept, true, __ATOMIC_RELEASE);
    /* Passive 1M + coded scanning, duplicates retained, no per-window quota. */
    int rc = ble_gap_ext_disc(BLE_OWN_ADDR_PUBLIC, 0, 0, 0, 0, 0, &p, &p, on_gap, NULL);
    if (rc) {
        stop_reason(RAW_EVENT_SCAN_ERROR, rc);
        ESP_LOGE(TAG, "scan start failed: %d", rc);
        __atomic_store_n(&s_accept, false, __ATOMIC_RELEASE);
        state("SCAN ERROR");
        __atomic_store_n(&s_stop, true, __ATOMIC_RELEASE);
    } else if (__atomic_load_n(&s_stop, __ATOMIC_ACQUIRE)) {
        __atomic_store_n(&s_accept, false, __ATOMIC_RELEASE);
        (void)ble_gap_disc_cancel();
    } else {
        portENTER_CRITICAL(&s_mux);
        s_stats.scan_start_us = (uint64_t)esp_timer_get_time();
        s_stats.scanning = true;
        portEXIT_CRITICAL(&s_mux);
        state("RECORDING");
    }
    xSemaphoreGive(s_lifecycle);
}

static void on_reset(int reason) {
    stop_reason(RAW_EVENT_BLE_RESET, reason);
    ESP_LOGE(TAG, "BLE reset: %d; stopping this session", reason);
    __atomic_store_n(&s_accept, false, __ATOMIC_RELEASE);
    __atomic_store_n(&s_stop, true, __ATOMIC_RELEASE);
    state("BLE ERROR");
}

static void host_task(void *unused) {
    (void)unused;
    nimble_port_run();
    nimble_port_freertos_deinit();
}

static esp_err_t write_stats(uint8_t *frame) {
    uint64_t received, enqueued, drops, invalid, written, synced;
    portENTER_CRITICAL(&s_mux);
    received = s_stats.received; enqueued = s_stats.enqueued;
    drops = s_stats.queue_drops; invalid = s_stats.invalid;
    written = s_stats.written; synced = s_stats.synced;
    portEXIT_CRITICAL(&s_mux);
    size_t n = raw_encode_stats(frame, RAW_FRAME_MAX, esp_timer_get_time(), received,
                               enqueued, drops, invalid, written, synced);
    return n ? raw_storage_write(frame, n) : ESP_FAIL;
}

static esp_err_t sync_file(uint8_t *frame) {
    esp_err_t err = write_stats(frame);
    if (err == ESP_OK) err = raw_storage_sync();
    if (err == ESP_OK) {
        portENTER_CRITICAL(&s_mux);
        s_stats.synced = s_stats.written;
        portEXIT_CRITICAL(&s_mux);
    }
    return err;
}

static esp_err_t write_start(uint8_t *frame, size_t *written) {
    uint64_t start;
    portENTER_CRITICAL(&s_mux);
    start = s_stats.scan_start_us;
    portEXIT_CRITICAL(&s_mux);
    *written = 0;
    if (!start) return ESP_OK;
    *written = raw_encode_event(frame, RAW_FRAME_MAX, start, RAW_EVENT_SCANNING, 0);
    return *written ? raw_storage_write(frame, *written) : ESP_FAIL;
}

static esp_err_t write_clock(uint8_t *frame, uint32_t *seen, size_t *written) {
    *written = 0;
    xSemaphoreTake(s_clock_lock, portMAX_DELAY);
    uint32_t generation = __atomic_load_n(&s_clock_generation, __ATOMIC_ACQUIRE);
    if (!generation || *seen == generation) { xSemaphoreGive(s_clock_lock); return ESP_OK; }
    uint64_t epoch;
    int64_t before = esp_timer_get_time();
    esp_err_t result = raw_clock_get(&epoch);
    int64_t after = esp_timer_get_time();
    uint8_t source = __atomic_load_n(&s_clock_source, __ATOMIC_ACQUIRE);
    xSemaphoreGive(s_clock_lock);
    if (result != ESP_OK) { *seen = generation; return ESP_OK; }
    uint64_t uncertainty = 1000000u + (uint64_t)(after - before);
    if (uncertainty > UINT32_MAX) uncertainty = UINT32_MAX;
    *written = raw_encode_clock(frame, RAW_FRAME_MAX, (uint64_t)(before + (after - before) / 2),
        epoch, (uint32_t)uncertainty, source);
    result = *written ? raw_storage_write(frame, *written) : ESP_FAIL;
    if (result == ESP_OK) *seen = generation;
    return result;
}

static void writer_task(void *unused) {
    (void)unused;
    uint8_t frame[RAW_FRAME_MAX];
    size_t segment_bytes = RAW_HEADER_SIZE;
    int64_t last_sync = esp_timer_get_time(), last_space = last_sync;
    esp_err_t err = ESP_OK;
    bool recorded_start = false;
    uint32_t clock_seen = 0;
    for (;;) {
        size_t anchor_bytes;
        err = write_clock(frame, &clock_seen, &anchor_bytes);
        if (err != ESP_OK) break;
        segment_bytes += anchor_bytes;
        bool scanning;
        portENTER_CRITICAL(&s_mux);
        scanning = s_stats.scanning;
        portEXIT_CRITICAL(&s_mux);
        if (scanning && !recorded_start) {
            size_t n;
            err = write_start(frame, &n);
            if (err != ESP_OK) break;
            segment_bytes += n;
            recorded_start = true;
        }
        uint16_t slot;
        if (xQueueReceive(s_ready, &slot, pdMS_TO_TICKS(100)) == pdTRUE) {
            const uint64_t report_us = s_pool[slot].mono_us;
            if (!recorded_start) {
                size_t n;
                err = write_start(frame, &n);
                segment_bytes += n;
                recorded_start = n != 0;
                if (err != ESP_OK) {
                    (void)xQueueSend(s_free, &slot, 0);
                    break;
                }
            }
            size_t n = raw_encode_report(frame, sizeof frame, &s_pool[slot]);
            err = n ? raw_storage_write(frame, n) : ESP_FAIL;
            (void)xQueueSend(s_free, &slot, 0);
            if (err != ESP_OK) break;
            segment_bytes += n;
            portENTER_CRITICAL(&s_mux);
            s_stats.written++;
            raw_activity_written(&s_stats.activity, report_us);
            portEXIT_CRITICAL(&s_mux);
        }
        int64_t now = esp_timer_get_time();
        if (now - last_sync >= SYNC_US || segment_bytes >= SEGMENT_BYTES) {
            err = sync_file(frame);
            if (err != ESP_OK) break;
            segment_bytes += 80; /* Includes conservative statistics overhead. */
            last_sync = now;
        }
        if (segment_bytes >= SEGMENT_BYTES) {
            err = raw_storage_finish();
            if (err == ESP_OK) err = raw_storage_open(s_session);
            if (err != ESP_OK) break;
            size_t n = raw_encode_header(frame, sizeof frame, s_session);
            err = n ? raw_storage_write(frame, n) : ESP_FAIL;
            if (err == ESP_OK) err = raw_storage_sync();
            if (err != ESP_OK) break;
            segment_bytes = n;
            clock_seen = 0;
        }
        if (now - last_space >= 5000000 && !__atomic_load_n(&s_stop, __ATOMIC_ACQUIRE)) {
            uint64_t free_bytes = 0, total = 0;
            err = raw_storage_capacity(&total, &free_bytes);
            portENTER_CRITICAL(&s_mux);
            s_stats.free_bytes = free_bytes;
            s_stats.total_bytes = total;
            s_stats.free_known = err == ESP_OK;
            portEXIT_CRITICAL(&s_mux);
            if (err != ESP_OK) break;
            if (free_bytes < FREE_RESERVE) {
                stop_reason(RAW_EVENT_SPACE_STOP, 0);
                state("LOW SPACE; STOPPING");
                request_stop();
            }
            last_space = now;
        }
        if (__atomic_load_n(&s_stop, __ATOMIC_ACQUIRE)) {
            request_stop();
            if (!__atomic_load_n(&s_callbacks, __ATOMIC_ACQUIRE) &&
                !uxQueueMessagesWaiting(s_ready)) break;
        }
    }
    request_stop();
    while (__atomic_load_n(&s_callbacks, __ATOMIC_ACQUIRE)) vTaskDelay(1);
    if (err == ESP_OK && !recorded_start) {
        size_t n;
        err = write_start(frame, &n);
    }
    if (err == ESP_OK) {
        size_t n;
        err = write_clock(frame, &clock_seen, &n);
    }
    uint32_t terminal_event;
    int32_t terminal_detail;
    portENTER_CRITICAL(&s_mux);
    terminal_event = s_stats.stop_event;
    terminal_detail = s_stats.stop_detail;
    portEXIT_CRITICAL(&s_mux);
    if (err == ESP_OK) {
        size_t n = raw_encode_event(frame, sizeof frame, esp_timer_get_time(), terminal_event, terminal_detail);
        err = n ? raw_storage_write(frame, n) : ESP_FAIL;
    }
    if (err == ESP_OK) err = sync_file(frame);
    const esp_err_t finish = raw_storage_finish();
    if (err == ESP_OK) err = finish;
    const esp_err_t unmount = raw_storage_unmount();
    if (err == ESP_OK) err = unmount;
    if (err == ESP_OK) {
        if (s_cancel_error) state("CARD SAFE SCAN ERROR");
        else if (terminal_event == RAW_EVENT_SPACE_STOP) state("LOW SPACE; CARD SAFE");
        else if (terminal_event != RAW_EVENT_USER_STOP && terminal_event != RAW_EVENT_POWER_STOP) state("BLE ERROR; CARD SAFE");
        else state("SAFE TO REMOVE");
        ESP_LOGI(TAG, "card unmounted; capture stop event=%lu detail=%ld",
                 (unsigned long)terminal_event, (long)terminal_detail);
    } else {
        stop_reason(RAW_EVENT_STORAGE_ERROR, err);
        state(err == RAW_STORAGE_ERR_FULL ? "CARD FULL" : "STORAGE ERROR");
        uint64_t pending;
        portENTER_CRITICAL(&s_mux);
        pending = s_stats.enqueued - s_stats.written;
        portEXIT_CRITICAL(&s_mux);
        ESP_LOGE(TAG, "storage stopped: %s; pending=%"PRIu64
                 "; failure counters may not be saved to the card", esp_err_to_name(err), pending);
    }
    __atomic_store_n(&s_storage_safe, err == ESP_OK, __ATOMIC_RELEASE);
    __atomic_store_n(&s_writer_done, true, __ATOMIC_RELEASE);
    vTaskDelete(NULL);
}

static void display_task(void *unused) {
    (void)unused;
    bool display = raw_display_init() == ESP_OK;
    esp_err_t battery = raw_battery_init();
    if (battery != ESP_OK) ESP_LOGW(TAG, "battery calibration unavailable: %s", esp_err_to_name(battery));
    if (!display) ESP_LOGW(TAG, "display unavailable; serial status remains active");
    for (;;) {
        const int64_t display_cycle_start = esp_timer_get_time();
        if (__atomic_load_n(&s_power_requested, __ATOMIC_ACQUIRE) &&
            __atomic_load_n(&s_shutdown_display_done, __ATOMIC_ACQUIRE)) {
            (void)ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
            continue;
        }
        raw_display_snapshot_t snap = {0};
        raw_battery_sample_t battery_sample;
        if (raw_battery_read(&battery_sample) == ESP_OK && battery_sample.known) {
            snap.battery_known = true;
            snap.battery_mv = battery_sample.millivolts;
            snap.battery_percent = battery_sample.estimated_percent;
        }
        raw_activity_view_t activity;
        int64_t now = esp_timer_get_time();
        portENTER_CRITICAL(&s_mux);
        memcpy(snap.state, s_stats.state, sizeof snap.state);
        snap.received = s_stats.received; snap.written = s_stats.written;
        snap.synced = s_stats.synced; snap.invalid = s_stats.invalid;
        snap.dropped = s_stats.queue_drops;
        snap.free_bytes = s_stats.free_bytes;
        snap.free_known = s_stats.free_known;
        snap.total_bytes = s_stats.total_bytes;
        snap.storage_errors = s_stats.errors;
        raw_activity_read(&s_stats.activity, now, &activity);
        if (!strcmp(s_stats.state, "STORAGE ERROR") || !strcmp(s_stats.state, "CARD FULL"))
            snap.dropped += s_stats.enqueued - s_stats.written;
        portEXIT_CRITICAL(&s_mux);
        snap.page = __atomic_load_n(&s_page, __ATOMIC_ACQUIRE);
        snap.uptime_s = now / 1000000;
        snap.reports_per_second = activity.rate;
        snap.recent_received = activity.received; snap.recent_written = activity.written;
        memcpy(snap.report_bins, activity.reports, sizeof snap.report_bins);
        memcpy(snap.rssi_bins, activity.rssi, sizeof snap.rssi_bins);
        memcpy(snap.rssi_bin_known, activity.rssi_known, sizeof snap.rssi_bin_known);
        snap.rssi_known = activity.signal_known; snap.rssi_samples = activity.rssi_samples;
        snap.rssi_min = activity.rssi_min; snap.rssi_mean = activity.rssi_mean;
        snap.rssi_max = activity.rssi_max;
        snap.internal_free = heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
        snap.internal_total = heap_caps_get_total_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
        snap.psram_free = heap_caps_get_free_size(MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
        snap.psram_total = heap_caps_get_total_size(MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
        snap.memory_known = snap.internal_total != 0; snap.psram_known = snap.psram_total != 0;
        xSemaphoreTake(s_clock_lock, portMAX_DELAY);
        snap.clock_known = raw_clock_get(&snap.utc_epoch) == ESP_OK;
        if (snap.clock_known && !__atomic_load_n(&s_clock_generation, __ATOMIC_ACQUIRE)) {
            struct timeval tv = {.tv_sec = (time_t)snap.utc_epoch}; settimeofday(&tv, NULL);
            __atomic_store_n(&s_clock_generation, 1u, __ATOMIC_RELEASE);
        }
        snap.clock_calibrated = __atomic_load_n(&s_clock_source, __ATOMIC_ACQUIRE) == RAW_CLOCK_HOST_CALIBRATED_RTC;
        xSemaphoreGive(s_clock_lock);
        snap.buffer_capacity = SLOT_COUNT;
        snap.buffer_used = s_free ? SLOT_COUNT - uxQueueMessagesWaiting(s_free) : 0;
        ESP_LOGI(TAG, "state=%s received=%"PRIu64" written=%"PRIu64" synced=%"PRIu64
                 " dropped=%"PRIu64" invalid=%"PRIu64" free=%"PRIu64,
                 snap.state, snap.received, snap.written, snap.synced, snap.dropped,
                 snap.invalid, snap.free_bytes);
        ESP_LOGI(TAG, "ui page=%u/4 heap=%lu/%lu psram=%lu/%lu slots=%lu/%lu rssi_samples=%lu",
                 snap.page + 1, (unsigned long)snap.internal_free, (unsigned long)snap.internal_total,
                 (unsigned long)snap.psram_free, (unsigned long)snap.psram_total,
                 (unsigned long)snap.buffer_used, (unsigned long)snap.buffer_capacity,
                 (unsigned long)snap.rssi_samples);
        if (display) {
            esp_err_t shown = raw_display_present(&snap);
            if (shown != ESP_OK) ESP_LOGW(TAG, "screen refresh failed: %s", esp_err_to_name(shown));
            else ESP_LOGI(TAG, "ui rendered page=%u/4", snap.page + 1);
        }
        if (__atomic_load_n(&s_power_requested, __ATOMIC_ACQUIRE) &&
            __atomic_load_n(&s_writer_done, __ATOMIC_ACQUIRE) &&
            __atomic_load_n(&s_storage_safe, __ATOMIC_ACQUIRE) &&
            !__atomic_load_n(&s_shutdown_display_done, __ATOMIC_ACQUIRE)) {
            state("POWER OFF");
            snprintf(snap.state, sizeof snap.state, "POWER OFF");
            if (display) {
                esp_err_t off_screen = raw_display_present(&snap);
                if (off_screen != ESP_OK) ESP_LOGW(TAG, "power-off screen refresh failed: %s", esp_err_to_name(off_screen));
                esp_err_t asleep = raw_display_sleep();
                if (asleep != ESP_OK) ESP_LOGW(TAG, "panel power off failed: %s", esp_err_to_name(asleep));
            }
            __atomic_store_n(&s_shutdown_display_done, true, __ATOMIC_RELEASE);
        }
        int64_t remaining_us = 2000000 - (esp_timer_get_time() - display_cycle_start);
        TickType_t wait = remaining_us > 0 ? pdMS_TO_TICKS((remaining_us + 999) / 1000) : 1;
        if (!wait) wait = 1;
        (void)ulTaskNotifyTake(pdTRUE, wait);
    }
}

static void next_page(void) {
    unsigned pages = 4;
    uint8_t page = (__atomic_load_n(&s_page, __ATOMIC_RELAXED) + 1u) % pages;
    __atomic_store_n(&s_page, page, __ATOMIC_RELEASE);
    if (s_display_task) xTaskNotifyGive(s_display_task);
}

static void key_task(void *unused) {
    (void)unused;
    bool power_armed = false;
    unsigned power_samples = 0, released_samples = 0;
    raw_boot_button_t boot = {0};
    for (;;) {
        bool setup_available = false;
        raw_boot_action_t action = raw_boot_button_poll(&boot, raw_boot_pressed(),
            (uint64_t)esp_timer_get_time() / 1000u, setup_available);
        if (action == RAW_BOOT_PAGE) next_page();
        if (!raw_power_pressed()) {
            if (released_samples < 3) released_samples++;
            if (released_samples == 3) power_armed = true;
            power_samples = 0;
        } else {
            released_samples = 0;
            if (power_armed && power_samples < 50) power_samples++;
            if (power_samples == 50 && !__atomic_load_n(&s_power_requested, __ATOMIC_ACQUIRE)) {
                __atomic_store_n(&s_shutdown_display_done, false, __ATOMIC_RELEASE);
                __atomic_store_n(&s_power_requested, true, __ATOMIC_RELEASE);
                stop_reason(RAW_EVENT_POWER_STOP, 0);
                state("STOPPING"); request_stop();
            }
        }
        if (__atomic_load_n(&s_power_requested, __ATOMIC_ACQUIRE) &&
            __atomic_load_n(&s_writer_done, __ATOMIC_ACQUIRE) &&
            __atomic_load_n(&s_storage_safe, __ATOMIC_ACQUIRE) && !raw_power_pressed()) {
            if (!s_display_task || __atomic_load_n(&s_shutdown_display_done, __ATOMIC_ACQUIRE)) {
                xSemaphoreTake(s_export_lock, portMAX_DELAY);
                esp_err_t closed = raw_export_close();
                if (closed == ESP_OK) {
                    xSemaphoreTake(s_clock_lock, portMAX_DELAY);
                    ESP_LOGI(TAG, "safe power off; USB supply may keep VSYS powered during sleep");
                    esp_err_t powered = raw_power_shutdown();
                    ESP_LOGE(TAG, "power off failed: %s", esp_err_to_name(powered));
                    xSemaphoreGive(s_clock_lock);
                }
                xSemaphoreGive(s_export_lock);
                __atomic_store_n(&s_power_requested, false, __ATOMIC_RELEASE);
                state("POWER ERROR");
            }
        }
        vTaskDelay(pdMS_TO_TICKS(20));
    }
}

static void export_command(raw_command_t command, const raw_control_t *control) {
    if (!__atomic_load_n(&s_writer_done, __ATOMIC_ACQUIRE)) { puts("RAW ERR BUSY"); return; }
    xSemaphoreTake(s_export_lock, portMAX_DELAY);
    if (__atomic_load_n(&s_power_requested, __ATOMIC_ACQUIRE)) {
        puts("RAW ERR POWER"); xSemaphoreGive(s_export_lock); return;
    }
    if (command == RAW_COMMAND_FILES) {
        esp_err_t result = raw_export_prepare();
        if (result == ESP_OK) {
            state("STOPPED");
            uint64_t total, free_bytes;
            if (raw_storage_capacity(&total, &free_bytes) == ESP_OK)
                printf("RAW SPACE %llu %llu\n", (unsigned long long)total, (unsigned long long)free_bytes);
            printf("RAW CARD %llu\n", (unsigned long long)raw_storage_card_bytes());
            printf("RAW FILES %u %u\n", (unsigned)raw_export_count(), raw_export_truncated() ? 1u : 0u);
            unsigned current;
            if (raw_export_find(raw_storage_path(), &current) == ESP_OK)
                printf("RAW CURRENT %u\n", current);
            for (unsigned i = 0; i < raw_export_count(); i++) {
                uint32_t size;
                if (raw_export_size(i, &size) == ESP_OK) printf("RAW FILE %u %lu\n", i, (unsigned long)size);
            }
            puts("RAW END");
        } else printf("RAW ERR %ld\n", (long)result);
    } else if (command == RAW_COMMAND_READ) {
        static uint8_t bytes[512];
        static char output[1152];
        size_t length = 0;
        esp_err_t result = raw_export_read(control->file_index, control->file_offset, bytes, sizeof bytes, &length);
        if (result == ESP_OK) {
            int start = snprintf(output, sizeof output, "RAW DATA %lu %lu %u %08lx ",
                (unsigned long)control->file_index, (unsigned long)control->file_offset,
                (unsigned)length, (unsigned long)raw_export_crc32(bytes, length));
            static const char hex[] = "0123456789abcdef";
            for (size_t i = 0; i < length; i++) { output[start + i * 2] = hex[bytes[i] >> 4]; output[start + i * 2 + 1] = hex[bytes[i] & 15]; }
            output[start + length * 2] = '\n'; output[start + length * 2 + 1] = 0;
            fputs(output, stdout);
        } else printf("RAW ERR %ld\n", (long)result);
    } else {
        esp_err_t result = raw_export_close();
        printf("RAW CLOSE %ld\n", (long)result);
        if (result == ESP_OK && __atomic_load_n(&s_storage_safe, __ATOMIC_ACQUIRE)) state("SAFE TO REMOVE");
    }
    fflush(stdout);
    xSemaphoreGive(s_export_lock);
}

static void console_command(void *unused, raw_command_t command, const raw_control_t *parser) {
    (void)unused;
    if (command == RAW_COMMAND_PAGE) next_page();
    if (command == RAW_COMMAND_CLOCK) {
        uint64_t epoch = 0; uint8_t control = 0, seconds = 0;
        xSemaphoreTake(s_clock_lock, portMAX_DELAY);
        esp_err_t result = __atomic_load_n(&s_power_requested, __ATOMIC_ACQUIRE)
            ? ESP_ERR_INVALID_STATE : raw_clock_probe(&epoch, &control, &seconds);
        xSemaphoreGive(s_clock_lock);
        printf("RAW CLOCK %llu %ld %02x %02x\n", (unsigned long long)epoch,
               (long)result, control, seconds);
    }
    if (command == RAW_COMMAND_FILES || command == RAW_COMMAND_READ || command == RAW_COMMAND_CLOSE)
        export_command(command, parser);
    if (command == RAW_COMMAND_TIME) {
        xSemaphoreTake(s_lifecycle, portMAX_DELAY);
        xSemaphoreTake(s_clock_lock, portMAX_DELAY);
        bool stopping = __atomic_load_n(&s_stop, __ATOMIC_ACQUIRE) &&
            !__atomic_load_n(&s_writer_done, __ATOMIC_ACQUIRE);
        esp_err_t result = (__atomic_load_n(&s_power_requested, __ATOMIC_ACQUIRE) || stopping)
            ? ESP_ERR_INVALID_STATE : raw_clock_set(parser->utc_epoch);
        if (result == ESP_OK) {
            struct timeval tv = {.tv_sec = (time_t)parser->utc_epoch};
            settimeofday(&tv, NULL);
            __atomic_store_n(&s_clock_source, RAW_CLOCK_HOST_CALIBRATED_RTC, __ATOMIC_RELEASE);
            __atomic_add_fetch(&s_clock_generation, 1u, __ATOMIC_RELEASE);
        }
        xSemaphoreGive(s_clock_lock);
        xSemaphoreGive(s_lifecycle);
        printf("RAW TIME %llu %ld\n", (unsigned long long)parser->utc_epoch, (long)result);
        if (s_display_task) xTaskNotifyGive(s_display_task);
    }
    if (command == RAW_COMMAND_STOP &&
        !__atomic_load_n(&s_stop, __ATOMIC_ACQUIRE)) {
        stop_reason(RAW_EVENT_USER_STOP, 0);
        state("STOPPING");
        request_stop();
    }
}

static void console_task(void *unused) {
    (void)unused;
    raw_usb_stream_t parser;
    raw_usb_stream_init(&parser);
    cp_usb_frame_fn setup_receive = NULL;
    int64_t last_input = 0;
    uint8_t bytes[32];
    for (;;) {
        if (!usb_serial_jtag_is_connected()) {
            raw_usb_stream_clear(&parser);
            vTaskDelay(pdMS_TO_TICKS(100));
            continue;
        }
        errno = 0;
        ssize_t count = read(STDIN_FILENO, bytes, sizeof bytes);
        if (count > 0) {
            last_input = esp_timer_get_time();
            raw_usb_stream_feed(&parser, bytes, (size_t)count, console_command, setup_receive, NULL);
            cp_usb_secure_clear(bytes, sizeof bytes);
        } else if (count < 0 && (!errno || !usb_serial_jtag_is_connected())) {
            raw_usb_stream_clear(&parser);
            vTaskDelay(pdMS_TO_TICKS(100));
        } else if (count < 0 && errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR) {
            ESP_LOGE(TAG, "USB control read failed: %d; stopping recorder", errno);
            stop_reason(RAW_EVENT_USER_STOP, errno);
            request_stop();
            vTaskDelete(NULL);
        } else {
            if (last_input && esp_timer_get_time() - last_input > 2000000) {
                raw_usb_stream_clear(&parser); last_input = 0;
            }
            vTaskDelay(pdMS_TO_TICKS(50));
        }
    }
}

void app_main(void) {
    esp_err_t power = raw_power_init();
    s_lifecycle = xSemaphoreCreateMutexStatic(&s_lifecycle_ctl);
    s_clock_lock = xSemaphoreCreateMutexStatic(&s_clock_ctl);
    s_export_lock = xSemaphoreCreateMutexStatic(&s_export_ctl);
    if (power != ESP_OK) { state("POWER ERROR"); ESP_LOGE(TAG, "power hold initialization failed"); return; }
    if (xTaskCreate(key_task, "raw_key", 3072, NULL, 1, NULL) != pdPASS)
        ESP_LOGW(TAG, "power/BOOT key task unavailable; use USB control");
    esp_err_t clock = raw_clock_init();
    for (unsigned attempt = 0; clock != ESP_OK && attempt < 4; attempt++) {
        vTaskDelay(pdMS_TO_TICKS(50)); clock = raw_clock_init();
    }
    uint64_t epoch;
    if (clock == ESP_OK && clock_read(&epoch) == ESP_OK) {
        struct timeval tv = {.tv_sec = (time_t)epoch}; settimeofday(&tv, NULL);
        __atomic_store_n(&s_clock_generation, 1u, __ATOMIC_RELEASE);
        ESP_LOGI(TAG, "RTC valid");
    } else ESP_LOGW(TAG, "RTC time unknown: %s; await trusted USB TIME calibration", esp_err_to_name(clock));
    esp_err_t err = nvs_flash_init(); /* Never erase a pre-existing NVS partition. */
    if (err != ESP_OK) { state("NVS ERROR"); goto failed; }
    esp_fill_random(s_session, sizeof s_session);
    err = raw_storage_mount();
    if (err == ESP_OK) err = raw_storage_capacity(&s_stats.total_bytes, &s_stats.free_bytes);
    s_stats.free_known = err == ESP_OK;
    if (err == ESP_OK && s_stats.free_bytes < FREE_RESERVE) err = RAW_STORAGE_ERR_FULL;
    if (err == ESP_OK) err = raw_storage_open(s_session);
    uint8_t header[RAW_HEADER_SIZE];
    size_t n = raw_encode_header(header, sizeof header, s_session);
    if (err == ESP_OK) err = n ? raw_storage_write(header, n) : ESP_FAIL;
    if (err == ESP_OK) err = raw_storage_sync();
    if (err != ESP_OK) { state("CARD ERROR"); goto failed; }
    s_pool = heap_caps_calloc(SLOT_COUNT, sizeof *s_pool, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!s_pool) { err = ESP_ERR_NO_MEM; state("BUFFER ERROR"); goto failed; }
    s_free = xQueueCreateStatic(SLOT_COUNT, sizeof(uint16_t), s_free_mem, &s_free_ctl);
    s_ready = xQueueCreateStatic(SLOT_COUNT, sizeof(uint16_t), s_ready_mem, &s_ready_ctl);
    if (!s_free || !s_ready) { err = ESP_ERR_NO_MEM; state("QUEUE ERROR"); goto failed; }
    for (uint16_t slot = 0; slot < SLOT_COUNT; slot++) (void)xQueueSend(s_free, &slot, 0);
    err = nimble_port_init();
    if (err != ESP_OK) { state("BLE INIT ERROR"); goto failed; }
    __atomic_store_n(&s_ble_ready, true, __ATOMIC_RELEASE);
    ble_hs_cfg.sync_cb = on_sync;
    ble_hs_cfg.reset_cb = on_reset;
    TaskHandle_t console = NULL;
    const unsigned console_stack = 4096; /* Includes the bounded mixed-stream parser. */
    if (xTaskCreate(console_task, "raw_console", console_stack, NULL, 1, &console) != pdPASS) {
        err = ESP_ERR_NO_MEM; state("CONTROL ERROR");
        (void)nimble_port_deinit();
        __atomic_store_n(&s_ble_ready, false, __ATOMIC_RELEASE);
        goto failed;
    }
    if (xTaskCreate(writer_task, "raw_writer", 6144, NULL, 5, NULL) != pdPASS) {
        err = ESP_ERR_NO_MEM; state("WRITER ERROR");
        vTaskDelete(console);
        (void)nimble_port_deinit();
        __atomic_store_n(&s_ble_ready, false, __ATOMIC_RELEASE);
        goto failed;
    }
    if (xTaskCreate(display_task, "raw_display", 6144, NULL, 1, &s_display_task) != pdPASS)
        ESP_LOGW(TAG, "display task unavailable; USB STOP remains available");
    ESP_LOGI(TAG, "raw recorder: %u slots, %u bytes/slot; STOP flushes and unmounts",
             SLOT_COUNT, (unsigned)sizeof *s_pool);
    nimble_port_freertos_init(host_task);
    return;
failed:
    ESP_LOGE(TAG, "startup failed: %s; card is never auto-formatted", esp_err_to_name(err));
    esp_err_t closed = raw_storage_finish();
    esp_err_t unmounted = raw_storage_unmount();
    __atomic_store_n(&s_storage_safe, closed == ESP_OK && unmounted == ESP_OK, __ATOMIC_RELEASE);
    __atomic_store_n(&s_writer_done, true, __ATOMIC_RELEASE);
    if (xTaskCreate(display_task, "raw_display", 6144, NULL, 1, &s_display_task) != pdPASS)
        ESP_LOGW(TAG, "startup failure display unavailable");
}
