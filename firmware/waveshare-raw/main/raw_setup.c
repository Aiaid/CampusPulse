#include "raw_setup.h"
#include <string.h>

static bool take(raw_setup_t *s) {
    bool expected = false;
    return s && atomic_compare_exchange_strong_explicit(&s->gate, &expected, true,
        memory_order_acquire, memory_order_relaxed);
}
static void give(raw_setup_t *s) {
    atomic_store_explicit(&s->gate, false, memory_order_release);
}
static void clear_pending(raw_setup_t *s) {
    cp_settings_clear_sensitive(&s->pending);
    volatile char *p = s->attempt_id;
    for (size_t i = 0; i < sizeof s->attempt_id; ++i) p[i] = 0;
    s->candidate_pending = false;
    s->reply_finished = false;
}
static size_t bounded_length(const char *text, size_t capacity) {
    size_t length = 0;
    if (!text) return capacity;
    while (length < capacity && text[length]) ++length;
    return length;
}
static bool valid_node(const char *node) {
    if (!node || bounded_length(node, 16) != 15 || memcmp(node, "cp_", 3)) return false;
    for (unsigned i = 3; i < 15; ++i)
        if (!((node[i] >= '0' && node[i] <= '9') || (node[i] >= 'a' && node[i] <= 'f'))) return false;
    return true;
}
static bool valid_attempt(const char *id) {
    if (!id || bounded_length(id, 37) != 36 || id[14] != '4' ||
        !(id[19] == '8' || id[19] == '9' || id[19] == 'a' || id[19] == 'b')) return false;
    for (unsigned i = 0; i < 36; ++i) {
        if (i == 8 || i == 13 || i == 18 || i == 23) { if (id[i] != '-') return false; }
        else if (!((id[i] >= '0' && id[i] <= '9') || (id[i] >= 'a' && id[i] <= 'f'))) return false;
    }
    return true;
}
esp_err_t raw_setup_init(raw_setup_t *s, const char *node, const raw_setup_ops_t *ops,
                         uint32_t timeout_ms) {
    if (!s || !valid_node(node) || !ops || !ops->quiesce_radio || !ops->resume_radio ||
        !ops->stop_network || !ops->start_session || !ops->stop_session ||
        !ops->validate_candidate || !ops->save_settings || timeout_ms < 1000 || timeout_ms > 120000)
        return ESP_ERR_INVALID_ARG;
    memset(s, 0, sizeof *s);
    atomic_init(&s->gate, false);
    atomic_init(&s->candidate_generation, 0);
    s->ops = *ops;
    memcpy(s->node_id, node, sizeof s->node_id);
    s->validation_timeout_ms = timeout_ms;
    s->view.state = RAW_SETUP_IDLE;
    return ESP_OK;
}
bool raw_setup_begin(void *context) {
    raw_setup_t *s = context;
    if (!take(s)) return false;
    bool ok = !s->begin_pending && !s->cancel_pending &&
        (s->view.state == RAW_SETUP_IDLE || s->view.state == RAW_SETUP_SAVED ||
         s->view.state == RAW_SETUP_FAILED || s->view.state == RAW_SETUP_READY);
    if (ok) { s->begin_pending = true; s->view.state = RAW_SETUP_ENTERING; }
    give(s);
    return ok;
}
esp_err_t raw_setup_submit(const cp_settings_t *candidate, const char *attempt, void *context) {
    raw_setup_t *s = context;
    if (!s || !candidate || !valid_attempt(attempt) || !cp_settings_validate(candidate) ||
        !cp_settings_mqtt_ready(candidate) || strcmp(candidate->node_id, s->node_id))
        return ESP_ERR_INVALID_ARG;
    if (!take(s)) return ESP_ERR_INVALID_STATE;
    bool ok = s->view.state == RAW_SETUP_READY && !s->candidate_pending && !s->cancel_pending;
    if (ok) {
        s->pending = *candidate;
        memcpy(s->attempt_id, attempt, sizeof s->attempt_id);
        s->candidate_pending = true;
        unsigned generation = atomic_load_explicit(&s->candidate_generation, memory_order_relaxed) + 1u;
        atomic_store_explicit(&s->candidate_generation, generation ? generation : 1u, memory_order_release);
        s->reply_finished = false;
        s->view.state = RAW_SETUP_AWAIT_REPLY;
    }
    give(s);
    return ok ? ESP_OK : ESP_ERR_INVALID_STATE;
}
uint32_t raw_setup_candidate_generation(raw_setup_t *s) {
    return s ? atomic_load_explicit(&s->candidate_generation, memory_order_acquire) : 0;
}
bool raw_setup_reply_finished(raw_setup_t *s, uint32_t generation) {
    if (!take(s)) return false;
    bool ok = generation && generation == raw_setup_candidate_generation(s) &&
        s->view.state == RAW_SETUP_AWAIT_REPLY && s->candidate_pending && !s->cancel_pending;
    if (ok) s->reply_finished = true;
    give(s);
    return ok;
}
bool raw_setup_cancel(raw_setup_t *s) {
    if (!take(s)) return false;
    bool ok = !s->begin_pending && !s->cancel_pending &&
        (s->view.state == RAW_SETUP_READY || s->view.state == RAW_SETUP_AWAIT_REPLY ||
         s->view.state == RAW_SETUP_FAULT);
    if (ok) { s->cancel_pending = true; clear_pending(s); }
    give(s);
    return ok;
}
bool raw_setup_snapshot(raw_setup_t *s, raw_setup_snapshot_t *out) {
    if (!out || !take(s)) return false;
    *out = s->view;
    out->candidate_generation = raw_setup_candidate_generation(s);
    give(s);
    return true;
}
static bool flush_publication(raw_setup_t *s) {
    if (!take(s)) return false;
    s->view = s->deferred_view;
    s->deferred_publication = false;
    give(s);
    if (s->ops.status) s->ops.status(s->ops.context, s->deferred_view.state,
                                    s->deferred_view.last_error);
    return true;
}
static esp_err_t publish(raw_setup_t *s, raw_setup_state_t state, esp_err_t error, bool saved) {
    s->deferred_view = (raw_setup_snapshot_t){.state = state, .last_error = error, .saved = saved};
    s->deferred_publication = true;
    (void)flush_publication(s);
    return error;
}
esp_err_t raw_setup_poll(raw_setup_t *s) {
    if (!s) return ESP_ERR_INVALID_ARG;
    if (s->deferred_publication)
        return flush_publication(s) ? s->deferred_view.last_error : ESP_ERR_INVALID_STATE;
    if (!take(s)) return ESP_ERR_INVALID_STATE;
    enum { NOTHING, BEGIN, CANDIDATE, CANCEL } work = NOTHING;
    cp_settings_t candidate = {0};
    bool already_saved = s->view.saved;
    if (s->cancel_pending) {
        work = CANCEL; s->cancel_pending = false; s->view.state = RAW_SETUP_CANCELLING;
    } else if (s->begin_pending) {
        work = BEGIN; s->begin_pending = false; s->view.state = RAW_SETUP_ENTERING;
    } else if (s->candidate_pending && s->reply_finished) {
        work = CANDIDATE; candidate = s->pending; clear_pending(s); s->view.state = RAW_SETUP_TESTING;
    }
    give(s);
    if (work == NOTHING) return ESP_OK;
    void *ctx = s->ops.context;
    esp_err_t err;
    if (work == BEGIN) {
        err = s->ops.quiesce_radio(ctx);
        if (err == ESP_OK) err = s->ops.stop_network(ctx);
        if (err == ESP_OK) err = s->ops.stop_session(ctx);
        if (err == ESP_OK) err = s->ops.start_session(ctx, raw_setup_submit, s);
        return publish(s, err == ESP_OK ? RAW_SETUP_READY : RAW_SETUP_FAULT, err, already_saved);
    }
    err = s->ops.stop_session(ctx);
    if (err != ESP_OK) {
        cp_settings_clear_sensitive(&candidate);
        return publish(s, RAW_SETUP_FAULT, err, already_saved);
    }
    if (work == CANCEL) {
        err = s->ops.stop_network(ctx);
        if (err == ESP_OK) err = s->ops.resume_radio(ctx);
        return publish(s, err == ESP_OK ? RAW_SETUP_IDLE : RAW_SETUP_FAULT, err, already_saved);
    }
    if (s->ops.status) s->ops.status(ctx, RAW_SETUP_TESTING, ESP_OK);
    err = s->ops.validate_candidate(ctx, &candidate, s->validation_timeout_ms);
    esp_err_t stopped = s->ops.stop_network(ctx);
    if (stopped != ESP_OK) {
        cp_settings_clear_sensitive(&candidate);
        return publish(s, RAW_SETUP_FAULT, stopped, already_saved);
    }
    bool saved = false;
    if (err == ESP_OK) {
        /* Snapshot contention must never lose a completed save or discard work.
         * If busy, TESTING remains a safe public intermediate state. */
        if (take(s)) { s->view.state = RAW_SETUP_SAVING; give(s); }
        if (s->ops.status) s->ops.status(ctx, RAW_SETUP_SAVING, ESP_OK);
        err = s->ops.save_settings(ctx, &candidate);
        saved = err == ESP_OK;
    }
    cp_settings_clear_sensitive(&candidate);
    esp_err_t resumed = s->ops.resume_radio(ctx);
    if (resumed != ESP_OK) return publish(s, RAW_SETUP_FAULT, resumed, saved || already_saved);
    return publish(s, saved ? RAW_SETUP_SAVED : RAW_SETUP_FAILED, err, saved || already_saved);
}
