// Exercise actual page sources with a deterministic, finite RTOS scheduler.
// These stubs verify ownership/queue behavior, not real FreeRTOS concurrency,
// SPI timing, glyph rasterization, radio behavior or device acceptance. Status
// bounds and row spacing do use the actual generated 20 px font metrics.
#include <assert.h>
#include <setjmp.h>
#include <stdlib.h>
#include <string.h>
#include "font_zh.h"

#include "../ai-passport-radar/main/page_radar.c"
#include "../ai-passport-radar/main/page_status.c"

typedef struct {
    unsigned capacity, head, length;
    size_t item_size;
    unsigned char slots[16][64];
} test_queue_t;

static int64_t now_us;
static bool fail_queue, fail_task, ui_owner;
static unsigned deleted_queues, live_queues, render_calls, reset_calls;
static unsigned service_calls, digits_calls, task_creations;
static scan_snapshot_t mock_snapshot;
static void (*task_entry)(void *);
static void *task_arg;
static jmp_buf scheduler_return;
static unsigned task_rounds;
static bool status_render;
static bool saw_unavailable;
typedef struct { int x, y; char text[80]; } text_command_t;
static text_command_t status_text[32];
static unsigned status_text_count, unknown_bar_marks;
static unsigned activity_bars;
static int heap_bar_width, queue_bar_width;

static const char *text_at(int y)
{
    for (unsigned i = 0; i < status_text_count; i++)
        if (status_text[i].y == y) return status_text[i].text;
    return "";
}

int64_t esp_timer_get_time(void) { return now_us; }

QueueHandle_t xQueueCreate(unsigned capacity, size_t item_size)
{
    if (fail_queue) return NULL;
    test_queue_t *queue = calloc(1, sizeof *queue);
    assert(queue && capacity <= 16 && item_size <= 64);
    queue->capacity = capacity;
    queue->item_size = item_size;
    live_queues++;
    return queue;
}

void vQueueDelete(QueueHandle_t queue)
{
    assert(queue && live_queues);
    deleted_queues++;
    live_queues--;
    free(queue);
}

int xQueueSend(QueueHandle_t handle, const void *item, TickType_t wait)
{
    test_queue_t *queue = handle;
    assert(wait == 0); // Input ingress must never wait for UI capacity.
    if (queue->length == queue->capacity) return pdFALSE;
    const unsigned tail = (queue->head + queue->length) % queue->capacity;
    memcpy(queue->slots[tail], item, queue->item_size);
    queue->length++;
    return pdTRUE;
}

int xQueueReceive(QueueHandle_t handle, void *item, TickType_t wait)
{
    assert(ui_owner);
    // Run one complete real task iteration, including its bounded queue drain
    // and refresh; return to the test on its next blocking receive.
    if (wait && task_rounds++ == 1) longjmp(scheduler_return, 1);
    test_queue_t *queue = handle;
    if (!queue->length) return pdFALSE;
    memcpy(item, queue->slots[queue->head], queue->item_size);
    queue->head = (queue->head + 1) % queue->capacity;
    queue->length--;
    return pdTRUE;
}

int xTaskCreate(void (*entry)(void *), const char *name, unsigned stack,
                void *arg, unsigned priority, TaskHandle_t *out)
{
    (void)name;
    (void)stack;
    (void)priority;
    if (fail_task) return pdFALSE;
    task_entry = entry;
    task_arg = arg;
    task_creations++;
    *out = &task_creations;
    return pdPASS;
}

static void run_ui_round(void)
{
    assert(task_entry);
    task_rounds = 0;
    ui_owner = true;
    if (setjmp(scheduler_return) == 0) task_entry(task_arg);
    ui_owner = false;
}

void scan_ble_snapshot(scan_snapshot_t *out)
{
    assert(ui_owner);
    *out = mock_snapshot;
}

void scan_ble_set_sniff(bool enabled)
{
    (void)enabled;
    assert(ui_owner);
    service_calls++;
}
bool scan_ble_get_sniff(void) { assert(ui_owner); return false; }
void scan_ble_set_phone(bool enabled)
{
    (void)enabled;
    assert(ui_owner);
    service_calls++;
}
bool scan_ble_get_phone(void) { assert(ui_owner); return true; }
uint8_t scan_ble_get_evidence(void) { assert(ui_owner); return 1; }
bool scan_ble_set_evidence(uint8_t mask)
{
    (void)mask;
    assert(ui_owner);
    service_calls++;
    return true;
}
void scan_ble_reset(void) { assert(ui_owner); reset_calls++; }
int bsp_battery_soc(void) { assert(ui_owner); return -1; }
bool wifi_time_now(int *hour, int *minute)
{
    (void)hour;
    (void)minute;
    assert(ui_owner);
    return false;
}

void ui_render(ui_rect_t region, ui_paint_fn paint, void *user)
{
    (void)region;
    assert(ui_owner);
    render_calls++;
    if (status_render) {
        status_text_count = unknown_bar_marks = 0;
        activity_bars = 0;
        heap_bar_width = queue_bar_width = 0;
    }
    paint(user);
}
void ui_clear(uint16_t color) { (void)color; assert(ui_owner); }
void ui_fill(int x, int y, int width, int height, uint16_t color)
{
    assert(ui_owner);
    if (!status_render) return;
    assert(x >= 0 && y >= 0 && width > 0 && height > 0);
    assert(x + width <= UI_W && y + height <= UI_H);
    if (y == 122 && color == UI_COL_TEAL) heap_bar_width = width;
    if (y == 180 && color == UI_COL_YELLOW) queue_bar_width = width;
    if ((y == 123 || y == 181) && color == UI_COL_MUTED) unknown_bar_marks++;
    if (color == UI_COL_TEAL && y >= 160 && y < 194) activity_bars++;
}
void ui_text(int x, int y, const char *text, uint16_t color)
{
    (void)color;
    assert(ui_owner && strlen(text) < 80);
    if (!strcmp(text, "Snapshot unavailable")) saw_unavailable = true;
    if (status_render) {
        for (const unsigned char *p = (const unsigned char *)text; *p; p++) {
            assert(*p >= 32 && *p <= 126);
        }
        assert(x >= 0 && y >= 0 && y + FONT_ZH_CELL <= UI_H);
        assert(x + ui_text_width(text) <= UI_W);
        assert(status_text_count < sizeof status_text / sizeof status_text[0]);
        status_text[status_text_count].x = x;
        status_text[status_text_count].y = y;
        strcpy(status_text[status_text_count++].text, text);
    }
}
int ui_text_width(const char *text)
{
    int width = 0;
    for (const unsigned char *p = (const unsigned char *)text; *p; p++) {
        uint8_t advance = 8;
        (void)font_zh_glyph(*p, &advance);
        width += advance;
    }
    return width;
}
void ui_digits(int x, int y, const char *text, uint16_t color)
{
    (void)x; (void)y; (void)text; (void)color;
    assert(ui_owner);
    digits_calls++;
}
int ui_digits_width(const char *text) { return (int)strlen(text) * 30; }

static void enqueue_at(bsp_btn_t button, int64_t time_us)
{
    now_us = time_us;
    radar_page_key(button, BSP_BTN_CLICK);
}

static void test_startup_and_ingress(void)
{
    radar_page_key(BSP_BTN_OK, BSP_BTN_CLICK);
    assert(radar_page_input_drops() == 1 && s_focus == FOCUS_NONE);
    fail_queue = true;
    assert(radar_page_start() == ESP_ERR_NO_MEM && live_queues == 0);
    fail_queue = false;
    fail_task = true;
    assert(radar_page_start() == ESP_ERR_NO_MEM);
    assert(deleted_queues == 1 && live_queues == 0);
    fail_task = false;
    assert(radar_page_start() == ESP_OK);
    assert(radar_page_start() == ESP_OK && task_creations == 1);
    for (unsigned i = 0; i < INPUT_QUEUE_LEN; i++) {
        radar_page_key(BSP_BTN_DOWN, BSP_BTN_CLICK);
    }
    assert(s_focus == FOCUS_NONE && service_calls == 0 && render_calls == 0);
    radar_page_key(BSP_BTN_OK, BSP_BTN_CLICK);
    assert(radar_page_input_drops() == 2);
    run_ui_round(); // Sixteen queued moves wrap through all four focus positions.
    assert(s_focus == FOCUS_NONE && service_calls == 0);
    assert(saw_unavailable && digits_calls == 0);
    enqueue_at(BSP_BTN_OK, 1000000);
    assert(s_focus == FOCUS_NONE); // Producer has not changed page state.
    run_ui_round();
    assert(s_focus == FOCUS_PHONE);
    enqueue_at(BSP_BTN_OK, 2000000);
    assert(service_calls == 0);
    run_ui_round();
    assert(service_calls == 1);
}

static void test_confirmation_ingress_time(void)
{
    enqueue_at(BSP_BTN_DOWN, 3000000);
    enqueue_at(BSP_BTN_DOWN, 4000000);
    run_ui_round();
    assert(s_focus == FOCUS_RESET);
    enqueue_at(BSP_BTN_OK, 10000000);
    enqueue_at(BSP_BTN_OK, 14000000); // Too late: re-arm instead of reset.
    run_ui_round();
    assert(s_confirm && reset_calls == 0);
    enqueue_at(BSP_BTN_OK, 15000000);
    run_ui_round();
    assert(!s_confirm && reset_calls == 1);
    enqueue_at(BSP_BTN_OK, 20000000);
    enqueue_at(BSP_BTN_OK, 22000000); // Physical clicks are within the deadline.
    now_us = 30000000; // A delayed renderer must not rewrite click timestamps.
    run_ui_round();
    assert(!s_confirm && reset_calls == 2);
    enqueue_at(BSP_BTN_OK, 31000000);
    enqueue_at(BSP_BTN_UP, 32000000);
    run_ui_round();
    assert(!s_confirm && reset_calls == 2);
    enqueue_at(BSP_BTN_DOWN, 33000000);
    enqueue_at(BSP_BTN_OK, 34000000);
    now_us = 38000000;
    run_ui_round();
    assert(!s_confirm && reset_calls == 2); // Refresh also expires confirmation.
}

static void test_snapshot_availability(void)
{
    mock_snapshot.snapshot_valid = true;
    mock_snapshot.running = true;
    mock_snapshot.phone_on = true;
    mock_snapshot.phone_count = 9;
    mock_snapshot.evidence_mask = EVID_LINK_SHORT;
    run_ui_round();
    assert(!s_first_frame && !strcmp(s_shown.phone, "9"));
    const uint8_t filter_samples = s_ph_smooth.n;
    mock_snapshot.snapshot_valid = false;
    mock_snapshot.phone_count = 0;
    run_ui_round();
    assert(!strcmp(s_shown.phone, "9"));
    assert(!strcmp(s_shown.side, "Snapshot unavailable"));
    assert(s_ph_smooth.n == filter_samples);
    mock_snapshot.snapshot_valid = true;
    mock_snapshot.phone_count = 9;
    run_ui_round();
    assert(!strcmp(s_shown.phone, "9") && !s_shown.side[0]);
}

static void test_delayed_physical_forwarding(void)
{
    assert(s_focus == FOCUS_RESET && !s_confirm);
    const unsigned resets = reset_calls;
    // Both callbacks arrive at the radar page much later, at the same time.
    // Their physical timestamps are four seconds apart: they cannot confirm.
    now_us = 50000000;
    radar_page_key_at(BSP_BTN_OK, BSP_BTN_CLICK, 40000000);
    radar_page_key_at(BSP_BTN_OK, BSP_BTN_CLICK, 44000000);
    run_ui_round();
    assert(reset_calls == resets && !s_confirm);
    // Physical timestamps two seconds apart still confirm despite forwarding
    // delay. Neither the forwarding task nor renderer replaces those times.
    now_us = 55000000;
    radar_page_key_at(BSP_BTN_OK, BSP_BTN_CLICK, 45000000);
    radar_page_key_at(BSP_BTN_OK, BSP_BTN_CLICK, 47000000);
    assert(reset_calls == resets);
    run_ui_round();
    assert(reset_calls == resets + 1 && !s_confirm);
    const uint32_t drops = radar_page_input_drops();
    radar_page_key_at(BSP_BTN_OK, BSP_BTN_CLICK, -1);
    assert(radar_page_input_drops() == drops + 1);
    run_ui_round();
    assert(reset_calls == resets + 1 && !s_confirm);
}

static void test_bounded_status(void)
{
    cp_status_view_t view;
    memset(&view, 0xff, sizeof view); // Every text field is deliberately unterminated.
    view.setup_active = false;
    view.setup_softap = false;
    view.setup_usb = false;
    view.battery_percent = -1;
    memset(&view.debug, 0, sizeof view.debug);
    ui_owner = status_render = true;
    status_page_render(&view);
    assert(!strcmp(text_at(70), "Link -- Mb/s"));
    assert(strstr(text_at(296), "Collect: "));
    assert(unknown_bar_marks == 41 && !heap_bar_width && !queue_bar_width);
    const unsigned calls = render_calls;
    status_page_render(NULL);
    assert(render_calls == calls);
    // Setup fields are bounded: an 8-digit PIN, 12-character AP password, and USB view.
    view.setup_active = true;
    status_page_render(&view);
    assert(!strcmp(text_at(6), "Bluetooth setup"));
    assert(!strcmp(text_at(116), "Setup PIN (5 min)"));
    assert(strlen(text_at(136)) == 8);
    assert(!text_at(4)[0]);
    view.setup_softap = true;
    status_page_render(&view);
    assert(!strcmp(text_at(6), "Wi-Fi hotspot setup"));
    assert(!strcmp(text_at(176), "Wi-Fi password"));
    assert(strlen(text_at(196)) == 12);
    view.setup_usb = true;
    status_page_render(&view);
    assert(!strcmp(text_at(6), "USB setup"));
    assert(!text_at(136)[0] && !strcmp(text_at(176), "State"));
    assert(render_calls == calls + 3);
    ui_owner = status_render = false;
}

static void test_debug_dashboard(void)
{
    cp_status_view_t view = {0};
    cp_debug_snapshot_t *d = &view.debug;
    strcpy(view.authentication, "ready");
    strcpy(view.collection, "collecting");
    strcpy(view.setup_proof, "secret-proof");
    strcpy(view.setup_password, "secret-password");
    d->wifi_connected = d->wifi_rssi_known = d->wifi_phy_known = true;
    strcpy(d->wifi_ssid, "Synthetic Debug Wi-Fi");
    strcpy(d->wifi_phy, "11n/20");
    d->wifi_rssi_dbm = -61;
    d->heap_known = d->queue_known = true;
    d->heap_internal_free = 64 * 1024;
    d->heap_internal_total = 256 * 1024;
    d->heap_sample_min_free = 40 * 1024;
    d->heap_sample_min_largest = 24 * 1024;
    d->heap_internal_largest = 22 * 1024;
    d->heap_boot_min_8bit = 16 * 1024;
    d->queue_pending = 128;
    d->queue_capacity = 1024;
    d->ble_collecting = true;
    d->upload.known = d->upload.goodput_known = true;
    d->upload.result = CP_DEBUG_UPLOAD_ACKED;
    d->upload.goodput_bytes_per_sec = 18 * 1024 + 512;
    d->upload.last_http_status = 200;
    d->upload.last_age_ms = 12000;
    ui_owner = status_render = true;
    status_page_render(&view);
    assert(strstr(text_at(26), "SSID:") && strstr(text_at(26), "..."));
    assert(!strcmp(text_at(48), "-61dBm PHY:11n/20"));
    assert(!strcmp(text_at(70), "Link -- Mb/s"));
    assert(!strcmp(text_at(92), "Heap free 64/256 KiB"));
    assert(!strcmp(text_at(114), "Used 75%"));
    assert(!strcmp(text_at(136), "Blk22K BootMin16K"));
    assert(!strcmp(text_at(158), "Q 128/1024 slots"));
    assert(heap_bar_width == 84 && queue_bar_width == 27 && !unknown_bar_marks);
    assert(!strcmp(text_at(186), "UP ACK verified"));
    assert(!strcmp(text_at(208), "Last 18.5KiB/s 12s"));
    assert(!strcmp(text_at(230), "HTTP 200 Err 0"));
    assert(!strcmp(text_at(274), "Auth: ready"));
    assert(!strcmp(text_at(296), "Collect: collecting"));
    // Ordinary rows have >=22 px pitch around the true 20 px glyph cell.
    for (unsigned i = 1; i < status_text_count; i++)
        assert(status_text[i].y - status_text[i - 1].y >= FONT_ZH_CELL + 2);
    for (unsigned i = 0; i < status_text_count; i++)
        assert(!strstr(status_text[i].text, "secret-"));
    d->heap_internal_free = d->heap_internal_total;
    status_page_render(&view);
    assert(heap_bar_width == 0 && !strcmp(text_at(114), "Used 0%"));
    d->heap_internal_free = 0;
    status_page_render(&view);
    assert(heap_bar_width == HEAP_BAR_SPAN && !strcmp(text_at(114), "Used 100%"));
    d->heap_internal_free = 64 * 1024;
    d->upload.last_age_ms = 31000;
    status_page_render(&view);
    assert(strstr(text_at(208), "Old 18.5KiB/s 31s"));
    d->wifi_connected = false;
    status_page_render(&view);
    assert(!strcmp(text_at(26), "Wi-Fi disconnected"));
    assert(!strcmp(text_at(48), "--dBm PHY:--"));
    assert(strstr(text_at(208), "Off 18.5KiB/s 31s"));
    d->upload.in_flight = true;
    status_page_render(&view);
    assert(!strcmp(text_at(186), "UP sending"));
    d->upload.in_flight = false;
    d->upload.result = CP_DEBUG_UPLOAD_BAD_ACK;
    // Even an inconsistent producer cannot display verified speed for bad ACK.
    status_page_render(&view);
    assert(!strcmp(text_at(186), "UP bad ACK"));
    assert(!strcmp(text_at(208), "Last -- KiB/s 31s"));
    d->upload.result = CP_DEBUG_UPLOAD_ACKED;
    d->upload.goodput_bytes_per_sec = 0;
    status_page_render(&view);
    assert(strstr(text_at(208), "0.0KiB/s"));
    d->upload.known = false;
    status_page_render(&view);
    assert(!strcmp(text_at(186), "UP idle / no result"));
    assert(!strcmp(text_at(208), "Last -- KiB/s age --"));
    // All maximal counters, bounded unterminated text and bar arithmetic are
    // exercised under ASan/UBSan using the real generated font advances.
    d->wifi_connected = d->wifi_mbps_known = true;
    memset(d->wifi_ssid, 0xff, sizeof d->wifi_ssid);
    memset(d->wifi_phy, 'W', sizeof d->wifi_phy);
    d->wifi_mbps = UINT32_MAX;
    d->heap_internal_free = d->queue_pending = UINT32_MAX;
    d->heap_internal_total = d->queue_capacity = 1;
    d->aggregation_drops = d->summary_drops = d->raw_drops = UINT32_MAX;
    d->storage_drops = d->windows_dropped = UINT32_MAX;
    d->upload.known = true;
    d->upload.last_age_ms = UINT32_MAX;
    d->upload.last_http_status = INT32_MIN;
    d->upload.last_error = INT32_MAX;
    status_page_render(&view);
    assert(heap_bar_width == 0 && queue_bar_width == UI_W - 24);
    assert(strstr(text_at(26), "SSID: ???") && strstr(text_at(26), "..."));
    assert(strstr(text_at(208), "999s+"));
    d->heap_internal_total = d->queue_capacity = 0;
    status_page_render(&view);
    assert(unknown_bar_marks == 41 && !heap_bar_width && !queue_bar_width);
    assert(!strcmp(text_at(114), "Used --%"));
    ui_owner = status_render = false;
}

static void test_domain_pages(void)
{
    cp_status_view_t view = {0};
    cp_debug_domain_t *d = &view.debug.domain;
    strcpy(view.collection, "collecting");
    ui_owner = status_render = true;
    view.page = CP_DEVICE_PAGE_ACTIVITY;
    status_page_render(&view);
    assert(!strcmp(text_at(4), "2/4 BLE activity"));
    assert(!strcmp(text_at(26), "Reports, not people"));
    assert(!strcmp(text_at(48), "Slice unavailable"));
    assert(!strcmp(text_at(136), "Report bins --") && !activity_bars);
    d->known = d->window_partial = d->address_overflow = true;
    d->window_seq = 12; d->window_ms = 16000; d->bin_ms = 1000;
    d->age_ms = 3000; d->bin_count = CP_DEBUG_DOMAIN_BINS;
    d->bin_reports[0] = 1; d->bin_reports[1] = UINT32_MAX;
    d->reports_seen = 123; d->reports_aggregated = 120; d->addresses = 8;
    status_page_render(&view);
    assert(!strcmp(text_at(48), "Slice 12 partial"));
    assert(!strcmp(text_at(70), "Age 3s Window 16s"));
    assert(!strcmp(text_at(92), "Seen 123 Agg 120"));
    assert(!strcmp(text_at(114), "Addr 8 OVERFLOW"));
    assert(activity_bars == 2); // A tiny nonzero bin still gets one pixel.
    d->bin_count = UINT8_MAX; // Corrupt metadata cannot read past 16 bins.
    status_page_render(&view);
    assert(activity_bars == 2);
    d->vehicle_candidates = 3; d->vehicle_name_addresses = 4;
    d->vehicle_ecosystem_addresses = 2; d->vehicle_excluded_addresses = 1;
    d->vehicle_parsed_reports = 120; d->vehicle_malformed_reports = 3;
    view.page = CP_DEVICE_PAGE_VEHICLE;
    status_page_render(&view);
    assert(!strcmp(text_at(26), "Candidates, not truth"));
    assert(!strcmp(text_at(70), "Age3s Addr8 OVF"));
    assert(!strcmp(text_at(92), "Candidates 3"));
    assert(!strcmp(text_at(114), "Brand names 4"));
    assert(!strcmp(text_at(136), "Ecosystem 2"));
    assert(!strcmp(text_at(158), "Excluded 1"));
    assert(!strcmp(text_at(202), "Malformed 3"));
    assert(!strcmp(text_at(224), "No local classifier"));
    view.page = CP_DEVICE_PAGE_ELEVATOR;
    status_page_render(&view);
    assert(!strcmp(text_at(26), "Wait: -- (no model)"));
    assert(!strcmp(text_at(92), "-- / -- / --"));
    assert(!strcmp(text_at(158), "Clock unknown"));
    assert(!strcmp(text_at(180), "Epoch -- Est --"));
    d->rssi_samples = 12; d->rssi_min = -90; d->rssi_mean = -65; d->rssi_max = -42;
    view.debug.clock_trusted = view.debug.clock_estimated = true;
    view.debug.clock_epoch = 7; view.debug.clock_uncertainty_ms = 350;
    view.debug.summaries_total = 42;
    status_page_render(&view);
    assert(!strcmp(text_at(92), "-90 / -65 / -42"));
    assert(!strcmp(text_at(158), "Clock estimated"));
    assert(!strcmp(text_at(180), "Epoch 7 Est350ms"));
    assert(!strcmp(text_at(202), "Boot summaries 42"));
    assert(!strcmp(text_at(268), "UP/DOWN: pages"));
    assert(!strcmp(text_at(290), "Hold OK: setup"));
    d->known = false; // Previously observed values must not masquerade as known.
    status_page_render(&view);
    assert(!strcmp(text_at(92), "-- / -- / --"));
    assert(!strcmp(text_at(114), "Samples --"));
    view.setup_active = view.setup_usb = true;
    for (view.page = CP_DEVICE_PAGE_DEBUG; view.page < CP_DEVICE_PAGE_COUNT; view.page++) {
        status_page_render(&view);
        assert(!strcmp(text_at(6), "USB setup") && !text_at(4)[0]);
    }
    view.setup_active = false;
    view.page = (cp_device_page_t)255;
    status_page_render(&view);
    assert(!strcmp(text_at(4), "1/4 DEBUG UP/DOWN"));
    ui_owner = status_render = false;
}

int main(void)
{
    test_startup_and_ingress();
    test_confirmation_ingress_time();
    test_delayed_physical_forwarding();
    test_snapshot_availability();
    test_bounded_status();
    test_debug_dashboard();
    test_domain_pages();
    vQueueDelete(s_input_queue);
    assert(live_queues == 0);
    puts("UI owner, snapshots, setup, debug bounds/metrics, bars and upload freshness: PASS");
    return 0;
}
