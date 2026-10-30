#pragma once
#include "raw_setup.h"
#include "cp_usb_frame.h"

/* Optional v2-only adapter. Call prepare before RF or ADC initialization.
 * It never starts a network on boot or starts another USB reader. The board
 * request_entry only queues/selects UI; poll_entry runs on the setup worker and
 * completes the existing STOP/drain/sync/unmount before reporting READY.
 * Collection resumes only on a later user restart; no reboot is automatic. */
typedef enum { RAW_SETUP_ENTRY_WAIT, RAW_SETUP_ENTRY_READY, RAW_SETUP_ENTRY_FAILED } raw_setup_entry_t;
typedef struct {
    bool (*request_entry)(void *context);
    raw_setup_entry_t (*poll_entry)(void *context, esp_err_t *error);
    bool (*can_begin)(void *context);
    esp_err_t (*quiesce_radio)(void *context);
    esp_err_t (*remain_stopped)(void *context);
    void (*status)(void *context, raw_setup_state_t state, esp_err_t error);
    void *context;
} raw_setup_board_t;

esp_err_t raw_setup_adapter_prepare(const raw_setup_board_t *);
/* Physical long-press and wizard begin share this idempotent admission path. */
bool raw_setup_adapter_begin(void);
bool raw_setup_adapter_snapshot(raw_setup_snapshot_t *);
void raw_setup_adapter_receive(void *unused, const char request_id[CP_USB_UUID_SIZE],
                                const uint8_t *json, size_t length);
/* A setup session is cancelled asynchronously before a safe power-off. A
 * testing/saving or uncertain-owner state keeps power on until safe teardown. */
bool raw_setup_adapter_power_safe(void);
