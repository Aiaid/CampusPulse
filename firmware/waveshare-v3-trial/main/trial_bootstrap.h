#pragma once
#include "cp_settings.h"
#include "cp_v3_evidence.h"
#include "esp_err.h"
typedef struct {
    cp_settings_t settings;
    char origin[128];
    cp_v3_time_t clock_seed;
    unsigned max_windows;
} trial_bootstrap_t;
/* Physical USB only, no persistent secret or automatic network operation.
 * Every boot requires a fresh trusted host time and matching node/boot. */
esp_err_t trial_bootstrap_wait(const char *node, const char *boot, trial_bootstrap_t *, bool (*cancelled)(void));
void trial_bootstrap_clear(trial_bootstrap_t *);
