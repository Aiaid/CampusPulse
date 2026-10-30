/* Experimental, disabled-by-default binding to the existing v2 USB contract.
 * No TF upload, v3 capture schema, automatic network connection or activation. */
#include "raw_setup_adapter.h"
#include "cp_core.h"
#include "cp_network.h"
#include "cp_provision.h"
#include "cp_usb.h"
#include "bootloader_random.h"
#include "driver/usb_serial_jtag.h"
#include "driver/usb_serial_jtag_vfs.h"
#include "esp_mac.h"
#include "esp_random.h"
#include "esp_system.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static raw_setup_t s_setup;
static raw_setup_board_t s_board;
static cp_settings_t s_saved;
static char s_node[16], s_boot[37], s_proof[33];
static uint32_t s_generation;
static portMUX_TYPE s_saved_lock = portMUX_INITIALIZER_UNLOCKED;
static bool s_ready;
static bool s_reply_failed;
static bool s_entry_pending, s_entry_gate, s_entry_renew;
static esp_err_t s_entry_error;
static uint32_t s_abort_generation, s_complete_generation;
static uint8_t s_response[CP_USB_JSON_MAX], s_frame[CP_USB_FRAME_MAX];

static bool resolve(const char *node, cp_settings_t *out, uint32_t *generation, void *ctx) {
    (void)ctx;
    if (!node || strcmp(node, s_node)) return false;
    portENTER_CRITICAL(&s_saved_lock);
    bool available = s_generation != 0;
    if (available) { if (out) *out = s_saved; if (generation) *generation = s_generation; }
    portEXIT_CRITICAL(&s_saved_lock);
    return available;
}
static esp_err_t quiesce(void *ctx) {
    (void)ctx;
    return s_board.can_begin(s_board.context) ? s_board.quiesce_radio(s_board.context) : ESP_ERR_INVALID_STATE;
}
static esp_err_t resume(void *ctx) { (void)ctx; return s_board.remain_stopped(s_board.context); }
static esp_err_t stop_network(void *ctx) { (void)ctx; return cp_network_stop(); }
static esp_err_t stop_session(void *ctx) { (void)ctx; return cp_provision_stop(); }
static esp_err_t start_session(void *ctx, raw_setup_submit_fn submit, void *submit_context) {
    (void)ctx;
    return cp_provision_start(CP_PROVISION_USB, s_node, s_proof, submit, submit_context);
}
static void progress(const cp_network_diagnostic_t *diagnostic, void *attempt) {
    cp_provision_set_diagnostic(diagnostic, attempt);
}
static esp_err_t validate(void *ctx, const cp_settings_t *candidate, uint32_t timeout) {
    (void)ctx;
    if (!s_board.can_begin(s_board.context)) return ESP_ERR_INVALID_STATE;
    cp_provision_snapshot_t session;
    cp_provision_snapshot(&session);
    return cp_network_validate_candidate_with_progress(candidate, timeout, progress, session.attempt_id);
}
static esp_err_t save(void *ctx, const cp_settings_t *candidate) {
    (void)ctx;
    if (!s_board.can_begin(s_board.context)) return ESP_ERR_INVALID_STATE;
    esp_err_t result = cp_settings_save(candidate);
    if (result == ESP_OK) {
        portENTER_CRITICAL(&s_saved_lock);
        s_saved = *candidate;
        if (++s_generation == 0) s_generation = 1;
        portEXIT_CRITICAL(&s_saved_lock);
    }
    return result;
}
static void status(void *ctx, raw_setup_state_t state, esp_err_t result) {
    (void)ctx;
    const char *phase = "waiting", *reason = "raw_stopped_usb_v2";
    switch (state) {
    case RAW_SETUP_TESTING: phase = "testing"; reason = "wifi_and_cloud"; break;
    case RAW_SETUP_SAVING: phase = "saving"; reason = "local_settings"; break;
    case RAW_SETUP_SAVED: phase = "saved"; reason = "stored_raw_stopped"; break;
    case RAW_SETUP_FAILED: phase = "failed"; reason = "validation_or_save_failed"; break;
    case RAW_SETUP_FAULT: phase = "failed"; reason = "owner_stop_failed"; break;
    default: break;
    }
    if (state == RAW_SETUP_IDLE && __atomic_load_n(&s_reply_failed, __ATOMIC_ACQUIRE)) {
        phase = "failed"; reason = "usb_reply_failed";
        state = RAW_SETUP_FAILED; result = ESP_ERR_TIMEOUT;
    }
    cp_provision_set_status(phase, reason);
    if (s_board.status) s_board.status(s_board.context, state, result);
}
static bool entry_take(void) {
    bool expected = false;
    return __atomic_compare_exchange_n(&s_entry_gate, &expected, true, false,
        __ATOMIC_ACQUIRE, __ATOMIC_RELAXED);
}
static void entry_give(void) { __atomic_store_n(&s_entry_gate, false, __ATOMIC_RELEASE); }
static esp_err_t poll_setup(void) {
    if (__atomic_load_n(&s_entry_pending, __ATOMIC_ACQUIRE)) {
        esp_err_t error = ESP_OK;
        raw_setup_entry_t entry = s_board.poll_entry(s_board.context, &error);
        if (entry == RAW_SETUP_ENTRY_WAIT) return ESP_OK;
        if (!entry_take()) return ESP_ERR_INVALID_STATE;
        if (entry == RAW_SETUP_ENTRY_FAILED) {
            __atomic_store_n(&s_entry_error, error == ESP_OK ? ESP_FAIL : error, __ATOMIC_RELEASE);
            __atomic_store_n(&s_entry_pending, false, __ATOMIC_RELEASE);
            entry_give();
            status(NULL, RAW_SETUP_FAILED, error == ESP_OK ? ESP_FAIL : error);
            return error == ESP_OK ? ESP_FAIL : error;
        }
        raw_setup_snapshot_t view;
        if (!raw_setup_snapshot(&s_setup, &view)) { entry_give(); return ESP_ERR_INVALID_STATE; }
        bool queued = view.state == RAW_SETUP_ENTERING || (view.state == RAW_SETUP_READY && !s_entry_renew) ||
            raw_setup_begin(&s_setup);
        if (!queued) { entry_give(); return ESP_ERR_INVALID_STATE; }
        __atomic_store_n(&s_entry_pending, false, __ATOMIC_RELEASE);
        s_entry_renew = false;
        entry_give();
    }
    uint32_t abort = __atomic_load_n(&s_abort_generation, __ATOMIC_ACQUIRE);
    if (abort) {
        raw_setup_snapshot_t snapshot;
        if (!raw_setup_snapshot(&s_setup, &snapshot)) return ESP_ERR_INVALID_STATE;
        if (snapshot.candidate_generation == abort && snapshot.state == RAW_SETUP_AWAIT_REPLY) {
            __atomic_store_n(&s_reply_failed, true, __ATOMIC_RELEASE);
            if (!raw_setup_cancel(&s_setup)) return ESP_ERR_INVALID_STATE;
        }
        __atomic_store_n(&s_abort_generation, 0, __ATOMIC_RELEASE);
    }
    uint32_t complete = __atomic_load_n(&s_complete_generation, __ATOMIC_ACQUIRE);
    if (complete) {
        raw_setup_snapshot_t snapshot;
        if (!raw_setup_snapshot(&s_setup, &snapshot)) return ESP_ERR_INVALID_STATE;
        if (snapshot.candidate_generation == complete && snapshot.state == RAW_SETUP_AWAIT_REPLY &&
            !raw_setup_reply_finished(&s_setup, complete))
            return ESP_ERR_INVALID_STATE;
        __atomic_store_n(&s_complete_generation, 0, __ATOMIC_RELEASE);
    }
    return raw_setup_poll(&s_setup);
}
static void worker(void *unused) {
    (void)unused;
    for (;;) { (void)poll_setup(); vTaskDelay(pdMS_TO_TICKS(50)); }
}
static bool begin(void *unused) {
    (void)unused;
    return raw_setup_adapter_begin();
}
bool raw_setup_adapter_begin(void) {
    if (!s_ready || !entry_take()) return false;
    raw_setup_snapshot_t snapshot;
    if (!raw_setup_snapshot(&s_setup, &snapshot)) { entry_give(); return false; }
    if (__atomic_load_n(&s_entry_pending, __ATOMIC_ACQUIRE)) {
        bool accepted = s_board.request_entry(s_board.context);
        entry_give(); return accepted;
    }
    if (snapshot.state == RAW_SETUP_ENTERING) {
        bool accepted = s_board.can_begin(s_board.context);
        entry_give(); return accepted;
    }
    /* The existing desktop wizard sends begin after physical entry. Reuse the
     * same waiting session; never rotate its nonce or restart its lifetime. */
    if (snapshot.state == RAW_SETUP_READY) {
        if (!s_board.can_begin(s_board.context)) { entry_give(); return false; }
        cp_provision_snapshot_t session;
        cp_provision_snapshot(&session);
        if (strcmp(session.state, "expired")) {
            bool accepted = s_board.request_entry(s_board.context);
            entry_give(); return accepted;
        }
        /* An explicit new begin may renew an expired waiting session, but
         * healthy waiting sessions above retain their nonce and expiry. */
    }
    bool eligible = snapshot.state == RAW_SETUP_IDLE || snapshot.state == RAW_SETUP_FAILED ||
        snapshot.state == RAW_SETUP_SAVED || snapshot.state == RAW_SETUP_READY;
    bool accepted = eligible && s_board.request_entry(s_board.context);
    if (accepted) {
        s_entry_renew = snapshot.state == RAW_SETUP_READY;
        __atomic_store_n(&s_reply_failed, false, __ATOMIC_RELEASE);
        __atomic_store_n(&s_entry_error, ESP_OK, __ATOMIC_RELEASE);
        __atomic_store_n(&s_entry_pending, true, __ATOMIC_RELEASE);
    }
    entry_give();
    return accepted;
}
bool raw_setup_adapter_snapshot(raw_setup_snapshot_t *snapshot) {
    if (!s_ready || !raw_setup_snapshot(&s_setup, snapshot)) return false;
    snapshot->entry_pending = __atomic_load_n(&s_entry_pending, __ATOMIC_ACQUIRE);
    esp_err_t entry_error = __atomic_load_n(&s_entry_error, __ATOMIC_ACQUIRE);
    if (snapshot->entry_pending) snapshot->state = RAW_SETUP_ENTERING;
    else if (entry_error) { snapshot->state = RAW_SETUP_FAILED; snapshot->last_error = entry_error; }
    if (snapshot->state == RAW_SETUP_IDLE && __atomic_load_n(&s_reply_failed, __ATOMIC_ACQUIRE)) {
        snapshot->state = RAW_SETUP_FAILED; snapshot->last_error = ESP_ERR_TIMEOUT;
    }
    if (snapshot->state == RAW_SETUP_READY) {
        cp_provision_snapshot_t session;
        cp_provision_snapshot(&session);
        if (!strcmp(session.state, "expired")) {
            snapshot->state = RAW_SETUP_FAILED; snapshot->last_error = ESP_ERR_TIMEOUT;
        }
    }
    return true;
}
static void boot_id(void) {
    uint8_t bytes[16];
    bootloader_random_enable(); esp_fill_random(bytes, sizeof bytes); bootloader_random_disable();
    bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
    snprintf(s_boot, sizeof s_boot,
        "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
        bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
        bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]);
    cp_usb_secure_clear(bytes, sizeof bytes);
}
esp_err_t raw_setup_adapter_prepare(const raw_setup_board_t *board) {
    if (!board || !board->request_entry || !board->poll_entry || !board->can_begin ||
        !board->quiesce_radio || !board->remain_stopped || s_ready)
        return ESP_ERR_INVALID_ARG;
    s_board = *board;
    uint8_t mac[6];
    esp_err_t result = esp_efuse_mac_get_default(mac);
    if (result == ESP_OK && !cp_node_id_from_base_mac(mac, s_node, sizeof s_node)) result = ESP_ERR_INVALID_STATE;
    cp_usb_secure_clear(mac, sizeof mac);
    if (result == ESP_OK) result = cp_settings_setup_proof(s_proof);
    if (result != ESP_OK) goto failed;
    boot_id();
    result = cp_settings_load(&s_saved);
    if (result == ESP_OK && !strcmp(s_saved.node_id, s_node)) s_generation = 1;
    else if (result == ESP_ERR_NOT_FOUND || result == ESP_OK) {
        cp_settings_clear_sensitive(&s_saved); result = ESP_OK;
    }
    if (result == ESP_OK) result = cp_provision_bind_board("waveshare-raw", "esp32s3");
    if (result == ESP_OK) result = cp_provision_bind_context(s_node, s_boot, (uint32_t)esp_reset_reason(), resolve, NULL);
    if (result == ESP_OK) result = cp_network_init(s_node, s_boot);
    raw_setup_ops_t ops = {.quiesce_radio = quiesce, .resume_radio = resume,
        .stop_network = stop_network, .start_session = start_session, .stop_session = stop_session,
        .validate_candidate = validate, .save_settings = save, .status = status};
    if (result == ESP_OK) result = raw_setup_init(&s_setup, s_node, &ops, 120000);
    if (result != ESP_OK) goto failed;
    if (usb_serial_jtag_is_driver_installed()) { result = ESP_ERR_INVALID_STATE; goto failed; }
    usb_serial_jtag_driver_config_t config = {.tx_buffer_size = 4096, .rx_buffer_size = 2048};
    result = usb_serial_jtag_driver_install(&config);
    if (result != ESP_OK) goto failed;
    usb_serial_jtag_vfs_use_driver();
    if (xTaskCreate(worker, "raw_setup", 8192, NULL, 3, NULL) != pdPASS) {
        usb_serial_jtag_vfs_use_nonblocking(); (void)usb_serial_jtag_driver_uninstall();
        result = ESP_ERR_NO_MEM; goto failed;
    }
    s_ready = true;
    return ESP_OK;
failed:
    cp_settings_clear_sensitive(&s_saved); cp_usb_secure_clear(s_proof, sizeof s_proof);
    s_generation = 0;
    return result;
}
static esp_err_t exchange(const uint8_t *request, size_t length, uint8_t **response, size_t *response_length) {
    if (__atomic_load_n(&s_entry_error, __ATOMIC_ACQUIRE)) {
        static const char failure[] = "{\"v\":1,\"ok\":false,\"reason\":\"raw_stop_failed\"}";
        *response_length = sizeof failure - 1;
        *response = malloc(*response_length);
        if (!*response) return ESP_ERR_NO_MEM;
        memcpy(*response, failure, *response_length);
        return ESP_OK;
    }
    return cp_provision_usb_exchange(request, length, response, response_length);
}
void raw_setup_adapter_receive(void *unused, const char request_id[CP_USB_UUID_SIZE],
                                const uint8_t *json, size_t length) {
    (void)unused;
    if (!s_ready) return;
    size_t response_length = 0, frame_length = 0;
    bool delivered = false;
    uint32_t before = raw_setup_candidate_generation(&s_setup);
    esp_err_t result = cp_usb_control(begin, NULL, exchange, json, length,
        s_response, sizeof s_response, &response_length);
    uint32_t after = raw_setup_candidate_generation(&s_setup);
    bool produced_candidate = after != before;
    if (result == ESP_OK && cp_usb_frame_encode(request_id, s_response, response_length,
                                               s_frame, sizeof s_frame, &frame_length)) {
        /* One bounded native driver write, shared by VFS console logging. */
        if (usb_serial_jtag_write_bytes(s_frame, frame_length, pdMS_TO_TICKS(100)) == (int)frame_length)
            delivered = usb_serial_jtag_wait_tx_done(pdMS_TO_TICKS(100)) == ESP_OK;
    }
    cp_usb_secure_clear(s_response, sizeof s_response); cp_usb_secure_clear(s_frame, sizeof s_frame);
    if (produced_candidate) {
        if (delivered) __atomic_store_n(&s_complete_generation, after, __ATOMIC_RELEASE);
        else /* Correlate cancellation with this exchange's candidate only. */
            __atomic_store_n(&s_abort_generation, after, __ATOMIC_RELEASE);
    }
}
bool raw_setup_adapter_power_safe(void) {
    if (!s_ready) return true;
    if (__atomic_load_n(&s_entry_pending, __ATOMIC_ACQUIRE)) return false;
    raw_setup_snapshot_t snapshot;
    if (!raw_setup_snapshot(&s_setup, &snapshot)) return false;
    if (snapshot.state == RAW_SETUP_READY || snapshot.state == RAW_SETUP_AWAIT_REPLY ||
        snapshot.state == RAW_SETUP_FAULT) {
        (void)raw_setup_cancel(&s_setup); return false;
    }
    return snapshot.state == RAW_SETUP_IDLE || snapshot.state == RAW_SETUP_SAVED ||
           snapshot.state == RAW_SETUP_FAILED;
}
