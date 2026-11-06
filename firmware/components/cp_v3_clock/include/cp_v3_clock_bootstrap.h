#pragma once
#include "cp_v3_clock.h"
#include "cp_settings.h"
#include "esp_err.h"

/* Only at boot, with no other Wi-Fi/SNTP owner or active collector. NVS must
 * already be initialized without erasure. This entry supports personal/open;
 * PEAP requires the separate explicit NONE entry below.
 * One association, one tentative SNTP hint, up to three fresh nonce probes.
 * All TLS verification stays enabled. No device/MQTT credentials enter HTTP.
 * On success Wi-Fi is stopped and out is trusted; on failure out is zero.
 * Caller must call stop after a cleanup failure before another network owner.
 * Use bootloader_random before any ADC/RF for boot IDs; probe nonces are generated
 * only while Wi-Fi is active. No RTC state is promoted to trusted time. */
esp_err_t cp_v3_clock_bootstrap(const cp_settings_t *settings,
    const uint8_t pinned_spki[91], const char *key_id,
    bool (*cancelled)(void), cp_v3_time_t *out);
/* Only for a caller-validated PEAP profile explicitly choosing no EAP-server
 * verification. This choice applies solely to Wi-Fi EAP, never HTTPS/MQTT TLS.
 * No CA/date workaround: CA-verified PEAP remains a manual USB path. Same
 * ownership, cleanup, signed-time and failure rules as the entry above. */
esp_err_t cp_v3_clock_bootstrap_peap_none(const cp_settings_t *settings,
    const uint8_t pinned_spki[91], const char *key_id,
    bool (*cancelled)(void), cp_v3_time_t *out);
esp_err_t cp_v3_clock_stop(void);
