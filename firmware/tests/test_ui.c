// Exercise actual page sources with a deterministic, finite RTOS scheduler.
// These stubs verify ownership/queue behavior, not real FreeRTOS concurrency,
// SPI timing, font layout, radio behavior or device acceptance.
#include <assert.h>
#include <setjmp.h>
#include <stdlib.h>
#include <string.h>

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
static bool saw_unavailable, saw_collection, saw_battery;

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
    paint(user);
}
void ui_clear(uint16_t color) { (void)color; assert(ui_owner); }
void ui_fill(int x, int y, int width, int height, uint16_t color)
{
    (void)x; (void)y; (void)width; (void)height; (void)color;
    assert(ui_owner);
}
void ui_text(int x, int y, const char *text, uint16_t color)
{
    (void)y; (void)color;
    assert(ui_owner && strlen(text) < 80);
    if (!strcmp(text, "Snapshot unavailable")) saw_unavailable = true;
    if (status_render) {
        for (const unsigned char *p = (const unsigned char *)text; *p; p++) {
            assert(*p >= 32 && *p <= 126);
        }
        assert(x + ui_text_width(text) <= UI_W);
        if (!strcmp(text, "Collection")) saw_collection = true;
        if (!strcmp(text, "Battery: unavailable")) saw_battery = true;
    }
}
int ui_text_width(const char *text) { return (int)strlen(text) * 10; }
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
    ui_owner = status_render = true;
    status_page_render(&view);
    assert(saw_collection && saw_battery);
    const unsigned calls = render_calls;
    status_page_render(NULL);
    assert(render_calls == calls);
    // Setup fields are bounded: an 8-digit PIN, 12-character AP password, and USB view.
    view.setup_active = true;
    status_page_render(&view);
    view.setup_softap = true;
    status_page_render(&view);
    view.setup_usb = true;
    status_page_render(&view);
    assert(render_calls == calls + 3);
    ui_owner = status_render = false;
}

int main(void)
{
    test_startup_and_ingress();
    test_confirmation_ingress_time();
    test_delayed_physical_forwarding();
    test_snapshot_availability();
    test_bounded_status();
    vQueueDelete(s_input_queue);
    assert(live_queues == 0);
    puts("UI owner, failures, queue drops, confirmation time, snapshots and status: PASS");
    return 0;
}
