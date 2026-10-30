#include "cp_v3_evidence.h"
#include <assert.h>
#include <openssl/sha.h>
#include <stdio.h>
#include <string.h>

static const char *batch = "00000000-0000-4000-8000-000000000001";
static cp_v3_scope_t scope(void) {
    cp_v3_scope_t s = {.assignment_generation = 1, .window_seq = 1};
    strcpy(s.node_id, "synthetic-node"); strcpy(s.boot_id, "00000000-0000-4000-8000-000000000002");
    strcpy(s.placement_id, "synthetic-place"); strcpy(s.policy_id, "synthetic-policy");
    memset(s.policy_sha256, 'a', 64); strcpy(s.dataset, "controlled_test"); return s;
}
static cp_v3_limits_t limits(void) {
    return (cp_v3_limits_t){.window_ms = 1000, .max_reports = 100, .max_evidence_bytes = 65536,
        .max_identifiers = 16, .fields = CP_V3_COMPANY | CP_V3_APPEARANCE, .company_limit = 4, .appearance_limit = 2};
}
static cp_v3_time_t start(void) { return (cp_v3_time_t){.mono_ms = 1000, .utc_ms = 1793318400000ULL, .uncertainty_ms = 10}; }
static cp_v3_time_t end(void) { cp_v3_time_t t = start(); t.mono_ms += 1000; t.utc_ms += 1000; return t; }
static bool entropy(void *ctx, uint8_t token[16]) { unsigned *n = ctx; memset(token, 0, 16); token[0] = (uint8_t)++*n; return true; }
static bool no_entropy(void *ctx, uint8_t token[16]) { (void)ctx; (void)token; return false; }
static bool repeated_entropy(void *ctx, uint8_t token[16]) { ++*(unsigned *)ctx; memset(token, 0, 16); return true; }
static bool hash(void *ctx, const void *data, size_t length, uint8_t digest[32]) { (void)ctx; return SHA256(data, length, digest) != NULL; }
static const uint8_t payload[] = {3,255,76,0,3,255,76,0,3,25,64,0,4,9,'p','v','t'};
static cp_v3_report_t report(const uint8_t *bytes, size_t length) {
    cp_v3_report_t r = {.payload = bytes, .length = length}; memcpy(r.address, "secret", 6); return r;
}
static void begin(cp_v3_window_t *w, cp_v3_scope_t s, cp_v3_limits_t l, unsigned *rng) {
    assert(cp_v3_window_begin(w, &s, &l, start(), entropy, rng) == CP_V3_OK);
}
static void seal(cp_v3_window_t *w) { assert(cp_v3_window_seal(w, end(), true, w->worker_reports, 0) == CP_V3_OK); }
static void emit(cp_v3_window_t *w, bool fixtures) {
    char body[CP_V3_BODY_MAX]; size_t size; cp_v3_expected_t expected;
    assert(cp_v3_feature_body(w, 0, batch, 1, hash, NULL, body, sizeof body, &size, &expected) == CP_V3_OK);
    assert(size == strlen(body) && size == expected.body_bytes && expected.accepted_count == 1);
    assert(!strstr(body, "secret") && !strstr(body, "736563726574") && !strstr(body, "\"address\"") && !strstr(body, "pvt"));
    if (fixtures) printf("{\"body\":%s,\"sha256\":\"%s\",\"evidence_bytes\":%u}\n", body, expected.body_sha256, w->evidence_bytes);
}
static void tests(bool fixtures) {
    unsigned rng = 0; cp_v3_window_t w; cp_v3_scope_t s = scope(); cp_v3_limits_t l = limits();
    cp_v3_report_t r = report(payload, sizeof payload);
    begin(&w, s, l, &rng);
    assert(cp_v3_window_observe(&w, &r) == CP_V3_OK); r.report_type = 1;
    assert(cp_v3_window_observe(&w, &r) == CP_V3_OK);
    assert(w.identifiers[0].company[0].support == 2 && w.identifiers[0].company[0].adv == 1 && w.identifiers[0].company[0].scan_response == 1);
    assert(w.identifiers[0].company_count == 1 && w.identifiers[0].appearance[0].value == 64);
    seal(&w); emit(&w, fixtures);
    char body[CP_V3_BODY_MAX], again[CP_V3_BODY_MAX]; size_t size, again_size;
    cp_v3_expected_t expected, duplicate;
    assert(cp_v3_feature_body(&w, 0, batch, 1, hash, NULL, body, sizeof body, &size, &expected) == CP_V3_OK);
    assert(cp_v3_feature_body(&w, 0, batch, 1, hash, NULL, again, sizeof again, &again_size, &duplicate) == CP_V3_OK);
    assert(size == again_size && !memcmp(body, again, size) && !strcmp(expected.body_sha256, duplicate.body_sha256));
    assert(cp_v3_window_observe(&w, &r) == CP_V3_INVALID);
    uint8_t previous[16]; memcpy(previous, w.identifiers[0].token, 16);
    ++s.window_seq; begin(&w, s, l, &rng); r.report_type = 0;
    assert(cp_v3_window_observe(&w, &r) == CP_V3_OK && memcmp(previous, w.identifiers[0].token, 16));
    for (unsigned status = 1; status <= 3; ++status) {
        r.kind = 1; r.data_status = status;
        assert(cp_v3_window_observe(&w, &r) == CP_V3_UNSUPPORTED);
    }
    assert(w.identifiers[0].fragment_more == 1 && w.identifiers[0].truncated == 1 && w.identifiers[0].unknown_status == 1);
    assert(w.identifiers[0].parsed == 1 && w.identifiers[0].unsupported == 3);
    seal(&w); emit(&w, fixtures);
    const uint8_t malformed[] = {3,255,76,0,5,255,76};
    ++s.window_seq; begin(&w, s, l, &rng); r = report(malformed, sizeof malformed);
    assert(cp_v3_window_observe(&w, &r) == CP_V3_MALFORMED && !w.identifiers[0].company_count);
    seal(&w); emit(&w, fixtures);
    const uint8_t overflowing[] = {3,255,76,0,3,255,32,0,3,25,64,0,3,25,65,0};
    l.company_limit = l.appearance_limit = 1; ++s.window_seq; begin(&w, s, l, &rng); r = report(overflowing, sizeof overflowing);
    assert(cp_v3_window_observe(&w, &r) == CP_V3_OK && w.identifiers[0].company_overflow && w.identifiers[0].appearance_overflow);
    seal(&w); emit(&w, fixtures);
    l = limits(); l.max_reports = 1; ++s.window_seq; begin(&w, s, l, &rng); r = report(payload, sizeof payload);
    assert(cp_v3_window_observe(&w, &r) == CP_V3_OK && cp_v3_window_observe(&w, &r) == CP_V3_PRESSURE);
    assert(w.identifiers[0].available == 2 && w.identifiers[0].unexamined == 1);
    seal(&w); emit(&w, fixtures);
    l = limits(); l.max_identifiers = 1; ++s.window_seq; begin(&w, s, l, &rng);
    assert(cp_v3_window_observe(&w, &r) == CP_V3_OK); r.address[0] ^= 1;
    assert(cp_v3_window_observe(&w, &r) == CP_V3_ADDRESS_FULL && w.address_overflow_reports == 1);
    seal(&w); emit(&w, fixtures);
    l = limits(); ++s.window_seq; begin(&w, s, l, &rng); r = report(NULL, 0);
    assert(cp_v3_window_observe(&w, &r) == CP_V3_OK);
    assert(cp_v3_window_seal(&w, end(), false, 0, 0) == CP_V3_OK); emit(&w, fixtures);
    uint8_t extended[45] = {40,9}; memset(extended + 2, 'n', 39);
    extended[41] = 3; extended[42] = 255; extended[43] = 32; extended[44] = 0;
    ++s.window_seq; begin(&w, s, l, &rng); r = report(extended, sizeof extended); r.kind = 1;
    assert(cp_v3_window_observe(&w, &r) == CP_V3_OK && w.identifiers[0].company[0].value == 32);
    seal(&w); emit(&w, fixtures); /* Evidence beyond31bytes must survive. */
    l.fields = CP_V3_COMPANY; l.appearance_limit = 0; ++s.window_seq; begin(&w, s, l, &rng);
    r = report(payload, sizeof payload); assert(cp_v3_window_observe(&w, &r) == CP_V3_OK);
    seal(&w); emit(&w, fixtures);
    l = limits(); begin(&w, s, l, &rng);
    for (unsigned i = 0; i < 16; ++i) { r.address[0] = (uint8_t)i; assert(cp_v3_window_observe(&w, &r) == CP_V3_OK); }
    r.address[0] = 16; assert(cp_v3_window_observe(&w, &r) == CP_V3_ADDRESS_FULL && w.count == 16);
    seal(&w); /* The complete window budget, not just each body, is bounded. */
    l.max_evidence_bytes = 1; begin(&w, s, l, &rng);
    assert(cp_v3_window_observe(&w, &r) == CP_V3_OK && cp_v3_window_seal(&w, end(), true, 1, 0) == CP_V3_OUTPUT_FULL);
    assert(cp_v3_feature_body(&w, 0, batch, 1, hash, NULL, body, sizeof body, &size, &expected) == CP_V3_INVALID && size == 0);
    l = limits(); assert(cp_v3_window_begin(&w, &s, &l, start(), no_entropy, NULL) == CP_V3_OK);
    assert(cp_v3_window_observe(&w, &r) == CP_V3_ENTROPY_FAILED && w.failed);
    unsigned calls = 0;
    assert(cp_v3_window_begin(&w, &s, &l, start(), repeated_entropy, &calls) == CP_V3_OK);
    assert(cp_v3_window_observe(&w, &r) == CP_V3_OK); r.address[0] ^= 1;
    assert(cp_v3_window_observe(&w, &r) == CP_V3_ENTROPY_FAILED && calls == 5);
    cp_v3_window_clear(&w); for (size_t i = 0; i < sizeof w; ++i) assert(((uint8_t *)&w)[i] == 0);
    cp_v3_status_t status = {.time = end(), .feature_pending_items = 1, .feature_pending_bytes = 2000};
    assert(cp_v3_status_body(&s, &status, batch, 7, hash, NULL, body, sizeof body, &size, &expected) == CP_V3_OK);
    if (fixtures) printf("{\"body\":%s,\"sha256\":\"%s\"}\n", body, expected.body_sha256);
    char receipt[CP_V3_BODY_MAX];
    int n = snprintf(receipt, sizeof receipt,
        "{\"protocol\":\"campuspulse/3\",\"schema\":\"device-ingest-receipt/3\",\"node_id\":\"%s\",\"boot_id\":\"%s\","
        "\"stream\":\"node_status\",\"batch_id\":\"%s\",\"body_sha256\":\"%s\",\"policy_id\":\"%s\",\"policy_sha256\":\"%s\","
        "\"assignment_generation\":1,\"seq_first\":7,\"seq_last\":7,\"accepted_count\":1,"
        "\"receipt_id\":\"00000000-0000-4000-8000-000000000003\",\"received_at\":\"2026-10-30T00:00:00.000Z\","
        "\"expires_at\":\"2026-10-30T01:00:00.000Z\",\"retain_until\":\"2026-11-06T01:00:00.000Z\","
        "\"durability\":\"committed\",\"custody\":\"private_source\",\"inference\":\"not_performed\",\"window_completeness\":\"not_established\"}",
        s.node_id, s.boot_id, batch, expected.body_sha256, s.policy_id, s.policy_sha256);
    assert(n > 0 && cp_v3_receipt_matches(receipt, (size_t)n, &expected));
    const char *duplicate_key = ",\"seq_first\":7}";
    memcpy(again, receipt, (size_t)n - 1); strcpy(again + n - 1, duplicate_key);
    assert(!cp_v3_receipt_matches(again, strlen(again), &expected));
    memcpy(again, receipt, (size_t)n - 1); strcpy(again + n - 1, ",\"unknown\":1}");
    assert(!cp_v3_receipt_matches(again, strlen(again), &expected));
    strcpy(again, receipt); char *bad_date = strstr(again, "2026-10-30T01"); assert(bad_date);
    bad_date[5] = '0'; bad_date[6] = '2'; /* February30is invalid. */
    assert(!cp_v3_receipt_matches(again, strlen(again), &expected));
    const char *needles[] = {"synthetic-node", "node_status", expected.body_sha256, "committed", "private_source", "not_performed", "not_established", "2026-10-30T01"};
    for (unsigned i = 0; i < sizeof needles / sizeof *needles; ++i) {
        char changed[CP_V3_BODY_MAX]; strcpy(changed, receipt); char *p = strstr(changed, needles[i]); assert(p); *p = 'X';
        assert(!cp_v3_receipt_matches(changed, strlen(changed), &expected));
    }
    assert(!cp_v3_receipt_matches(receipt, (size_t)n - 1, &expected));
    strcpy(again, receipt); strcat(again, "x"); assert(!cp_v3_receipt_matches(again, strlen(again), &expected));
    strcpy(again, receipt); char *p = strstr(again, "\"seq_last\":7"); assert(p); p[11] = '8';
    assert(!cp_v3_receipt_matches(again, strlen(again), &expected));
    assert(cp_v3_status_body(&s, &status, batch, 7, hash, NULL, body, 16, &size, &expected) == CP_V3_OUTPUT_FULL && size == 0 && body[0] == 0);
    assert(!cp_v3_receipt_matches(receipt, (size_t)n, &expected));
    if (!fixtures) puts("v3 evidence: bounded parsing, counts, privacy, budgets, entropy, frozen bytes and strict ACK tests passed");
}
int main(int argc, char **argv) { tests(argc == 2 && !strcmp(argv[1], "fixtures")); return 0; }
