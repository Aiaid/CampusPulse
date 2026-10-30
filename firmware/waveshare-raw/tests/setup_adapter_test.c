/* Synthetic-only binding tests: no hardware, NVS, network or task is opened. */
#include "../main/raw_setup_adapter.c"
#include "raw_usb_stream.h"
#include "raw_boot_button.h"
#include "raw_setup_radio.h"
#include <assert.h>
#include <stdlib.h>

static bool allowed, installed, active;
static unsigned starts, validations, saves, quiesces, resumes, writes, network_stops;
static unsigned stop_requests, entry_requests;
static bool power_requested, storage_failed, power_during_validation;
static bool short_write, drain_failure, poll_during_configure_write;
static raw_setup_radio_state_t radio_state = {
    .accepting_reports = true, .scanning = true,
};
static char output[CP_USB_FRAME_MAX + 1], public_status[24];
static cp_provision_submit_fn submit_callback;
static void *submit_context;
static cp_settings_t fixture_settings(void) {
    cp_settings_t s = {.version = CP_SETTINGS_VERSION};
    strcpy(s.node_id, "cp_020000000001"); strcpy(s.ssid, "synthetic-network");
    strcpy(s.password, "synthetic-password"); strcpy(s.device_token, "synthetic-token-00000000000000000000");
    strcpy(s.api_origin, CP_API_ORIGIN); strcpy(s.mqtt_uri, CP_MQTT_PRODUCTION_URI);
    strcpy(s.mqtt_username, "synthetic-user"); strcpy(s.mqtt_password, "synthetic-mqtt-password");
    strcpy(s.mqtt_namespace, "fixture"); return s;
}
esp_err_t esp_efuse_mac_get_default(uint8_t *mac) { memcpy(mac, "\x02\0\0\0\0\x01", 6); return ESP_OK; }
void bootloader_random_enable(void) {}
void bootloader_random_disable(void) {}
void esp_fill_random(void *bytes, size_t n) { memset(bytes, 0x22, n); }
int esp_reset_reason(void) { return 1; }
esp_err_t cp_settings_setup_proof(char proof[33]) { memset(proof, '0', 32); proof[32] = 0; return ESP_OK; }
esp_err_t cp_settings_load(cp_settings_t *out) { memset(out, 0, sizeof *out); return ESP_ERR_NOT_FOUND; }
esp_err_t cp_settings_save(const cp_settings_t *candidate) {
    assert(cp_settings_validate(candidate) && validations == 1 && !active);
    assert(!raw_setup_adapter_power_safe()); ++saves; return ESP_OK;
}
esp_err_t cp_provision_bind_board(const char *board, const char *chip) {
    assert(!strcmp(board, "waveshare-raw") && !strcmp(chip, "esp32s3")); return ESP_OK;
}
esp_err_t cp_provision_bind_context(const char *node, const char *boot, uint32_t reset,
    cp_provision_credential_resolver_fn resolver, void *context) {
    assert(!strcmp(node, "cp_020000000001") && cp_usb_uuid_v4(boot) && reset == 1);
    assert(!resolver(node, NULL, NULL, context)); return ESP_OK;
}
esp_err_t cp_network_init(const char *node, const char *boot) {
    assert(!strcmp(node, "cp_020000000001") && cp_usb_uuid_v4(boot)); return ESP_OK;
}
esp_err_t cp_network_stop(void) { ++network_stops; return ESP_OK; }
esp_err_t cp_provision_start(cp_provision_mode_t mode, const char *node, const char *proof,
    cp_provision_submit_fn submit, void *context) {
    assert(mode == CP_PROVISION_USB && !active && !strcmp(node, "cp_020000000001") && strlen(proof) == 32);
    assert(raw_setup_adapter_begin()); /* A concurrent begin while opening is idempotent. */
    active = true; ++starts; submit_callback = submit; submit_context = context; return ESP_OK;
}
esp_err_t cp_provision_stop(void) { active = false; return ESP_OK; }
void cp_provision_snapshot(cp_provision_snapshot_t *out) {
    memset(out, 0, sizeof *out); out->active = active;
    snprintf(out->state, sizeof out->state, "%s", public_status);
    strcpy(out->attempt_id, "00000000-0000-4000-8000-000000000001");
}
void cp_provision_set_status(const char *state, const char *reason) {
    assert(state && reason); snprintf(public_status, sizeof public_status, "%s", state);
}
void cp_provision_set_diagnostic(const cp_network_diagnostic_t *d, const char *attempt) { assert(d && cp_usb_uuid_v4(attempt)); }
esp_err_t cp_network_validate_candidate_with_progress(const cp_settings_t *candidate,
    uint32_t timeout, cp_network_progress_fn callback, void *context) {
    assert(cp_settings_validate(candidate) && timeout == 120000 && !active);
    assert(!raw_setup_adapter_power_safe());
    ++validations; cp_network_diagnostic_t d = {0}; callback(&d, context);
    if (power_during_validation) power_requested = true;
    return ESP_OK;
}
esp_err_t cp_provision_usb_exchange(const uint8_t *request, size_t length,
    uint8_t **response, size_t *response_length) {
    char text[CP_USB_JSON_MAX + 1]; assert(length <= CP_USB_JSON_MAX);
    memcpy(text, request, length); text[length] = 0;
    const char *reply = "{\"v\":1,\"ok\":true}";
    if (!active) reply = "{\"v\":1,\"ok\":false,\"reason\":\"setup_not_ready\"}";
    else if (strstr(text, "configure")) {
        cp_settings_t s = fixture_settings();
        assert(submit_callback(&s, "00000000-0000-4000-8000-000000000001", submit_context) == ESP_OK);
        cp_settings_clear_sensitive(&s);
        reply = "{\"v\":1,\"ok\":true,\"state\":\"received\"}";
    }
    *response_length = strlen(reply); *response = malloc(*response_length);
    assert(*response); memcpy(*response, reply, *response_length); return ESP_OK;
}
bool usb_serial_jtag_is_driver_installed(void) { return installed; }
esp_err_t usb_serial_jtag_driver_install(usb_serial_jtag_driver_config_t *config) {
    assert(config->tx_buffer_size >= CP_USB_FRAME_MAX && config->rx_buffer_size >= CP_USB_FRAME_MAX);
    installed = true; return ESP_OK;
}
esp_err_t usb_serial_jtag_driver_uninstall(void) { installed = false; return ESP_OK; }
void usb_serial_jtag_vfs_use_driver(void) {}
void usb_serial_jtag_vfs_use_nonblocking(void) {}
int usb_serial_jtag_write_bytes(const void *frame, size_t length, TickType_t timeout) {
    assert(length <= CP_USB_FRAME_MAX && timeout == 100); ++writes;
    memcpy(output, frame, length); output[length] = 0;
    if (poll_during_configure_write && strstr(output, "received")) {
        /* Earlier info/begin replies must not authorize this candidate while
         * its own response is still inside the USB write function. */
        assert(!s_complete_generation && !validations && !saves);
        assert(poll_setup() == ESP_OK && !validations && !saves);
        assert(s_setup.candidate_pending && !s_setup.reply_finished);
    }
    return short_write ? (int)length / 2 : (int)length;
}
esp_err_t usb_serial_jtag_wait_tx_done(TickType_t timeout) {
    assert(timeout == 100); return drain_failure ? ESP_ERR_TIMEOUT : ESP_OK;
}
int xTaskCreate(void (*entry)(void *), const char *name, unsigned stack, void *arg,
                unsigned priority, TaskHandle_t *handle) {
    (void)arg; (void)handle;
    assert(entry == worker && !strcmp(name, "raw_setup") && stack == 8192 && priority == 3);
    return pdPASS; /* Never execute the infinite worker on the host. */
}
void vTaskDelay(TickType_t ticks) { (void)ticks; assert(false); }
static bool can_begin(void *ctx) { (void)ctx; return allowed && !power_requested && !storage_failed; }
static bool request_entry(void *ctx) {
    (void)ctx;
    if (power_requested || (allowed && storage_failed)) return false;
    ++entry_requests; return true; /* No STOP, radio or storage work on transport. */
}
static raw_setup_entry_t poll_entry(void *ctx, esp_err_t *error) {
    (void)ctx;
    if (power_requested) { *error = ESP_ERR_INVALID_STATE; return RAW_SETUP_ENTRY_FAILED; }
    if (!radio_state.stop_requested) {
        ++stop_requests;
        radio_state.stop_requested = true;
        radio_state.accepting_reports = radio_state.scanning = false;
    }
    if (!allowed) return RAW_SETUP_ENTRY_WAIT;
    radio_state.writer_done = true;
    if (storage_failed) { *error = ESP_FAIL; return RAW_SETUP_ENTRY_FAILED; }
    radio_state.storage_safe = true;
    return RAW_SETUP_ENTRY_READY;
}
static esp_err_t quiesce_board(void *ctx) {
    (void)ctx; assert(allowed); ++quiesces; return raw_setup_radio_admit(&radio_state);
}
static esp_err_t remain_stopped(void *ctx) { (void)ctx; ++resumes; return ESP_OK; }
static void send(raw_usb_stream_t *stream, const char *json) {
    uint8_t frame[CP_USB_FRAME_MAX]; size_t length;
    assert(cp_usb_frame_encode("00000000-0000-4000-8000-000000000002",
        (const uint8_t *)json, strlen(json), frame, sizeof frame, &length));
    for (size_t i = 0; i < length; ++i)
        raw_usb_stream_feed(stream, frame + i, 1, NULL, raw_setup_adapter_receive, NULL);
    cp_usb_secure_clear(frame, sizeof frame);
}
static void button_tests(void) {
    raw_boot_button_t b = {0};
    for (unsigned i = 0; i < 10; ++i) assert(raw_boot_button_poll(&b, true, i * 20, true) == RAW_BOOT_NONE);
    assert(raw_boot_button_poll(&b, false, 200, true) == RAW_BOOT_NONE);
    assert(raw_boot_button_poll(&b, false, 220, true) == RAW_BOOT_NONE);
    assert(raw_boot_button_poll(&b, false, 240, true) == RAW_BOOT_PAGE);
    for (unsigned i = 0; i < 100; ++i) assert(raw_boot_button_poll(&b, true, 1000 + i * 20, true) == RAW_BOOT_NONE);
    assert(raw_boot_button_poll(&b, true, 3000, true) == RAW_BOOT_SETUP);
    assert(raw_boot_button_poll(&b, true, 5000, true) == RAW_BOOT_NONE);
    for (unsigned i = 0; i < 3; ++i) assert(raw_boot_button_poll(&b, false, 5020 + i * 20, true) == RAW_BOOT_NONE);
    assert(raw_boot_button_poll(&b, true, 6000, true) == RAW_BOOT_NONE);
    for (unsigned i = 0; i < 3; ++i) assert(raw_boot_button_poll(&b, false, 6020 + i * 20, true) == RAW_BOOT_NONE);
    /* No enabled capability: a long hold never starts setup. */
    for (unsigned i = 0; i < 200; ++i) assert(raw_boot_button_poll(&b, true, 7000 + i * 20, false) == RAW_BOOT_NONE);
    assert(raw_boot_button_poll(&b, false, 11000, false) == RAW_BOOT_NONE);
    assert(raw_boot_button_poll(&b, false, 11020, false) == RAW_BOOT_NONE);
    assert(raw_boot_button_poll(&b, false, 11040, false) == RAW_BOOT_PAGE);
}
int main(int argc, char **argv) {
    short_write = argc == 2 && !strcmp(argv[1], "short-write");
    drain_failure = argc == 2 && !strcmp(argv[1], "drain-failure");
    poll_during_configure_write = argc == 2 && !strcmp(argv[1], "back-to-back");
    power_during_validation = argc == 2 && !strcmp(argv[1], "power-before-save");
    button_tests();
    raw_setup_board_t board = {.request_entry = request_entry, .poll_entry = poll_entry,
                               .can_begin = can_begin, .quiesce_radio = quiesce_board,
                               .remain_stopped = remain_stopped};
    assert(raw_setup_adapter_prepare(&board) == ESP_OK);
    assert(!starts && !validations && !saves && !network_stops); /* Never auto-connect. */
    raw_usb_stream_t stream; raw_usb_stream_init(&stream);
    if (argc == 2 && !strcmp(argv[1], "power-before-begin")) {
        power_requested = true;
        send(&stream, "{\"v\":1,\"op\":\"begin\"}");
        assert(strstr(output, "supervisor_busy") && !stop_requests && !s_entry_pending);
        return 0;
    }
    send(&stream, "{\"v\":1,\"op\":\"begin\"}");
    assert(strstr(output, "starting") && !starts && !quiesces && !stop_requests);
    assert(raw_setup_adapter_begin()); /* Physical request coalesces with framed request. */
    send(&stream, "{\"v\":1,\"op\":\"begin\"}");
    assert(strstr(output, "starting") && !stop_requests);
    assert(poll_setup() == ESP_OK && stop_requests == 1 && !starts && !quiesces);
    assert(poll_setup() == ESP_OK && stop_requests == 1 && !starts);
    raw_setup_snapshot_t stopping;
    assert(raw_setup_adapter_snapshot(&stopping) && stopping.entry_pending && stopping.state == RAW_SETUP_ENTERING);
    send(&stream, "{\"v\":1,\"op\":\"info\"}");
    assert(strstr(output, "setup_not_ready") && !validations && !saves);
    allowed = true;
    bool stop_failed = argc == 2 && !strcmp(argv[1], "stop-failed");
    bool power_race = argc == 2 && !strcmp(argv[1], "power-race");
    if (stop_failed || power_race) {
        storage_failed = stop_failed; power_requested = power_race;
        assert(poll_setup() != ESP_OK && !starts && !quiesces && !validations && !saves && !network_stops);
        assert(!s_entry_pending && raw_setup_adapter_power_safe());
        send(&stream, "{\"v\":1,\"op\":\"info\"}");
        assert(strstr(output, "raw_stop_failed"));
        send(&stream, "{\"v\":1,\"op\":\"begin\"}");
        assert(strstr(output, "supervisor_busy") && stop_requests == 1);
        puts("Adapter: failed STOP/power race rejects entry before session/network/save");
        return 0;
    }
    bool radio_refused = argc == 2 && !strcmp(argv[1], "callbacks-pending");
    if (radio_refused) radio_state.callbacks = 1;
    assert(!starts && !validations && !raw_setup_adapter_power_safe());
    if (radio_refused) {
        assert(poll_setup() == ESP_ERR_INVALID_STATE);
        assert(!starts && !validations && !saves && !network_stops);
        raw_setup_snapshot_t rejected;
        assert(raw_setup_adapter_snapshot(&rejected) && rejected.state == RAW_SETUP_FAULT);
        assert(radio_state.callbacks == 1 && !radio_state.scanning);
        puts("Adapter: pending radio callback refuses setup without network or save");
        return 0;
    }
    assert(poll_setup() == ESP_OK && starts == 1 && quiesces == 1);
    send(&stream, "{\"v\":1,\"op\":\"begin\"}");
    assert(strstr(output, "starting"));
    assert(poll_setup() == ESP_OK && starts == 1); /* Same session/nonce. */
    if (argc == 2 && !strcmp(argv[1], "expired")) {
        strcpy(public_status, "expired");
        raw_setup_snapshot_t expired;
        assert(raw_setup_adapter_snapshot(&expired) && expired.state == RAW_SETUP_FAILED);
        send(&stream, "{\"v\":1,\"op\":\"begin\"}");
        assert(strstr(output, "starting"));
        assert(poll_setup() == ESP_OK && starts == 2);
    }
    if (poll_during_configure_write) {
        send(&stream, "{\"v\":1,\"op\":\"info\"}");
        /* Deliberately do not run worker between info and configure. */
    }
    send(&stream, "{\"v\":1,\"op\":\"configure\"}");
    assert(!validations && !saves && s_setup.candidate_pending);
    bool power_before_validation = argc == 2 && !strcmp(argv[1], "power-before-validation");
    if (power_before_validation || power_during_validation) {
        if (power_before_validation) power_requested = true;
        assert(poll_setup() == ESP_ERR_INVALID_STATE && !saves);
        assert(validations == (power_during_validation ? 1u : 0u));
        assert(!s_setup.candidate_pending && raw_setup_adapter_power_safe());
        assert(!strcmp(public_status, "failed"));
        puts("Adapter: power request prevents a new validation or local save");
        return 0;
    }
    if (short_write || drain_failure) {
        assert(!s_setup.reply_finished);
        assert(poll_setup() == ESP_OK && !validations && !saves && resumes == 1);
        assert(!strcmp(public_status, "failed") && !s_setup.candidate_pending);
        for (size_t i = 0; i < sizeof s_setup.pending; ++i) assert(((uint8_t *)&s_setup.pending)[i] == 0);
        assert(raw_setup_adapter_power_safe());
        puts("Adapter: failed USB write/drain securely cancels before any network/save");
        return 0;
    }
    assert(poll_setup() == ESP_OK && validations == 1 && saves == 1 && resumes == 1);
    assert(!strcmp(public_status, "saved") && raw_setup_adapter_power_safe());
    assert(s_generation == 1 && !s_setup.candidate_pending);
    cp_settings_t resolved;
    assert(resolve(s_node, &resolved, NULL, NULL) && cp_settings_validate(&resolved));
    cp_settings_clear_sensitive(&resolved);
    for (size_t i = 0; i < sizeof s_response; ++i) assert(s_response[i] == 0);
    for (size_t i = 0; i < sizeof s_frame; ++i) assert(s_frame[i] == 0);
    puts("Adapter: offline admission, one reader, idempotent wizard begin, async save, buttons passed");
    return 0;
}
