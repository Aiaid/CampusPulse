#pragma once
#include "cp_settings.h"
#include "cp_v3_evidence.h"
#include "cp_v3_transport.h"
#include "esp_err.h"
typedef struct {
    cp_settings_t settings;
    char origin[128];
    cp_v3_transport_mode_t transport;
    cp_v3_eap_verification_t eap_verification;
    /* CA/domain remain manual USB only. Explicit NONE may be saved separately. */
    char eap_ca_pem[4097], eap_domain[254];
#ifdef CP_V3_BOOTSTRAP_CONTINUOUS
    /* Optional isolated-server test CA over USB; forbidden at CP_API_ORIGIN. */
    char server_ca_pem[4097];
    bool save_startup, startup_reconfigure;
    char clock_key_id[33];
    uint8_t clock_public_spki[91];
#endif
    cp_v3_time_t clock_seed;
    unsigned max_windows;
} trial_bootstrap_t;
/* Physical USB entry. A normal production app may explicitly save the optional
 * startup candidate only after real cloud ACK; this parser performs no NVS I/O. */
esp_err_t trial_bootstrap_wait(const char *node, const char *boot, trial_bootstrap_t *, bool (*cancelled)(void));
void trial_bootstrap_clear(trial_bootstrap_t *);
