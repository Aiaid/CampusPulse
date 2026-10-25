#ifndef CP_CORE_H
#define CP_CORE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define CP_NODE_ID_SIZE 16u /* cp_ + twelve hex digits + NUL */
#define CP_CONFIG_ID_SIZE 65u

/* The caller must supply the factory base MAC, never an interface/random MAC. */
bool cp_node_id_from_base_mac(const uint8_t mac[6], char *out, size_t size);

enum {
    CP_CAP_BLE_SCAN = 1u << 0,
    CP_CAP_DISPLAY = 1u << 1,
    CP_CAP_INPUT = 1u << 2,
    CP_CAP_BATTERY = 1u << 3
};

/* Descriptive compiled limits. The board adapter verifies target/revision.
 * No pins, protected partition offsets, or runtime hardware inference live here. */
typedef struct {
    const char *board_id;
    const char *revision;
    const char *target_chip;
    uint32_t capabilities;
    uint32_t max_addresses;
    uint32_t ingress_queue_bytes;
    uint64_t max_collection_lease_ms;
} cp_board_profile_t;

bool cp_board_profile_valid(const cp_board_profile_t *profile);

typedef enum { CP_IDENTITY_UNKNOWN, CP_IDENTITY_FACTORY, CP_IDENTITY_ENROLLED } cp_identity_state_t;
typedef enum { CP_NETWORK_OFFLINE, CP_NETWORK_CONNECTING, CP_NETWORK_READY } cp_network_state_t;
typedef enum { CP_AUTH_UNKNOWN, CP_AUTH_VALID, CP_AUTH_REJECTED } cp_auth_state_t;
typedef enum { CP_UI_ABSENT, CP_UI_READY, CP_UI_DEGRADED } cp_ui_state_t;
typedef enum { CP_POLICY_NONE, CP_POLICY_STAGED, CP_POLICY_APPLIED, CP_POLICY_FAILED } cp_policy_state_t;

/* A validated protocol adapter projects only the decisions needed by this slice.
 * It must validate identity, schema, adapter, streams, placement and dataset before
 * calling receive_desired. This struct is not a wire schema or a persisted grant. */
typedef struct {
    char config_id[CP_CONFIG_ID_SIZE];
    uint32_t required_capabilities;
    uint32_t max_addresses;
    uint32_t ingress_queue_bytes;
    bool collection_enabled;
    bool requires_trusted_clock;
    uint64_t upload_accept_until_utc_ms; /* upload cutoff ONLY, never a lease */
} cp_policy_t;

typedef enum {
    CP_POLICY_OK, CP_POLICY_INVALID, CP_POLICY_UNSUPPORTED,
    CP_POLICY_STALE, CP_POLICY_NOT_AUTHORIZED
} cp_policy_result_t;

typedef enum {
    CP_COLLECTION_NEEDS_SETUP, CP_COLLECTION_LOCAL_PAUSE,
    CP_COLLECTION_AUTH_REJECTED, CP_COLLECTION_WAIT_AUTH,
    CP_COLLECTION_WAIT_POLICY, CP_COLLECTION_POLICY_FAILED,
    CP_COLLECTION_WAIT_APPLY, CP_COLLECTION_POLICY_DISABLED,
    CP_COLLECTION_WAIT_CLOCK, CP_COLLECTION_LEASE_EXPIRED,
    CP_COLLECTION_ALLOWED
} cp_collection_state_t;

typedef struct {
    const cp_board_profile_t *profile;
    cp_identity_state_t identity;
    cp_network_state_t network;
    cp_auth_state_t auth;
    cp_ui_state_t ui;
    cp_policy_state_t policy_state;
    bool setup_active;
    bool local_paused;
    bool clock_trusted;
    bool lease_valid;
    bool have_monotonic_time;
    uint64_t last_monotonic_ms;
    uint64_t latest_request_sequence;
    uint64_t lease_started_ms;
    uint64_t lease_duration_ms;
    cp_policy_t desired;
    char applied_config_id[CP_CONFIG_ID_SIZE];
} cp_core_t;

/* init/reset never restores a lease or applied policy, even on the same hardware.
 * Profile lifetime must exceed core lifetime. Invalid profiles fail closed. */
void cp_core_init(cp_core_t *core, const cp_board_profile_t *profile);
void cp_core_set_identity(cp_core_t *core, cp_identity_state_t identity);
void cp_core_set_network(cp_core_t *core, cp_network_state_t network);
void cp_core_set_auth(cp_core_t *core, cp_auth_state_t auth);
void cp_core_set_clock_trusted(cp_core_t *core, bool trusted);
void cp_core_set_setup_active(cp_core_t *core, bool active);
void cp_core_set_local_pause(cp_core_t *core, bool paused);
void cp_core_set_ui(cp_core_t *core, cp_ui_state_t ui);

cp_policy_result_t cp_core_validate_policy(const cp_board_profile_t *profile,
                                         const cp_policy_t *policy);
/* Only a successful online desired-policy response may use this API. Sequence
 * numbers are assigned when requests START, are nonzero, and increase per boot.
 * Historical lookups use validate_policy only. Neither uploads nor cached reads
 * renew authorization. Unsupported latest desired policy fails collection closed.
 * lease_ms must be explicitly selected and bounded by the compiled profile. */
cp_policy_result_t cp_core_receive_desired(cp_core_t *core, const cp_policy_t *policy,
                                         uint64_t request_sequence,
                                         uint64_t now_ms, uint64_t lease_ms);
/* Call only after actual adapter application succeeds; never after substitution.
 * Failure leaves the old applied ID as evidence, but blocks new collection. */
bool cp_core_mark_applied(cp_core_t *core, const char *config_id);
void cp_core_mark_apply_failed(cp_core_t *core);
/* Explicit successful desired-policy response says no assignment. */
void cp_core_clear_policy(cp_core_t *core);
/* Pure state/decision logic, no IO. Updates monotonic high-water/lease expiry so
 * a later clock regression cannot revive authorization. UI and transient network
 * failure do not revoke an otherwise valid bounded same-boot authorization. */
cp_collection_state_t cp_core_decide(cp_core_t *core, uint64_t now_ms);
bool cp_collection_allowed(cp_collection_state_t state);
const char *cp_collection_state_name(cp_collection_state_t state);

#ifdef __cplusplus
}
#endif
#endif
