#include "cp_core.h"

#include <string.h>

bool cp_node_id_from_base_mac(const uint8_t mac[6], char *out, size_t size)
{
    static const char hex[] = "0123456789abcdef";
    if (out && size) out[0] = '\0';
    if (!mac || !out || size < CP_NODE_ID_SIZE) return false;
    memcpy(out, "cp_", 3);
    for (size_t i = 0; i < 6; ++i) {
        out[3 + i * 2] = hex[mac[i] >> 4];
        out[4 + i * 2] = hex[mac[i] & 15];
    }
    out[CP_NODE_ID_SIZE - 1] = '\0';
    return true;
}

bool cp_board_profile_valid(const cp_board_profile_t *p)
{
    return p && p->board_id && p->board_id[0] && p->revision && p->revision[0]
        && p->target_chip && p->target_chip[0] && p->max_addresses
        && p->ingress_queue_bytes && p->max_collection_lease_ms;
}

void cp_core_init(cp_core_t *core, const cp_board_profile_t *profile)
{
    if (!core) return;
    memset(core, 0, sizeof *core);
    core->profile = cp_board_profile_valid(profile) ? profile : NULL;
    core->setup_active = true;
}

void cp_core_set_identity(cp_core_t *core, cp_identity_state_t identity)
{
    if (!core) return;
    core->identity = identity;
    if (identity != CP_IDENTITY_ENROLLED) core->lease_valid = false;
}

void cp_core_set_network(cp_core_t *core, cp_network_state_t network)
{
    if (core) core->network = network;
}

void cp_core_set_auth(cp_core_t *core, cp_auth_state_t auth)
{
    if (!core) return;
    core->auth = auth;
    if (auth != CP_AUTH_VALID) core->lease_valid = false;
}

void cp_core_set_clock_trusted(cp_core_t *core, bool trusted)
{
    if (core) core->clock_trusted = trusted;
}

void cp_core_set_setup_active(cp_core_t *core, bool active)
{
    if (!core) return;
    if (active && !core->setup_active) core->lease_valid = false;
    core->setup_active = active;
}

void cp_core_set_local_pause(cp_core_t *core, bool paused)
{
    if (core) core->local_paused = paused;
}

void cp_core_set_ui(cp_core_t *core, cp_ui_state_t ui)
{
    if (core) core->ui = ui;
}

static bool config_id_valid(const char *id)
{
    if (!id) return false;
    for (size_t i = 0; i < CP_CONFIG_ID_SIZE; ++i) {
        unsigned char c = (unsigned char)id[i];
        if (!c) return i > 0;
        if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')
              || c == '_' || c == '-')) return false;
    }
    return false;
}

cp_policy_result_t cp_core_validate_policy(const cp_board_profile_t *profile,
                                         const cp_policy_t *policy)
{
    if (!cp_board_profile_valid(profile) || !policy || !config_id_valid(policy->config_id)
        || !policy->max_addresses || !policy->ingress_queue_bytes) return CP_POLICY_INVALID;
    if ((policy->required_capabilities & profile->capabilities) != policy->required_capabilities
        || (policy->collection_enabled && !(profile->capabilities & CP_CAP_BLE_SCAN))
        || policy->max_addresses > profile->max_addresses
        || policy->ingress_queue_bytes > profile->ingress_queue_bytes) return CP_POLICY_UNSUPPORTED;
    return CP_POLICY_OK;
}

static bool advance_time(cp_core_t *core, uint64_t now_ms)
{
    if (core->have_monotonic_time && now_ms < core->last_monotonic_ms) {
        core->lease_valid = false;
        return false;
    }
    core->have_monotonic_time = true;
    core->last_monotonic_ms = now_ms;
    if (core->lease_valid && (now_ms < core->lease_started_ms
        || now_ms - core->lease_started_ms >= core->lease_duration_ms)) core->lease_valid = false;
    return true;
}

static bool same_policy(const cp_policy_t *a, const cp_policy_t *b)
{
    return strcmp(a->config_id, b->config_id) == 0
        && a->required_capabilities == b->required_capabilities
        && a->max_addresses == b->max_addresses
        && a->ingress_queue_bytes == b->ingress_queue_bytes
        && a->collection_enabled == b->collection_enabled
        && a->requires_trusted_clock == b->requires_trusted_clock
        && a->upload_accept_until_utc_ms == b->upload_accept_until_utc_ms;
}

cp_policy_result_t cp_core_receive_desired(cp_core_t *core, const cp_policy_t *policy,
                                         uint64_t request_sequence,
                                         uint64_t now_ms, uint64_t lease_ms)
{
    if (!core) return CP_POLICY_INVALID;
    bool time_valid = advance_time(core, now_ms);
    if (!request_sequence || request_sequence <= core->latest_request_sequence) return CP_POLICY_STALE;
    core->latest_request_sequence = request_sequence;
    if (!time_valid || !lease_ms || !core->profile
        || lease_ms > core->profile->max_collection_lease_ms) {
        core->lease_valid = false;
        return CP_POLICY_INVALID;
    }
    if (core->identity != CP_IDENTITY_ENROLLED || core->auth != CP_AUTH_VALID
        || core->network != CP_NETWORK_READY) {
        core->lease_valid = false;
        return CP_POLICY_NOT_AUTHORIZED;
    }
    cp_policy_result_t result = cp_core_validate_policy(core->profile, policy);
    if (result != CP_POLICY_OK) {
        core->lease_valid = false;
        core->policy_state = CP_POLICY_FAILED;
        return result;
    }
    bool same_id = core->desired.config_id[0]
        && strcmp(core->desired.config_id, policy->config_id) == 0;
    /* A frozen configuration ID cannot acquire different semantics on retry. */
    if (same_id && !same_policy(&core->desired, policy)) {
        core->lease_valid = false;
        core->policy_state = CP_POLICY_FAILED;
        return CP_POLICY_INVALID;
    }
    bool already_applied = same_id && core->policy_state == CP_POLICY_APPLIED;
    core->desired = *policy;
    core->policy_state = already_applied ? CP_POLICY_APPLIED : CP_POLICY_STAGED;
    core->lease_started_ms = now_ms;
    core->lease_duration_ms = lease_ms;
    core->lease_valid = true;
    return CP_POLICY_OK;
}

bool cp_core_mark_applied(cp_core_t *core, const char *config_id)
{
    if (!core || !config_id_valid(config_id)
        || (core->policy_state != CP_POLICY_STAGED && core->policy_state != CP_POLICY_APPLIED)
        || core->identity != CP_IDENTITY_ENROLLED || core->auth != CP_AUTH_VALID
        || strcmp(config_id, core->desired.config_id) != 0) return false;
    memcpy(core->applied_config_id, core->desired.config_id, CP_CONFIG_ID_SIZE);
    core->policy_state = CP_POLICY_APPLIED;
    return true;
}

void cp_core_mark_apply_failed(cp_core_t *core)
{
    if (!core) return;
    core->policy_state = CP_POLICY_FAILED;
    core->lease_valid = false;
}
void cp_core_clear_policy(cp_core_t *core)
{
    if(!core)return;
    core->policy_state=CP_POLICY_NONE;core->lease_valid=false;
    memset(&core->desired,0,sizeof core->desired);
}

cp_collection_state_t cp_core_decide(cp_core_t *core, uint64_t now_ms)
{
    if (!core) return CP_COLLECTION_NEEDS_SETUP;
    advance_time(core, now_ms);
    if (core->local_paused) return CP_COLLECTION_LOCAL_PAUSE;
    if (core->auth == CP_AUTH_REJECTED) return CP_COLLECTION_AUTH_REJECTED;
    if (!core->profile || core->identity != CP_IDENTITY_ENROLLED || core->setup_active)
        return CP_COLLECTION_NEEDS_SETUP;
    if (core->auth != CP_AUTH_VALID) return CP_COLLECTION_WAIT_AUTH;
    if (core->policy_state == CP_POLICY_NONE) return CP_COLLECTION_WAIT_POLICY;
    if (core->policy_state == CP_POLICY_FAILED) return CP_COLLECTION_POLICY_FAILED;
    if (core->policy_state != CP_POLICY_APPLIED) return CP_COLLECTION_WAIT_APPLY;
    if (!core->desired.collection_enabled) return CP_COLLECTION_POLICY_DISABLED;
    if (!core->lease_valid) return CP_COLLECTION_LEASE_EXPIRED;
    if (core->desired.requires_trusted_clock && !core->clock_trusted)
        return CP_COLLECTION_WAIT_CLOCK;
    return CP_COLLECTION_ALLOWED;
}

bool cp_collection_allowed(cp_collection_state_t state)
{
    return state == CP_COLLECTION_ALLOWED;
}

const char *cp_collection_state_name(cp_collection_state_t state)
{
    switch (state) {
    case CP_COLLECTION_NEEDS_SETUP: return "needs_setup";
    case CP_COLLECTION_LOCAL_PAUSE: return "local_pause";
    case CP_COLLECTION_AUTH_REJECTED: return "auth_rejected";
    case CP_COLLECTION_WAIT_AUTH: return "wait_auth";
    case CP_COLLECTION_WAIT_POLICY: return "wait_policy";
    case CP_COLLECTION_POLICY_FAILED: return "policy_failed";
    case CP_COLLECTION_WAIT_APPLY: return "wait_apply";
    case CP_COLLECTION_POLICY_DISABLED: return "policy_disabled";
    case CP_COLLECTION_WAIT_CLOCK: return "wait_clock";
    case CP_COLLECTION_LEASE_EXPIRED: return "lease_expired";
    case CP_COLLECTION_ALLOWED: return "allowed";
    }
    return "unknown";
}
