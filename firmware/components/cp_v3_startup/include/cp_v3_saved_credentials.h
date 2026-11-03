#pragma once
#include "cp_settings.h"
#include <string.h>

typedef enum { CP_V3_SAVED_READY, CP_V3_SAVED_MISSING, CP_V3_SAVED_UNAVAILABLE } cp_v3_saved_state_t;
typedef struct {
    cp_settings_t settings;
    cp_v3_saved_state_t credential_state, mqtt_state;
} cp_v3_saved_credentials_t;

static inline bool cp_v3_saved_credential_ready(const cp_settings_t *saved, const char *node) {
    return node && cp_settings_validate(saved) && !strcmp(saved->node_id, node);
}
static inline bool cp_v3_saved_mqtt_ready(const cp_settings_t *saved, const char *node) {
    return cp_v3_saved_credential_ready(saved, node) && cp_settings_mqtt_ready(saved);
}
static inline void cp_v3_saved_credentials_clear(cp_v3_saved_credentials_t *saved) {
    if (!saved) return;
    cp_settings_clear_sensitive(&saved->settings);
    saved->credential_state = saved->mqtt_state = CP_V3_SAVED_UNAVAILABLE;
}
static inline const char *cp_v3_saved_state_name(cp_v3_saved_state_t state) {
    return state == CP_V3_SAVED_READY ? "ready" : state == CP_V3_SAVED_MISSING ? "missing" : "unavailable";
}
/* Read-only snapshot: prefer the selected valid same-node V3 profile. Consult
 * legacy settings only when the entire V3 store is absent, never on corruption,
 * wrong-node selection or IO errors. Does not initialize, write or erase NVS.
 * Values stay on device; callers expose only the two readiness states. */
void cp_v3_saved_credentials_load(const char *expected_node, cp_v3_saved_credentials_t *out);
