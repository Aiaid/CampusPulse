#include "raw_setup.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

enum { QUIESCE = 1, RESUME, STOP_NETWORK, START_SESSION, STOP_SESSION, VALIDATE, SAVE };
typedef struct {
    raw_setup_t setup;
    int calls[64], count, fail_operation, fail_occurrence, seen[8];
    const cp_settings_t *borrowed;
    bool hold_gate_after_save;
    unsigned saved_count, status_count;
} fixture_t;
static const char *node = "cp_000000000001";
static const char *attempt = "00000000-0000-4000-8000-000000000001";

static bool zero(const void *bytes, size_t length) {
    const unsigned char *p = bytes;
    for (size_t i = 0; i < length; ++i) if (p[i]) return false;
    return true;
}
static esp_err_t record(fixture_t *f, int operation) {
    assert(f->count < 64);
    f->calls[f->count++] = operation;
    ++f->seen[operation];
    return operation == f->fail_operation && f->seen[operation] == f->fail_occurrence ? ESP_FAIL : ESP_OK;
}
static esp_err_t quiesce(void *ctx) { return record(ctx, QUIESCE); }
static esp_err_t resume(void *ctx) {
    fixture_t *f = ctx;
    /* Candidate is still in worker scope, but must be wiped before resumption. */
    if (f->borrowed) assert(zero(f->borrowed, sizeof *f->borrowed));
    return record(f, RESUME);
}
static esp_err_t stop_network(void *ctx) { return record(ctx, STOP_NETWORK); }
static esp_err_t stop_session(void *ctx) { return record(ctx, STOP_SESSION); }
static esp_err_t start_session(void *ctx, raw_setup_submit_fn submit, void *submit_ctx) {
    fixture_t *f = ctx;
    assert(submit == raw_setup_submit && submit_ctx == &f->setup);
    return record(f, START_SESSION);
}
static esp_err_t validate(void *ctx, const cp_settings_t *candidate, uint32_t timeout) {
    fixture_t *f = ctx;
    assert(timeout == 1000 && cp_settings_validate(candidate) && cp_settings_mqtt_ready(candidate));
    assert(!strcmp(candidate->node_id, node));
    f->borrowed = candidate;
    assert(!raw_setup_cancel(&f->setup));
    assert(!raw_setup_begin(&f->setup));
    return record(f, VALIDATE);
}
static esp_err_t save(void *ctx, const cp_settings_t *candidate) {
    fixture_t *f = ctx;
    assert(candidate == f->borrowed && cp_settings_validate(candidate));
    assert(f->seen[VALIDATE] == 1 && f->seen[STOP_NETWORK] == 2);
    assert(!raw_setup_cancel(&f->setup));
    esp_err_t result = record(f, SAVE);
    if (result == ESP_OK) ++f->saved_count;
    if (f->hold_gate_after_save) atomic_store(&f->setup.gate, true);
    return result;
}
static void status(void *ctx, raw_setup_state_t state, esp_err_t result) {
    fixture_t *f = ctx;
    (void)state; (void)result;
    ++f->status_count;
}
static raw_setup_ops_t ops(fixture_t *f) {
    return (raw_setup_ops_t){.quiesce_radio = quiesce, .resume_radio = resume,
        .stop_network = stop_network, .start_session = start_session, .stop_session = stop_session,
        .validate_candidate = validate, .save_settings = save, .status = status, .context = f};
}
static void init(fixture_t *f) {
    memset(f, 0, sizeof *f);
    raw_setup_ops_t bindings = ops(f);
    assert(raw_setup_init(&f->setup, node, &bindings, 1000) == ESP_OK);
}
static cp_settings_t candidate(void) {
    cp_settings_t result = {.version = CP_SETTINGS_VERSION};
    strcpy(result.node_id, node);
    strcpy(result.ssid, "synthetic-network");
    strcpy(result.password, "synthetic-password");
    strcpy(result.device_token, "synthetic-token-000000000000000000000000");
    strcpy(result.api_origin, CP_API_ORIGIN);
    strcpy(result.mqtt_uri, CP_MQTT_PRODUCTION_URI);
    strcpy(result.mqtt_username, "synthetic-user");
    strcpy(result.mqtt_password, "synthetic-mqtt-password");
    strcpy(result.mqtt_namespace, "fixture");
    return result;
}
static raw_setup_snapshot_t view(fixture_t *f) {
    raw_setup_snapshot_t result;
    assert(raw_setup_snapshot(&f->setup, &result));
    return result;
}
static void begin(fixture_t *f) {
    assert(raw_setup_begin(&f->setup));
    assert(f->count == 0); /* begin queues only: no radio/storage work in USB. */
    assert(raw_setup_poll(&f->setup) == ESP_OK);
    assert(view(f).state == RAW_SETUP_READY);
}
static void submit(fixture_t *f) {
    cp_settings_t c = candidate();
    assert(raw_setup_submit(&c, attempt, &f->setup) == ESP_OK);
    assert(raw_setup_submit(&c, attempt, &f->setup) == ESP_ERR_INVALID_STATE);
    cp_settings_clear_sensitive(&c);
    assert(cp_settings_validate(&f->setup.pending)); /* Owned copy, not borrowed. */
    assert(raw_setup_reply_finished(&f->setup, raw_setup_candidate_generation(&f->setup)));
}
static void cleared(fixture_t *f) {
    assert(zero(&f->setup.pending, sizeof f->setup.pending));
    assert(zero(f->setup.attempt_id, sizeof f->setup.attempt_id));
    assert(!f->setup.candidate_pending && !f->setup.reply_finished);
}
static void test_success(void) {
    fixture_t f; init(&f); begin(&f);
    cp_settings_t c = candidate();
    assert(raw_setup_submit(&c, attempt, &f.setup) == ESP_OK);
    assert(!raw_setup_reply_finished(&f.setup, 0));
    assert(!raw_setup_reply_finished(&f.setup, raw_setup_candidate_generation(&f.setup) + 1u));
    int old_calls = f.count;
    for (int i = 0; i < 3; ++i) assert(raw_setup_poll(&f.setup) == ESP_OK);
    assert(f.count == old_calls); /* No clock/delay replaces completed reply TX. */
    assert(view(&f).state == RAW_SETUP_AWAIT_REPLY);
    assert(raw_setup_reply_finished(&f.setup, raw_setup_candidate_generation(&f.setup)));
    assert(raw_setup_poll(&f.setup) == ESP_OK);
    int expected[] = {QUIESCE, STOP_NETWORK, STOP_SESSION, START_SESSION,
                      STOP_SESSION, VALIDATE, STOP_NETWORK, SAVE, RESUME};
    assert(f.count == 9 && !memcmp(f.calls, expected, sizeof expected));
    assert(view(&f).state == RAW_SETUP_SAVED && view(&f).saved && f.saved_count == 1);
    cleared(&f);
    assert(raw_setup_poll(&f.setup) == ESP_OK && f.saved_count == 1);
    cp_settings_clear_sensitive(&c);
}
static void test_begin_failures(void) {
    const int failures[] = {QUIESCE, STOP_NETWORK, STOP_SESSION, START_SESSION};
    for (unsigned i = 0; i < sizeof failures / sizeof *failures; ++i) {
        fixture_t f; init(&f);
        f.fail_operation = failures[i]; f.fail_occurrence = 1;
        assert(raw_setup_begin(&f.setup));
        assert(raw_setup_poll(&f.setup) == ESP_FAIL);
        assert(view(&f).state == RAW_SETUP_FAULT);
        assert(!raw_setup_begin(&f.setup));
        assert(!f.seen[RESUME] && !f.seen[VALIDATE] && !f.seen[SAVE]);
        cleared(&f);
    }
}
static void test_candidate_failures(void) {
    const int failures[] = {STOP_SESSION, VALIDATE, STOP_NETWORK, SAVE, RESUME};
    for (unsigned i = 0; i < sizeof failures / sizeof *failures; ++i) {
        fixture_t f; init(&f); begin(&f); submit(&f);
        f.fail_operation = failures[i];
        f.fail_occurrence = (failures[i] == STOP_SESSION || failures[i] == STOP_NETWORK) ? 2 : 1;
        assert(raw_setup_poll(&f.setup) == ESP_FAIL);
        bool unsafe_handoff = failures[i] == STOP_SESSION || failures[i] == STOP_NETWORK || failures[i] == RESUME;
        assert(view(&f).state == (unsafe_handoff ? RAW_SETUP_FAULT : RAW_SETUP_FAILED));
        assert(f.saved_count == (failures[i] == RESUME ? 1u : 0u));
        assert(view(&f).saved == (failures[i] == RESUME));
        if (failures[i] == STOP_SESSION || failures[i] == STOP_NETWORK) assert(!f.seen[RESUME]);
        cleared(&f);
    }
}
static void test_cancel_and_validation_guards(void) {
    fixture_t f; init(&f); begin(&f);
    cp_settings_t c = candidate();
    assert(raw_setup_submit(&c, "short", &f.setup) == ESP_ERR_INVALID_ARG);
    assert(raw_setup_submit(&c, "00000000-0000-1000-8000-000000000001", &f.setup) == ESP_ERR_INVALID_ARG);
    strcpy(c.node_id, "cp_000000000002");
    assert(raw_setup_submit(&c, attempt, &f.setup) == ESP_ERR_INVALID_ARG);
    strcpy(c.node_id, node);
    memset(c.mqtt_uri, 0, sizeof c.mqtt_uri); memset(c.mqtt_username, 0, sizeof c.mqtt_username);
    memset(c.mqtt_password, 0, sizeof c.mqtt_password); memset(c.mqtt_namespace, 0, sizeof c.mqtt_namespace);
    assert(cp_settings_validate(&c)); /* Migrated v2 credentials cannot enroll without MQTT. */
    assert(raw_setup_submit(&c, attempt, &f.setup) == ESP_ERR_INVALID_ARG);
    cleared(&f);
    submit(&f);
    assert(raw_setup_cancel(&f.setup));
    cleared(&f); /* Cancellation wipes queued secrets before worker I/O. */
    assert(!raw_setup_reply_finished(&f.setup, raw_setup_candidate_generation(&f.setup)));
    assert(raw_setup_poll(&f.setup) == ESP_OK && view(&f).state == RAW_SETUP_IDLE);
    assert(!f.seen[VALIDATE] && !f.seen[SAVE] && f.seen[RESUME] == 1);
    cp_settings_clear_sensitive(&c);
}
static void test_deferred_publication(void) {
    fixture_t f; init(&f); begin(&f); submit(&f);
    f.hold_gate_after_save = true;
    assert(raw_setup_poll(&f.setup) == ESP_OK && f.saved_count == 1);
    cleared(&f);
    assert(f.setup.deferred_publication);
    raw_setup_snapshot_t unchanged = {.state = RAW_SETUP_FAULT};
    assert(!raw_setup_snapshot(&f.setup, &unchanged) && unchanged.state == RAW_SETUP_FAULT);
    assert(!raw_setup_begin(&f.setup));
    assert(raw_setup_poll(&f.setup) == ESP_ERR_INVALID_STATE);
    atomic_store(&f.setup.gate, false);
    assert(raw_setup_poll(&f.setup) == ESP_OK);
    assert(view(&f).state == RAW_SETUP_SAVED && view(&f).saved);
    assert(f.saved_count == 1 && !f.setup.deferred_publication);
}
int main(void) {
    test_success(); test_begin_failures(); test_candidate_failures();
    test_cancel_and_validation_guards(); test_deferred_publication();
    puts("Setup supervisor: ordering, guards, failures, wipe and publication passed");
    return 0;
}
