#pragma once
#include "cp_settings.h"
#include "cp_v3_evidence.h"
#include "esp_err.h"
/* Maximum decoded single certificate, excluding NUL; wire limit includes the
 * V3START prefix and excludes the physical newline. JSON escaping also counts. */
#define TRIAL_BOOTSTRAP_CA_MAX 4096u
#define TRIAL_BOOTSTRAP_LINE_MAX 8191u
typedef struct {
    cp_settings_t settings;
    char origin[128];
    /* Empty selects the existing public bundle. Never persisted or logged. */
    char server_ca_pem[TRIAL_BOOTSTRAP_CA_MAX + 1u];
    cp_v3_time_t clock_seed;
    unsigned max_windows;
} trial_bootstrap_t;
/* Physical USB only, no persistent secret or automatic network operation.
 * Every boot requires a fresh trusted host time and matching node/boot. */
esp_err_t trial_bootstrap_wait(const char *node, const char *boot, trial_bootstrap_t *, bool (*cancelled)(void));
void trial_bootstrap_clear(trial_bootstrap_t *);
/* Pure parser with caller-supplied current boot monotonic time. Eleven original
 * fields remain mandatory; server_ca_pem is the sole optional field. A supplied
 * CA must be one LF/CRLF PEM X.509 CA certificate (no chain or extra text).
 * Canonical CP_API_ORIGIN uses the SDK bundle and forbids the CA field;
 * production spellings with ports, paths or aliases are not accepted.
 * Any failure clears the complete output. Caller owns/wipes the input JSON.
 * Parsing a CA does not validate a server, hostname, date or isolated origin. */
bool trial_bootstrap_parse(const char *json, const char *node, const char *boot,
                          uint64_t mono_ms, trial_bootstrap_t *out);
