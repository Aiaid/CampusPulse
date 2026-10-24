/* Host-only state-machine tests. Addresses and policy IDs are synthetic. */
#include "cp_core.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

static const cp_board_profile_t profile = {
    .board_id = "test_board", .revision = "test_revision", .target_chip = "host",
    .capabilities = CP_CAP_BLE_SCAN | CP_CAP_INPUT,
    .max_addresses = 128, .ingress_queue_bytes = 4096,
    .max_collection_lease_ms = 30000
};

static cp_policy_t policy(const char *id)
{
    cp_policy_t p = {
        .required_capabilities = CP_CAP_BLE_SCAN,
        .max_addresses = 64, .ingress_queue_bytes = 2048,
        .collection_enabled = true, .requires_trusted_clock = true,
        .upload_accept_until_utc_ms = 1
    };
    assert(strlen(id) < sizeof p.config_id);
    strcpy(p.config_id, id);
    return p;
}

static cp_core_t authenticated(void)
{
    cp_core_t c;
    cp_core_init(&c, &profile);
    cp_core_set_identity(&c, CP_IDENTITY_ENROLLED);
    cp_core_set_network(&c, CP_NETWORK_READY);
    cp_core_set_auth(&c, CP_AUTH_VALID);
    cp_core_set_clock_trusted(&c, true);
    cp_core_set_setup_active(&c, false);
    return c;
}

static cp_core_t collecting(void)
{
    cp_core_t c = authenticated();
    cp_policy_t p = policy("policy_a");
    assert(cp_core_receive_desired(&c, &p, 1, 100, 1000) == CP_POLICY_OK);
    assert(cp_core_mark_applied(&c, p.config_id));
    assert(cp_collection_allowed(cp_core_decide(&c, 100)));
    return c;
}

static void test_identity_exact_and_bounded(void)
{
    const uint8_t mac[] = {0x00, 0x01, 0xab, 0xcd, 0xef, 0xff};
    char id[CP_NODE_ID_SIZE];
    assert(cp_node_id_from_base_mac(mac, id, sizeof id));
    assert(strcmp(id, "cp_0001abcdefff") == 0);
    assert(strlen(id) == 15 && !strchr(id, ':'));
    struct { char id[CP_NODE_ID_SIZE - 1]; char guard; } short_output;
    memset(&short_output, 'X', sizeof short_output);
    assert(!cp_node_id_from_base_mac(mac, short_output.id, sizeof short_output.id));
    assert(short_output.id[0] == '\0' && short_output.guard == 'X');
    assert(!cp_node_id_from_base_mac(NULL, id, sizeof id) && id[0] == '\0');
    assert(!cp_node_id_from_base_mac(mac, NULL, 0));
}

static void test_cold_boot_and_independent_status(void)
{
    cp_core_t c;
    cp_core_init(&c, &profile);
    assert(c.identity == CP_IDENTITY_UNKNOWN && c.network == CP_NETWORK_OFFLINE);
    assert(c.auth == CP_AUTH_UNKNOWN && c.policy_state == CP_POLICY_NONE);
    assert(c.ui == CP_UI_ABSENT && !c.clock_trusted && !c.lease_valid);
    assert(cp_core_decide(&c, 0) == CP_COLLECTION_NEEDS_SETUP);
    cp_core_set_identity(&c, CP_IDENTITY_FACTORY);
    cp_core_set_network(&c, CP_NETWORK_READY);
    cp_core_set_ui(&c, CP_UI_READY);
    assert(cp_core_decide(&c, 1) == CP_COLLECTION_NEEDS_SETUP);
    c = authenticated();
    assert(cp_core_decide(&c, 1) == CP_COLLECTION_WAIT_POLICY);
    cp_core_set_auth(&c, CP_AUTH_UNKNOWN);
    assert(cp_core_decide(&c, 2) == CP_COLLECTION_WAIT_AUTH);
    cp_core_init(&c, NULL);
    assert(cp_core_decide(&c, 0) == CP_COLLECTION_NEEDS_SETUP);
}

static void test_staging_requires_actual_application(void)
{
    cp_core_t c = authenticated();
    cp_policy_t p = policy("policy_a");
    assert(cp_core_receive_desired(&c, &p, 1, 100, 1000) == CP_POLICY_OK);
    assert(cp_core_decide(&c, 101) == CP_COLLECTION_WAIT_APPLY);
    assert(c.applied_config_id[0] == '\0');
    assert(!cp_core_mark_applied(&c, "unrelated"));
    assert(cp_core_mark_applied(&c, p.config_id));
    cp_core_set_ui(&c, CP_UI_DEGRADED);
    assert(cp_collection_allowed(cp_core_decide(&c, 102)));
    cp_core_set_ui(&c, CP_UI_ABSENT);
    cp_core_set_network(&c, CP_NETWORK_OFFLINE);
    assert(cp_collection_allowed(cp_core_decide(&c, 103)));
    assert(c.ui == CP_UI_ABSENT && c.network == CP_NETWORK_OFFLINE);
}

static void test_local_pause_and_setup_are_authoritative(void)
{
    cp_core_t c = collecting();
    cp_policy_t p = policy("policy_a");
    cp_core_set_local_pause(&c, true);
    assert(cp_core_decide(&c, 110) == CP_COLLECTION_LOCAL_PAUSE);
    assert(cp_core_receive_desired(&c, &p, 2, 120, 1000) == CP_POLICY_OK);
    assert(cp_core_decide(&c, 121) == CP_COLLECTION_LOCAL_PAUSE);
    cp_core_set_local_pause(&c, false);
    assert(cp_collection_allowed(cp_core_decide(&c, 122)));
    cp_core_set_setup_active(&c, true);
    assert(cp_core_decide(&c, 123) == CP_COLLECTION_NEEDS_SETUP);
    cp_core_set_setup_active(&c, false);
    assert(cp_core_decide(&c, 124) == CP_COLLECTION_LEASE_EXPIRED);
    /* Setup may stage/apply a fresh grant without starting observation. */
    cp_core_set_setup_active(&c, true);
    assert(cp_core_receive_desired(&c, &p, 3, 125, 1000) == CP_POLICY_OK);
    assert(cp_core_decide(&c, 126) == CP_COLLECTION_NEEDS_SETUP);
    cp_core_set_setup_active(&c, false);
    assert(cp_collection_allowed(cp_core_decide(&c, 127)));
}

static void test_auth_rejection_revokes_without_losing_policy(void)
{
    cp_core_t c = collecting();
    cp_core_set_auth(&c, CP_AUTH_REJECTED);
    assert(cp_core_decide(&c, 110) == CP_COLLECTION_AUTH_REJECTED);
    assert(strcmp(c.applied_config_id, "policy_a") == 0 && !c.lease_valid);
    cp_core_set_auth(&c, CP_AUTH_VALID);
    assert(cp_core_decide(&c, 111) == CP_COLLECTION_LEASE_EXPIRED);
    cp_policy_t p = policy("policy_a");
    assert(cp_core_receive_desired(&c, &p, 2, 112, 1000) == CP_POLICY_OK);
    assert(cp_collection_allowed(cp_core_decide(&c, 113)));
}

static void test_no_packet_expiry_cutoff_and_no_historical_renewal(void)
{
    cp_core_t c = collecting();
    cp_policy_t p = policy("policy_a");
    /* Upload acceptance was already in the past; it is not collection time. */
    assert(p.upload_accept_until_utc_ms == 1);
    assert(cp_collection_allowed(cp_core_decide(&c, 1099)));
    /* Historical/cached policy validation has no state or renewal side effects. */
    assert(cp_core_validate_policy(&profile, &p) == CP_POLICY_OK);
    assert(c.lease_started_ms == 100 && c.latest_request_sequence == 1);
    assert(cp_core_decide(&c, 1100) == CP_COLLECTION_LEASE_EXPIRED);
    p.upload_accept_until_utc_ms = UINT64_MAX;
    assert(cp_core_validate_policy(&profile, &p) == CP_POLICY_OK);
    assert(cp_core_decide(&c, 1101) == CP_COLLECTION_LEASE_EXPIRED);
    /* Frozen IDs preserve every projected field, even the independent cutoff. */
    assert(cp_core_receive_desired(&c, &p, 2, 1102, 100) == CP_POLICY_INVALID);
    assert(cp_core_decide(&c, 1103) == CP_COLLECTION_POLICY_FAILED);
    assert(c.desired.upload_accept_until_utc_ms == 1 && !c.lease_valid);
    assert(!cp_core_mark_applied(&c, p.config_id));
    /* A new ID may have a different upload cutoff; collection still expires at
     * its own short monotonic deadline despite an effectively endless cutoff. */
    strcpy(p.config_id, "policy_new_cutoff");
    assert(cp_core_receive_desired(&c, &p, 3, 1104, 100) == CP_POLICY_OK);
    assert(cp_core_decide(&c, 1105) == CP_COLLECTION_WAIT_APPLY);
    assert(cp_core_mark_applied(&c, p.config_id));
    assert(cp_collection_allowed(cp_core_decide(&c, 1203)));
    assert(cp_core_decide(&c, 1204) == CP_COLLECTION_LEASE_EXPIRED);
}

static void test_stale_responses_and_failed_latest_policy(void)
{
    cp_core_t c = collecting();
    cp_policy_t p = policy("policy_b");
    assert(cp_core_receive_desired(&c, &p, 3, 200, 1000) == CP_POLICY_OK);
    assert(cp_core_decide(&c, 200) == CP_COLLECTION_WAIT_APPLY);
    cp_policy_t old = policy("policy_a");
    assert(cp_core_receive_desired(&c, &old, 2, 201, 1000) == CP_POLICY_STALE);
    assert(strcmp(c.desired.config_id, "policy_b") == 0 && c.lease_started_ms == 200);
    assert(!cp_core_mark_applied(&c, old.config_id));
    assert(cp_core_mark_applied(&c, p.config_id));
    p.required_capabilities |= CP_CAP_DISPLAY;
    assert(cp_core_receive_desired(&c, &p, 4, 202, 1000) == CP_POLICY_UNSUPPORTED);
    assert(cp_core_decide(&c, 203) == CP_COLLECTION_POLICY_FAILED);
    assert(strcmp(c.applied_config_id, "policy_b") == 0);
    assert(!cp_core_mark_applied(&c, p.config_id));
    assert(cp_core_receive_desired(&c, &old, 3, 204, 1000) == CP_POLICY_STALE);
    assert(cp_core_decide(&c, 205) == CP_COLLECTION_POLICY_FAILED);
}

static void test_policy_bounds_immutability_and_disabled(void)
{
    cp_policy_t p = policy("policy_a");
    p.max_addresses = profile.max_addresses + 1;
    assert(cp_core_validate_policy(&profile, &p) == CP_POLICY_UNSUPPORTED);
    p = policy("policy_a");
    p.ingress_queue_bytes = profile.ingress_queue_bytes + 1;
    assert(cp_core_validate_policy(&profile, &p) == CP_POLICY_UNSUPPORTED);
    p = policy("policy_a");
    memset(p.config_id, 'a', sizeof p.config_id);
    assert(cp_core_validate_policy(&profile, &p) == CP_POLICY_INVALID);
    p.config_id[sizeof p.config_id - 1] = '\0';
    assert(cp_core_validate_policy(&profile, &p) == CP_POLICY_OK);
    p.config_id[0] = '/';
    assert(cp_core_validate_policy(&profile, &p) == CP_POLICY_INVALID);
    cp_core_t c = collecting();
    p = policy("policy_a");
    p.max_addresses--;
    assert(cp_core_receive_desired(&c, &p, 2, 110, 1000) == CP_POLICY_INVALID);
    assert(cp_core_decide(&c, 111) == CP_COLLECTION_POLICY_FAILED);
    p = policy("disabled_policy");
    p.collection_enabled = false;
    assert(cp_core_receive_desired(&c, &p, 3, 112, 1000) == CP_POLICY_OK);
    assert(cp_core_mark_applied(&c, p.config_id));
    assert(cp_core_decide(&c, 113) == CP_COLLECTION_POLICY_DISABLED);
}

static void test_clock_and_monotonic_fail_closed(void)
{
    cp_core_t c = collecting();
    cp_core_set_clock_trusted(&c, false);
    assert(cp_core_decide(&c, 101) == CP_COLLECTION_WAIT_CLOCK);
    assert(c.lease_valid);
    cp_core_set_clock_trusted(&c, true);
    assert(cp_collection_allowed(cp_core_decide(&c, 102)));
    assert(cp_core_decide(&c, 101) == CP_COLLECTION_LEASE_EXPIRED);
    assert(cp_core_decide(&c, 103) == CP_COLLECTION_LEASE_EXPIRED);
    cp_policy_t p = policy("policy_a");
    assert(cp_core_receive_desired(&c, &p, 2, 102, 1000) == CP_POLICY_INVALID);
    assert(!c.lease_valid);
    assert(cp_core_receive_desired(&c, &p, 3, 104, 1000) == CP_POLICY_OK);
    assert(cp_collection_allowed(cp_core_decide(&c, 105)));
    /* Overflow cannot turn a grant near UINT64_MAX into an indefinite lease. */
    c = authenticated();
    assert(cp_core_receive_desired(&c, &p, 1, UINT64_MAX - 5, 10) == CP_POLICY_OK);
    assert(cp_core_mark_applied(&c, p.config_id));
    assert(cp_collection_allowed(cp_core_decide(&c, UINT64_MAX)));
    assert(cp_core_decide(&c, 0) == CP_COLLECTION_LEASE_EXPIRED);
}

static void test_lease_bounds_auth_and_reset(void)
{
    cp_core_t c = authenticated();
    cp_policy_t p = policy("policy_a");
    assert(cp_core_receive_desired(&c, &p, 1, 100, 0) == CP_POLICY_INVALID);
    assert(cp_core_receive_desired(&c, &p, 2, 101, profile.max_collection_lease_ms + 1) == CP_POLICY_INVALID);
    cp_core_set_network(&c, CP_NETWORK_OFFLINE);
    assert(cp_core_receive_desired(&c, &p, 3, 102, 1000) == CP_POLICY_NOT_AUTHORIZED);
    cp_core_set_network(&c, CP_NETWORK_READY);
    cp_core_set_auth(&c, CP_AUTH_UNKNOWN);
    assert(cp_core_receive_desired(&c, &p, 4, 103, 1000) == CP_POLICY_NOT_AUTHORIZED);
    c = collecting();
    cp_core_mark_apply_failed(&c);
    assert(cp_core_decide(&c, 101) == CP_COLLECTION_POLICY_FAILED);
    cp_core_init(&c, &profile);
    assert(!c.lease_valid && c.policy_state == CP_POLICY_NONE);
    assert(c.applied_config_id[0] == '\0' && c.desired.config_id[0] == '\0');
    assert(c.latest_request_sequence == 0 && c.setup_active && !c.clock_trusted);
    assert(cp_core_decide(&c, 0) == CP_COLLECTION_NEEDS_SETUP);
    assert(!cp_core_mark_applied(&c, p.config_id));
}

int main(void)
{
    test_identity_exact_and_bounded();
    test_cold_boot_and_independent_status();
    test_staging_requires_actual_application();
    test_local_pause_and_setup_are_authoritative();
    test_auth_rejection_revokes_without_losing_policy();
    test_no_packet_expiry_cutoff_and_no_historical_renewal();
    test_stale_responses_and_failed_latest_policy();
    test_policy_bounds_immutability_and_disabled();
    test_clock_and_monotonic_fail_closed();
    test_lease_bounds_auth_and_reset();
    assert(!cp_collection_allowed(CP_COLLECTION_NEEDS_SETUP));
    assert(strcmp(cp_collection_state_name(CP_COLLECTION_ALLOWED), "allowed") == 0);
    puts("cp_core: 10 host test groups passed");
    return 0;
}
