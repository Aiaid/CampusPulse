/* Runs actual cp_app startup/supervisor source with a finite deterministic task
 * harness. This verifies control flow, ownership, failure cleanup and status;
 * it does not prove FreeRTOS scheduling, radio behavior or device acceptance. */
#include <assert.h>
#include <setjmp.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "../components/cp_esp/app.c"

typedef struct {
    unsigned capacity, head, length;
    size_t item_size;
    cp_input_event_t slots[16];
} fake_queue_t;

static const cp_board_profile_t test_profile = {
    .board_id = "host_board", .revision = "synthetic", .target_chip = "host",
    .capabilities = CP_CAP_BLE_SCAN | CP_CAP_DISPLAY | CP_CAP_INPUT,
    .max_addresses = 32, .ingress_queue_bytes = 1024,
    .max_collection_lease_ms = 1000
};
static bool fail_queue, fail_task, display_ready, input_ready;
static esp_err_t factory_error, board_error, scanner_error;
static unsigned live_queues, queue_creations, queue_deletions;
static unsigned task_creations, task_deletions, board_calls, factory_calls;
static unsigned scanner_calls, diagnostic_ui_calls, diagnostic_inputs;
static unsigned status_calls, battery_calls, barrier_waits;
static unsigned receive_calls;
static unsigned runtime_prepare_calls, runtime_start_calls, runtime_snapshot_calls;
static unsigned runtime_setup_calls, runtime_resume_calls;
static esp_err_t runtime_prepare_error, runtime_start_error;
static cp_provision_mode_t requested_setup_mode;
static cp_runtime_snapshot_t runtime_view;
static unsigned usb_start_calls;
static cp_usb_begin_fn usb_begin_handler;
static void *usb_begin_context;
static bool usb_worker_running;
static bool task_running, running_before_boot;
static void (*task_entry)(void *);
static void *task_context;
static cp_input_handler_t input_handler;
static void *input_context;
static cp_input_event_t last_diagnostic_input;
static cp_board_view_t last_view;
static int64_t now_us;
static jmp_buf scheduler_exit;

static void run_one_supervisor_round(bool before_boot)
{
    assert(task_entry && !task_running);
    task_running = true;
    running_before_boot = before_boot;
    receive_calls = 0;
    if (setjmp(scheduler_exit) == 0) task_entry(task_context);
    task_running = false;
}

int64_t esp_timer_get_time(void) { return now_us; }
const char *esp_err_to_name(esp_err_t error) { (void)error; return "synthetic_error"; }

QueueHandle_t xQueueCreate(unsigned capacity, size_t item_size)
{
    assert(!board_calls && !input_handler); /* No callbacks before allocation. */
    if (fail_queue) return NULL;
    fake_queue_t *q = calloc(1, sizeof *q);
    assert(q && capacity == 16 && item_size == sizeof(cp_input_event_t));
    q->capacity = capacity;
    q->item_size = item_size;
    queue_creations++;
    live_queues++;
    return q;
}

void vQueueDelete(QueueHandle_t handle)
{
    assert(handle && live_queues);
    live_queues--;
    queue_deletions++;
    free(handle);
}

int xQueueSend(QueueHandle_t handle, const void *item, TickType_t wait)
{
    assert(handle && wait == 0);
    fake_queue_t *q = handle;
    if (q->length == q->capacity) return pdFALSE;
    q->slots[(q->head + q->length) % q->capacity] = *(const cp_input_event_t *)item;
    q->length++;
    return pdTRUE;
}

int xQueueReceive(QueueHandle_t handle, void *item, TickType_t wait)
{
    assert(task_running && !running_before_boot && s_boot_ready);
    assert(handle && wait == pdMS_TO_TICKS(500));
    if (receive_calls++ == 1) longjmp(scheduler_exit, 1);
    fake_queue_t *q = handle;
    now_us += 500000;
    if (!q->length) return pdFALSE;
    memcpy(item, &q->slots[q->head], q->item_size);
    q->head = (q->head + 1) % q->capacity;
    q->length--;
    return pdTRUE;
}

int xTaskCreate(void (*entry)(void *), const char *name, unsigned stack,
                void *context, unsigned priority, TaskHandle_t *out)
{
    assert(!board_calls && !input_handler && live_queues == 1);
    assert(!strcmp(name, "cp_supervisor") && stack && priority);
    if (fail_task) return pdFALSE;
    task_entry = entry;
    task_context = context;
    task_creations++;
    *out = &task_creations;
    /* Simulate immediate preemption before xTaskCreate returns. */
    run_one_supervisor_round(true);
    return pdPASS;
}

void vTaskDelete(TaskHandle_t task)
{
    assert(task && !task_running);
    task_deletions++;
    task_entry = NULL;
    task_context = NULL;
}

void vTaskDelay(TickType_t delay)
{
    assert(task_running && running_before_boot && !s_boot_ready);
    assert(delay == pdMS_TO_TICKS(10));
    assert(!status_calls && !battery_calls && !diagnostic_inputs);
    barrier_waits++;
    longjmp(scheduler_exit, 1);
}

esp_err_t cp_usb_start(cp_usb_begin_fn begin, void *context)
{
    assert(board_calls == 1 && runtime_start_calls == 1 && !s_boot_ready && begin);
    assert(!runtime_setup_calls); /* Installing a console must not enter setup. */
    ++usb_start_calls;usb_begin_handler = begin;usb_begin_context = context;
    return ESP_OK;
}

esp_err_t cp_runtime_prepare(const char *node, const cp_board_profile_t *profile)
{
    /* Entropy/NVS preparation precedes board initialization, which may enable ADC. */
    assert(!board_calls && !s_boot_ready && profile == &test_profile);
    assert(!strcmp(node, "cp_0001abcdef42"));
    runtime_prepare_calls++;
    return runtime_prepare_error;
}

esp_err_t cp_runtime_start(void)
{
    assert(board_calls == 1 && runtime_prepare_calls && !s_boot_ready);
    assert(s_task && live_queues == 1 && input_handler);
    runtime_start_calls++;
    return runtime_start_error;
}

void cp_runtime_snapshot(cp_runtime_snapshot_t *out)
{
    assert(task_running && !running_before_boot && s_boot_ready && out);
    runtime_snapshot_calls++;
    *out = runtime_view;
}

bool cp_runtime_request_setup(cp_provision_mode_t mode)
{
    assert((task_running || usb_worker_running) && s_boot_ready);
    assert(mode == CP_PROVISION_BLE || mode == CP_PROVISION_SOFTAP || mode == CP_PROVISION_USB);
    requested_setup_mode = mode;
    runtime_setup_calls++;
    return true;
}

bool cp_runtime_request_resume(void)
{
    assert(task_running && s_boot_ready);
    runtime_resume_calls++;
    return true;
}

const cp_board_profile_t *cp_board_profile(void) { return &test_profile; }
esp_err_t cp_board_factory_mac(uint8_t mac[6])
{
    factory_calls++;
    if (factory_error != ESP_OK) return factory_error;
    const uint8_t synthetic_mac[6] = {0x00, 0x01, 0xab, 0xcd, 0xef, 0x42};
    memcpy(mac, synthetic_mac, sizeof synthetic_mac);
    return ESP_OK;
}

esp_err_t cp_board_initialize(cp_board_health_t *health,
                             cp_input_handler_t handler, void *context)
{
    assert(live_queues == 1 && s_task && task_entry);
#if !CONFIG_CP_LEGACY_RADAR_DIAGNOSTICS
    assert(runtime_prepare_calls && !runtime_start_calls);
#else
    assert(!runtime_prepare_calls && !runtime_start_calls);
#endif
    assert(!s_boot_ready && !scanner_calls && !status_calls);
    board_calls++;
    /* Simulate preemption while hardware initialization is incomplete. */
    run_one_supervisor_round(true);
    if (board_error != ESP_OK) return board_error;
    input_handler = handler;
    input_context = context;
    *health = (cp_board_health_t) {
        .display_ready = display_ready, .input_ready = input_ready,
        .display_error = display_ready ? ESP_OK : ESP_ERR_NOT_SUPPORTED,
        .input_error = input_ready ? ESP_OK : ESP_ERR_NOT_SUPPORTED,
        .battery_error = ESP_ERR_NOT_SUPPORTED
    };
    return ESP_OK;
}

int cp_board_battery_percent(void)
{
    assert(task_running && s_boot_ready);
    battery_calls++;
    return -1;
}

void cp_board_present(const cp_board_view_t *view)
{
    assert(task_running && s_boot_ready && !s_diagnostic_ui);
    assert(view && view->battery_percent == -1);
    last_view = *view;
    status_calls++;
}

esp_err_t scan_ble_start(void)
{
    assert(board_calls == 1 && !s_boot_ready);
    scanner_calls++;
    return scanner_error;
}

esp_err_t cp_board_start_diagnostic_ui(void)
{
    assert(scanner_calls == 1 && !s_boot_ready);
    diagnostic_ui_calls++;
    return display_ready ? ESP_OK : ESP_ERR_NOT_SUPPORTED;
}

void cp_board_diagnostic_input(const cp_input_event_t *event)
{
    assert(task_running && s_boot_ready && s_diagnostics);
    diagnostic_inputs++;
    last_diagnostic_input = *event;
}

static void reset_fixture(void)
{
    if (s_task) vTaskDelete(s_task);
    if (s_input) vQueueDelete(s_input);
    assert(!live_queues);
    s_task = NULL;
    s_input = NULL;
    s_boot_ready = s_diagnostics = s_diagnostic_ui = false;
    s_input_drops = 0;
    memset(&s_core, 0, sizeof s_core);
    memset(s_node_id, 0, sizeof s_node_id);
    fail_queue = fail_task = display_ready = input_ready = false;
    runtime_prepare_calls = runtime_start_calls = runtime_snapshot_calls = 0;
    runtime_setup_calls = runtime_resume_calls = 0;
    usb_start_calls = 0;usb_begin_handler = NULL;usb_begin_context = NULL;usb_worker_running = false;
    runtime_prepare_error = runtime_start_error = ESP_OK;
    requested_setup_mode = CP_PROVISION_BLE;
    memset(&runtime_view, 0, sizeof runtime_view);
    runtime_view.prepared = true;
    runtime_view.pipeline.storage_ready = true;
    runtime_view.collection = CP_COLLECTION_NEEDS_SETUP;
#if !CONFIG_CP_LEGACY_RADAR_DIAGNOSTICS
    s_runtime_error = ESP_OK;
#endif
    factory_error = board_error = scanner_error = ESP_OK;
    queue_creations = queue_deletions = task_creations = task_deletions = 0;
    board_calls = factory_calls = scanner_calls = diagnostic_ui_calls = 0;
    diagnostic_inputs = status_calls = battery_calls = barrier_waits = 0;
    task_entry = NULL;
    task_context = NULL;
    input_handler = NULL;
    input_context = NULL;
    task_running = running_before_boot = false;
    now_us = 1000000;
    memset(&last_view, 0, sizeof last_view);
}

static void test_allocation_failures_before_callbacks(void)
{
    reset_fixture();
    fail_queue = true;
    assert(cp_app_start() == ESP_ERR_NO_MEM);
    assert(!board_calls && !input_handler && !live_queues && !s_task);
    fail_queue = false;
    fail_task = true;
    assert(cp_app_start() == ESP_ERR_NO_MEM);
    assert(!board_calls && !input_handler && !live_queues && !s_input && !s_task);
    assert(queue_creations == 1 && queue_deletions == 1);
    fail_task = false;
    assert(cp_app_start() == ESP_OK); /* Actual retry succeeds after cleanup. */
    assert(board_calls == 1 && live_queues == 1 && barrier_waits == 2);
}

static void test_factory_failure_and_essential_init_cleanup(void)
{
    reset_fixture();
    factory_error = ESP_ERR_NOT_SUPPORTED;
    assert(cp_app_start() == ESP_ERR_NOT_SUPPORTED);
    assert(!queue_creations && !task_creations && !board_calls);
    factory_error = ESP_OK;
    board_error = ESP_ERR_INVALID_STATE;
    assert(cp_app_start() == ESP_ERR_INVALID_STATE);
    assert(queue_deletions == 1 && task_deletions == 1 && !live_queues);
    assert(!s_task && !s_input && !s_boot_ready && !input_handler && !scanner_calls);
}

static void test_optional_failures_identity_and_idempotence(void)
{
    reset_fixture();
    assert(cp_app_start() == ESP_OK); /* Both display and input fail. */
    assert(s_boot_ready && task_creations == 1 && board_calls == 1);
    assert(barrier_waits == 2 && status_calls == 0);
    assert(!strcmp(s_node_id, "cp_0001abcdef42"));
    assert(s_core.identity == CP_IDENTITY_FACTORY && s_core.ui == CP_UI_DEGRADED);
    assert(s_core.auth == CP_AUTH_UNKNOWN && s_core.policy_state == CP_POLICY_NONE);
    assert(!cp_collection_allowed(cp_core_decide(&s_core, (uint64_t)now_us / 1000)));
    assert(cp_app_start() == ESP_OK);
    assert(task_creations == 1 && board_calls == 1 && factory_calls == 1);
#if !CONFIG_CP_LEGACY_RADAR_DIAGNOSTICS
    assert(runtime_prepare_calls == 1 && runtime_start_calls == 1 && usb_start_calls == 1);
#else
    assert(!runtime_prepare_calls && !runtime_start_calls);
#endif
    assert(input_handler);
    const cp_input_event_t event = {
        .button = CP_BUTTON_OK, .kind = CP_INPUT_CLICK, .monotonic_ms = 234
    };
    input_handler(&event, input_context);
    assert(!status_calls && !diagnostic_inputs);
    run_one_supervisor_round(false);
    assert(status_calls == 1 && !strcmp(last_view.node_id, "cp_0001abcdef42"));
    assert(!strcmp(last_view.authentication, "NOT ENROLLED"));
    assert(!strcmp(last_view.policy, "WAITING FOR CONFIG"));
#if CONFIG_CP_LEGACY_RADAR_DIAGNOSTICS
    assert(scanner_calls == 1 && diagnostic_ui_calls == 1 && s_diagnostics);
    assert(!s_diagnostic_ui && diagnostic_inputs == 0);
    assert(!strcmp(last_view.collection, "LOCAL DIAGNOSTICS"));
#else
    assert(!scanner_calls && !diagnostic_ui_calls && !diagnostic_inputs);
    assert(!strcmp(last_view.collection, "needs_setup"));
#endif
    /* Queued local input and repeated task ticks never grant enrollment/policy. */
    run_one_supervisor_round(false);
    assert(s_core.identity == CP_IDENTITY_FACTORY && !s_core.lease_valid);
    assert(!cp_collection_allowed(cp_core_decide(&s_core, (uint64_t)now_us / 1000)));
}

static void test_diagnostic_ui_ownership(void)
{
    reset_fixture();
    display_ready = input_ready = true;
    assert(cp_app_start() == ESP_OK);
    assert(s_core.ui == CP_UI_READY && barrier_waits == 2);
    const cp_input_event_t event = {
        .button = CP_BUTTON_DOWN, .kind = CP_INPUT_LONG, .monotonic_ms = 456
    };
    input_handler(&event, input_context);
    run_one_supervisor_round(false);
#if CONFIG_CP_LEGACY_RADAR_DIAGNOSTICS
    assert(s_diagnostic_ui && diagnostic_ui_calls == 1 && scanner_calls == 1);
    assert(!status_calls && !battery_calls && diagnostic_inputs == 1);
    assert(last_diagnostic_input.button == CP_BUTTON_DOWN);
    assert(last_diagnostic_input.kind == CP_INPUT_LONG);
    assert(last_diagnostic_input.monotonic_ms == 456);
#else
    assert(!s_diagnostic_ui && !scanner_calls && !diagnostic_inputs);
    assert(status_calls == 1 && battery_calls == 1);
#endif
}

static void test_scanner_failure_preserves_safe_status(void)
{
    reset_fixture();
    scanner_error = ESP_ERR_INVALID_STATE;
    assert(cp_app_start() == ESP_OK);
    run_one_supervisor_round(false);
    assert(!s_diagnostics && !s_diagnostic_ui && !diagnostic_ui_calls);
    assert(status_calls == 1 && !strcmp(last_view.collection, "needs_setup"));
#if CONFIG_CP_LEGACY_RADAR_DIAGNOSTICS
    assert(scanner_calls == 1);
#else
    assert(!scanner_calls);
#endif
}

static void test_runtime_initialization_failure_status(void)
{
    reset_fixture();
    runtime_prepare_error = ESP_ERR_INVALID_STATE;
    assert(cp_app_start() == ESP_OK);
    run_one_supervisor_round(false);
#if !CONFIG_CP_LEGACY_RADAR_DIAGNOSTICS
    assert(runtime_prepare_calls == 1 && !runtime_start_calls);
    assert(!strcmp(last_view.collection, "RUNTIME ERROR"));
    reset_fixture();
    runtime_start_error = ESP_ERR_NO_MEM;
    assert(cp_app_start() == ESP_OK);
    run_one_supervisor_round(false);
    assert(runtime_prepare_calls == 1 && runtime_start_calls == 1);
    assert(!strcmp(last_view.collection, "RUNTIME ERROR"));
#else
    assert(!runtime_prepare_calls && !runtime_start_calls && !runtime_snapshot_calls);
#endif
}

static void test_runtime_setup_and_resume_input_routes(void)
{
    reset_fixture();
    assert(cp_app_start() == ESP_OK);
#if !CONFIG_CP_LEGACY_RADAR_DIAGNOSTICS
    cp_input_event_t event = {.button = CP_BUTTON_OK, .kind = CP_INPUT_LONG, .monotonic_ms = 100};
    input_handler(&event, input_context);
    run_one_supervisor_round(false);
    assert(runtime_setup_calls == 1 && requested_setup_mode == CP_PROVISION_BLE && !runtime_resume_calls);
    runtime_view.provision.active = true;
    runtime_view.provision.mode = CP_PROVISION_SOFTAP;
    strcpy(runtime_view.provision.service_name, "synthetic-setup");
    strcpy(runtime_view.provision.proof, "test-only-proof");
    strcpy(runtime_view.provision.ap_password, "test-only-password");
    event.button = CP_BUTTON_DOWN; event.kind = CP_INPUT_CLICK;
    input_handler(&event, input_context);
    run_one_supervisor_round(false);
    assert(runtime_setup_calls == 2 && requested_setup_mode == CP_PROVISION_SOFTAP);
    assert(last_view.setup_active && last_view.setup_softap && !strcmp(last_view.setup_name, "synthetic-setup"));
    event.button = CP_BUTTON_OK; event.kind = CP_INPUT_LONG;
    input_handler(&event, input_context);
    run_one_supervisor_round(false);
    assert(runtime_resume_calls == 1 && runtime_setup_calls == 2);
    event.button = CP_BUTTON_UP; event.kind = CP_INPUT_CLICK;
    input_handler(&event, input_context);
    run_one_supervisor_round(false);
    assert(runtime_setup_calls == 3 && requested_setup_mode == CP_PROVISION_BLE);
    assert(!strcmp(last_view.collection, "needs_setup"));
#else
    assert(!runtime_prepare_calls && !runtime_start_calls && !runtime_setup_calls && !runtime_resume_calls);
#endif
}

static void test_actual_capture_and_pressure_status(void)
{
    reset_fixture();
    assert(cp_app_start() == ESP_OK);
#if !CONFIG_CP_LEGACY_RADAR_DIAGNOSTICS
    runtime_view.collection = CP_COLLECTION_ALLOWED;
    run_one_supervisor_round(false);
    assert(!strcmp(last_view.collection, "CAPTURE STOPPED"));
    runtime_view.pipeline.collecting = true;
    run_one_supervisor_round(false);
    assert(!strcmp(last_view.collection, cp_collection_state_name(CP_COLLECTION_ALLOWED)));
    /* An internal warning cannot pause raw capture that was already off. */
    runtime_view.pipeline.memory_raw_paused = true;
    runtime_view.network.policy.raw_enabled = false;
    run_one_supervisor_round(false);
    assert(!strcmp(last_view.collection, cp_collection_state_name(CP_COLLECTION_ALLOWED)));
    runtime_view.network.policy.raw_enabled = true;
    run_one_supervisor_round(false);
    assert(!strcmp(last_view.collection, "RAW MEMORY PAUSED"));
    runtime_view.pipeline.memory_raw_paused = false;
    runtime_view.network.policy.raw_enabled = false;
    runtime_view.pipeline.memory_paused = true;
    runtime_view.network.policy_valid = true;
    runtime_view.collection = CP_COLLECTION_LEASE_EXPIRED;
    run_one_supervisor_round(false);
    assert(!strcmp(last_view.collection, cp_collection_state_name(CP_COLLECTION_LEASE_EXPIRED)));
    runtime_view.pipeline.memory_paused = false;
    runtime_view.collection = CP_COLLECTION_ALLOWED;
    runtime_view.pipeline.collecting = false;
    runtime_view.pipeline.pressure_paused = true;
    run_one_supervisor_round(false);
    assert(!strcmp(last_view.collection, "STORAGE PAUSED"));
    runtime_view.pipeline.storage_ready = false;
    run_one_supervisor_round(false);
    assert(!strcmp(last_view.collection, "JOURNAL UNAVAILABLE"));
#endif
}

static void test_usb_console_is_explicit_and_separate(void)
{
    reset_fixture();
    assert(cp_app_start() == ESP_OK);
#if !CONFIG_CP_LEGACY_RADAR_DIAGNOSTICS
    assert(usb_start_calls == 1 && usb_begin_handler && !runtime_setup_calls);
    usb_worker_running = true;
    assert(usb_begin_handler(usb_begin_context));
    usb_worker_running = false;
    assert(runtime_setup_calls == 1 && requested_setup_mode == CP_PROVISION_USB);
    runtime_view.provision.active = true;runtime_view.provision.mode = CP_PROVISION_USB;
    run_one_supervisor_round(false);
    assert(last_view.setup_usb && !last_view.setup_softap && !last_view.setup_proof[0]);
#else
    assert(!usb_start_calls && !usb_begin_handler);
#endif
}

int main(void)
{
    test_allocation_failures_before_callbacks();
    test_factory_failure_and_essential_init_cleanup();
    test_optional_failures_identity_and_idempotence();
    test_diagnostic_ui_ownership();
    test_scanner_failure_preserves_safe_status();
    test_runtime_initialization_failure_status();
    test_runtime_setup_and_resume_input_routes();
    test_usb_console_is_explicit_and_separate();
    test_actual_capture_and_pressure_status();
    reset_fixture();
    printf("actual cp_app startup/supervisor (diagnostics=%d): 8 host test groups passed\n",
           CONFIG_CP_LEGACY_RADAR_DIAGNOSTICS);
    return 0;
}
