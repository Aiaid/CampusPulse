#pragma once
#include "cp_settings.h"
#include "cp_v3_evidence.h"
#include "esp_err.h"
#include "cp_v3_transport.h"
/* Maximum decoded single certificate, excluding NUL; wire limit includes the
 * V3START prefix and excludes the physical newline. JSON escaping also counts. */
#define TRIAL_BOOTSTRAP_CA_MAX 4096u
#define TRIAL_BOOTSTRAP_LINE_MAX 8191u
typedef struct {
    cp_settings_t settings;
    char origin[128];
    /* Empty selects the existing public bundle. Never persisted or logged. */
    char server_ca_pem[TRIAL_BOOTSTRAP_CA_MAX + 1u];
    /* Manual USB PEAP trust only; never stored in the startup profile. */
    char eap_ca_pem[TRIAL_BOOTSTRAP_CA_MAX + 1u], eap_domain[254];
    cp_v3_time_t clock_seed;
    unsigned max_windows;
    cp_v3_transport_mode_t transport;
    bool save_startup, startup_reconfigure;
    char clock_key_id[33];
    uint8_t clock_public_spki[91];
} trial_bootstrap_t;
/* Physical USB only; parsing performs no persistence or network operation.
 * This path requires fresh trusted host time and matching node/boot. The
 * independent startup store/clock implements explicit saved-profile boot. */
esp_err_t trial_bootstrap_wait(const char *node, const char *boot, trial_bootstrap_t *, bool (*cancelled)(void));
/* A nonzero grace times out only before a valid fresh HELLO or explicit SETUP;
 * either selects physical USB setup until a valid frame or cancellation. */
esp_err_t trial_bootstrap_wait_for(const char *node, const char *boot, trial_bootstrap_t *, bool (*cancelled)(void), uint32_t grace_ms);
void trial_bootstrap_clear(trial_bootstrap_t *);
/* Pure parser with caller-supplied current boot monotonic time. Eleven original
 * fields remain mandatory; current tools also emit uplink_transport. Production
 * defaults to mqtt_tls and requires the four fixed-broker MQTT fields. A supplied
 * CA must be one LF/CRLF PEM X.509 CA certificate (no chain or extra text).
 * Canonical CP_API_ORIGIN requires native MQTT/system bundle and forbids the CA field;
 * production spellings with ports, paths or aliases are not accepted.
 * security selects open/personal/enterprise_peap. Only PEAP admits/requires
 * all five eap_* fields, with password empty and a separate CA/domain binding.
 * PEAP cannot be saved for autonomous startup. Other modes forbid EAP fields,
 * including empty ones. API server trust and EAP trust remain separate.
 * Any failure clears the complete output. Caller owns/wipes the input JSON.
 * Parsing a CA does not validate a server, hostname, date or isolated origin. */
bool trial_bootstrap_parse(const char *json, const char *node, const char *boot,
                          uint64_t mono_ms, trial_bootstrap_t *out);
