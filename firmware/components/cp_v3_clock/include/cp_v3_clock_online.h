#pragma once
#include "cp_v3_clock.h"
#include "esp_err.h"

/* One credential-free, fresh-nonce signed-clock attempt over the network already
 * owned by the caller. Uses the fixed production endpoint and full public-CA,
 * hostname and certificate-date verification. Never changes Wi-Fi/EAP/SNTP or
 * the wall clock; TLS therefore needs the existing trusted wall-clock mapping.
 *
 * Caller is the transport owner, has parked all observation/storage workers,
 * and holds the transport memory lease for this attempt. Release that lease
 * after every return, before waiting/retrying, so MQTT keepalive can run. The
 * absolute attempt deadline is 6000 ms including DNS/TLS; individual SDK calls
 * have a 1000 ms timeout and may overrun the deadline before returning.
 *
 * On success out is the ORIGINAL verified midpoint seed with new_epoch, never
 * a derived-now anchor or policy authority. Adopt it separately at the closed
 * boundary. Every failure zeroes out. No nonce is reused across attempts. */
esp_err_t cp_v3_clock_probe_online(const uint8_t pinned_spki[91],
    const char *key_id, uint32_t new_epoch, bool (*cancelled)(void),
    cp_v3_time_t *out);
