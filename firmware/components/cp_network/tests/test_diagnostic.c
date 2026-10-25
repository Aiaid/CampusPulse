#include "cp_network_diag.h"
#include "nvs.h"
#include <assert.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Only this one bounded record is permitted in the diagnostics namespace. */
enum { WIRE_SIZE = 120, MOCK_CAPACITY = WIRE_SIZE + 1 };
typedef struct { bool present; size_t size; uint8_t bytes[MOCK_CAPACITY]; } blob_t;
static blob_t saved, pending;
static esp_err_t open_error, get_error, set_error, commit_error;
static unsigned opens, closes, reads, sets, commits;
static int current_mode;
static bool handle_open;

esp_err_t nvs_open(const char *name, int mode, nvs_handle_t *handle)
{
    assert(!strcmp(name, "cp_diag") && !handle_open);
    assert(mode == NVS_READONLY || mode == NVS_READWRITE);
    ++opens;
    if (open_error != ESP_OK) return open_error;
    current_mode = mode; handle_open = true; pending = saved; *handle = 1;
    return ESP_OK;
}
void nvs_close(nvs_handle_t handle)
{
    assert(handle == 1 && handle_open);
    ++closes; handle_open = false; pending = saved;
}
esp_err_t nvs_get_blob(nvs_handle_t handle, const char *key, void *out, size_t *size)
{
    assert(handle == 1 && handle_open && current_mode == NVS_READONLY);
    assert(!strcmp(key, "last_attempt") && out && size);
    ++reads;
    if (get_error != ESP_OK) return get_error;
    if (!saved.present) return ESP_ERR_NVS_NOT_FOUND;
    if (*size < saved.size) { *size = saved.size; return ESP_ERR_INVALID_SIZE; }
    memcpy(out, saved.bytes, saved.size); *size = saved.size;
    return ESP_OK;
}
esp_err_t nvs_set_blob(nvs_handle_t handle, const char *key, const void *in, size_t size)
{
    assert(handle == 1 && handle_open && current_mode == NVS_READWRITE);
    assert(!strcmp(key, "last_attempt") && in && size == WIRE_SIZE);
    ++sets;
    if (set_error != ESP_OK) return set_error;
    memcpy(pending.bytes, in, size); pending.size = size; pending.present = true;
    return ESP_OK;
}
esp_err_t nvs_commit(nvs_handle_t handle)
{
    assert(handle == 1 && handle_open && current_mode == NVS_READWRITE);
    ++commits;
    if (commit_error != ESP_OK) return commit_error;
    saved = pending;
    return ESP_OK;
}
static void reset_mock(void)
{
    assert(!handle_open);
    memset(&saved, 0, sizeof saved); memset(&pending, 0, sizeof pending);
    open_error = get_error = set_error = commit_error = ESP_OK;
    opens = closes = reads = sets = commits = 0;
}
static cp_network_attempt_t example(void)
{
    /* Poison padding: serialization must expose only the explicit fields. */
    cp_network_attempt_t a;
    memset(&a, 0xa5, sizeof a);
    a.version = 1; a.state = CP_ATTEMPT_FAILED;
    memcpy(a.attempt_id, "12345678-1234-4234-8234-123456789abc", 37);
    memcpy(a.boot_id, "abcdef01-2345-4678-9abc-def012345678", 37);
    a.diagnostic = (cp_network_diagnostic_t){
        .stage = CP_DIAG_TLS, .code = CP_DIAG_TLS_CERTIFICATE_FAILED,
        .esp_err = -1, .http_status = 503, .wifi_reason = 202,
        .tls_code = -0x2700, .tls_flags = 0xa1b2c3d4,
        .elapsed_ms = 90000, .retryable = 1, .terminal = 1,
    };
    return a;
}
static void assert_zero(const void *value, size_t size)
{
    const uint8_t *bytes = value;
    for (size_t i = 0; i < size; ++i) assert(bytes[i] == 0);
}
static void assert_same(const cp_network_attempt_t *a, const cp_network_attempt_t *b)
{
    assert(a->version == b->version && a->state == b->state);
    assert(!memcmp(a->attempt_id, b->attempt_id, 37));
    assert(!memcmp(a->boot_id, b->boot_id, 37));
    assert(a->diagnostic.stage == b->diagnostic.stage);
    assert(a->diagnostic.code == b->diagnostic.code);
    assert(a->diagnostic.esp_err == b->diagnostic.esp_err);
    assert(a->diagnostic.http_status == b->diagnostic.http_status);
    assert(a->diagnostic.wifi_reason == b->diagnostic.wifi_reason);
    assert(a->diagnostic.tls_code == b->diagnostic.tls_code);
    assert(a->diagnostic.tls_flags == b->diagnostic.tls_flags);
    assert(a->diagnostic.elapsed_ms == b->diagnostic.elapsed_ms);
    assert(a->diagnostic.retryable == b->diagnostic.retryable);
    assert(a->diagnostic.terminal == b->diagnostic.terminal);
}
static void test_safe_diagnostic(void)
{
    cp_network_diagnostic_t d = example().diagnostic;
    assert(cp_network_diag_valid(&d) && !cp_network_diag_valid(NULL));
    cp_network_diag_reset(NULL);
    cp_network_diag_reset(&d); assert_zero(&d, sizeof d);
    assert(cp_network_diag_valid(&d));
    d.http_status = 599; d.wifi_reason = 255;
    d.tls_code = INT32_MIN; d.esp_err = INT32_MAX;
    d.tls_flags = UINT32_MAX; d.elapsed_ms = UINT32_MAX;
    assert(cp_network_diag_valid(&d));
#define REJECT_FIELD(field, value) do { \
    cp_network_diagnostic_t bad = d; bad.field = (value); \
    assert(!cp_network_diag_valid(&bad)); \
} while (0)
    REJECT_FIELD(stage, (cp_diag_stage_t)-1);
    REJECT_FIELD(stage, CP_DIAG_STAGE_COUNT);
    REJECT_FIELD(code, (cp_diag_code_t)-1);
    REJECT_FIELD(code, CP_DIAG_CODE_COUNT);
    REJECT_FIELD(http_status, -1); REJECT_FIELD(http_status, 600);
    REJECT_FIELD(wifi_reason, -1); REJECT_FIELD(wifi_reason, 256);
    REJECT_FIELD(retryable, 2); REJECT_FIELD(terminal, 255);
#undef REJECT_FIELD
    cp_network_diagnostic_t before; memcpy(&before, &d, sizeof d);
    cp_network_diag_update(NULL, CP_DIAG_TLS, CP_DIAG_TLS_FAILED, -1, 1, true, true);
    cp_network_diag_update(&d, (cp_diag_stage_t)-1, CP_DIAG_TLS_FAILED, -1, 1, true, true);
    assert(!memcmp(&d, &before, sizeof d));
    cp_network_diag_update(&d, CP_DIAG_TLS, CP_DIAG_CODE_COUNT, -1, 1, true, true);
    assert(!memcmp(&d, &before, sizeof d));
    cp_network_diag_update(&d, CP_DIAG_CLOUD_AUTH, CP_DIAG_CLOUD_AUTH_FAILED, ESP_FAIL, 123, true, false);
    assert(d.stage == CP_DIAG_CLOUD_AUTH && d.code == CP_DIAG_CLOUD_AUTH_FAILED);
    assert(d.esp_err == ESP_FAIL && d.elapsed_ms == 123 && d.retryable == 1 && d.terminal == 0);
    assert(d.http_status == 599 && d.wifi_reason == 255 && d.tls_code == INT32_MIN && d.tls_flags == UINT32_MAX);
    for (int i = 0; i < CP_DIAG_STAGE_COUNT; ++i) {
        const char *name = cp_network_diag_stage_name((cp_diag_stage_t)i);
        assert(name && *name);
        for (const char *p = name; *p; ++p) assert((*p >= 'a' && *p <= 'z') || *p == '_');
    }
    for (int i = 0; i < CP_DIAG_CODE_COUNT; ++i) {
        const char *name = cp_network_diag_code_name((cp_diag_code_t)i);
        assert(name && *name);
        for (const char *p = name; *p; ++p) assert((*p >= 'a' && *p <= 'z') || *p == '_');
    }
    assert(!strcmp(cp_network_diag_stage_name((cp_diag_stage_t)-1), "idle"));
    assert(!strcmp(cp_network_diag_stage_name(CP_DIAG_STAGE_COUNT), "idle"));
    assert(!strcmp(cp_network_diag_code_name((cp_diag_code_t)-1), "validation_timeout"));
    assert(!strcmp(cp_network_diag_code_name(CP_DIAG_CODE_COUNT), "validation_timeout"));
}
static void test_wifi_and_timeout(void)
{
    const unsigned unavailable[] = {201, 210, 211, 212};
    const unsigned authentication[] = {2, 15, 202, 204};
    for (unsigned reason = 0; reason <= 255; ++reason) {
        cp_diag_code_t expected = CP_DIAG_WIFI_CONNECT_FAILED;
        for (size_t i = 0; i < sizeof unavailable / sizeof unavailable[0]; ++i)
            if (reason == unavailable[i]) expected = CP_DIAG_WIFI_NOT_FOUND;
        for (size_t i = 0; i < sizeof authentication / sizeof authentication[0]; ++i)
            if (reason == authentication[i]) expected = CP_DIAG_WIFI_AUTH_FAILED;
        assert(cp_network_diag_wifi_reason(reason) == expected);
    }
    assert(cp_network_diag_wifi_reason(UINT_MAX) == CP_DIAG_WIFI_CONNECT_FAILED);
    const cp_diag_code_t expected[] = {
        CP_DIAG_VALIDATION_TIMEOUT, CP_DIAG_VALIDATION_TIMEOUT, CP_DIAG_WIFI_TIMEOUT,
        CP_DIAG_DHCP_TIMEOUT, CP_DIAG_CLOCK_TIMEOUT, CP_DIAG_DNS_TIMEOUT,
        CP_DIAG_TLS_TIMEOUT, CP_DIAG_CLOUD_TIMEOUT, CP_DIAG_SAVE_FAILED, CP_DIAG_VALIDATION_TIMEOUT,
    };
    assert(sizeof expected / sizeof expected[0] == CP_DIAG_STAGE_COUNT);
    for (unsigned stage = 0; stage < CP_DIAG_STAGE_COUNT; ++stage) {
        cp_network_diagnostic_t d = {.stage = (cp_diag_stage_t)stage};
        assert(cp_network_diag_timeout_code(&d) == expected[stage]);
    }
    cp_network_diagnostic_t d = {.stage = CP_DIAG_WIFI_CONNECT, .wifi_reason = 202};
    assert(cp_network_diag_timeout_code(&d) == CP_DIAG_WIFI_AUTH_FAILED);
    d.wifi_reason = 201; assert(cp_network_diag_timeout_code(&d) == CP_DIAG_WIFI_NOT_FOUND);
    d.wifi_reason = 1; assert(cp_network_diag_timeout_code(&d) == CP_DIAG_WIFI_CONNECT_FAILED);
    d.stage = (cp_diag_stage_t)-1;
    assert(cp_network_diag_timeout_code(&d) == CP_DIAG_VALIDATION_TIMEOUT);
    assert(cp_network_diag_timeout_code(NULL) == CP_DIAG_VALIDATION_TIMEOUT);
}
static void test_attempt_validation(void)
{
    cp_network_attempt_t a = example();
    assert(cp_network_attempt_valid(&a) && !cp_network_attempt_valid(NULL));
    for (int state = CP_ATTEMPT_INTERRUPTED; state <= CP_ATTEMPT_SAVED; ++state) {
        a.state = (cp_attempt_state_t)state; assert(cp_network_attempt_valid(&a));
    }
#define REJECT_ATTEMPT(field, value) do { \
    cp_network_attempt_t bad = a; bad.field = (value); \
    assert(!cp_network_attempt_valid(&bad)); \
    unsigned calls = opens; assert(cp_network_attempt_save(&bad) == ESP_ERR_INVALID_ARG); \
    assert(opens == calls); \
} while (0)
    REJECT_ATTEMPT(version, 0); REJECT_ATTEMPT(version, 2); REJECT_ATTEMPT(version, UINT32_MAX);
    REJECT_ATTEMPT(state, (cp_attempt_state_t)0); REJECT_ATTEMPT(state, (cp_attempt_state_t)4);
    REJECT_ATTEMPT(state, (cp_attempt_state_t)-1);
    REJECT_ATTEMPT(diagnostic.http_status, -1);
    REJECT_ATTEMPT(diagnostic.retryable, 2);
#undef REJECT_ATTEMPT
    for (unsigned which = 0; which < 2; ++which) {
        for (size_t i = 0; i < 37; ++i) {
            cp_network_attempt_t bad = a;
            char *id = which ? bad.boot_id : bad.attempt_id;
            id[i] = i == 36 ? 'f' : 'G';
            assert(!cp_network_attempt_valid(&bad));
        }
        cp_network_attempt_t bad = a; char *id = which ? bad.boot_id : bad.attempt_id;
        id[14] = '3'; assert(!cp_network_attempt_valid(&bad));
        bad = a; id = which ? bad.boot_id : bad.attempt_id;
        id[19] = '7'; assert(!cp_network_attempt_valid(&bad));
        bad = a; id = which ? bad.boot_id : bad.attempt_id;
        id[0] = 'A'; assert(!cp_network_attempt_valid(&bad));
        bad = a; id = which ? bad.boot_id : bad.attempt_id;
        id[0] = 0; assert(!cp_network_attempt_valid(&bad));
        for (const char *variant = "89ab"; *variant; ++variant) {
            bad = a; id = which ? bad.boot_id : bad.attempt_id;
            id[19] = *variant; assert(cp_network_attempt_valid(&bad));
        }
    }
    unsigned calls = opens;
    assert(cp_network_attempt_save(NULL) == ESP_ERR_INVALID_ARG && opens == calls);
    assert(cp_network_attempt_load(NULL) == ESP_ERR_INVALID_ARG && opens == calls);
}
static void assert_load_error(esp_err_t expected)
{
    cp_network_attempt_t out; memset(&out, 0xa5, sizeof out);
    assert(cp_network_attempt_load(&out) == expected);
    assert_zero(&out, sizeof out); assert(!handle_open);
}
static void test_storage(void)
{
    reset_mock();
    assert_load_error(ESP_ERR_NOT_FOUND);
    assert(opens == 1 && reads == 1 && closes == 1 && sets == 0 && commits == 0);
    open_error = ESP_ERR_NVS_NOT_FOUND; assert_load_error(ESP_ERR_NOT_FOUND);
    open_error = ESP_FAIL; assert_load_error(ESP_FAIL);
    assert(closes == 1); open_error = ESP_OK;

    cp_network_attempt_t *a = malloc(sizeof *a); assert(a); *a = example();
    assert(cp_network_attempt_save(a) == ESP_OK);
    /* Independent fixed fixture freezes the allowlisted versioned wire schema.
     * Exact length/content excludes struct padding, SSID, token, addresses and
     * arbitrary strings; the two permitted correlation IDs are synthetic. */
    static const uint8_t expected[] =
        "CPD1" "\x01\x00\x00\x00" "\x02\x00\x00\x00"
        "12345678-1234-4234-8234-123456789abc\0"
        "abcdef01-2345-4678-9abc-def012345678\0"
        "\x06\x00\x00\x00" "\x13\x00\x00\x00" "\xff\xff\xff\xff"
        "\xf7\x01\x00\x00" "\xca\x00\x00\x00" "\x00\xd9\xff\xff"
        "\xd4\xc3\xb2\xa1" "\x90\x5f\x01\x00" "\x01\x01";
    _Static_assert(sizeof expected - 1 == WIRE_SIZE, "diagnostic fixture length");
    assert(saved.size == WIRE_SIZE && !memcmp(saved.bytes, expected, WIRE_SIZE));
    cp_network_attempt_t out;
    assert(cp_network_attempt_load(&out) == ESP_OK); assert_same(a, &out);
    blob_t baseline = saved;
    unsigned write_count = sets, commit_count = commits;
    assert(cp_network_attempt_load(&out) == ESP_OK);
    assert(sets == write_count && commits == commit_count); /* Reads never rewrite. */

    a->state = CP_ATTEMPT_SAVED; a->diagnostic.code = CP_DIAG_SAVED;
    for (unsigned fault = 0; fault < 3; ++fault) {
        unsigned before_set = sets, before_commit = commits, before_close = closes;
        if (fault == 0) open_error = ESP_FAIL;
        if (fault == 1) set_error = ESP_FAIL;
        if (fault == 2) commit_error = ESP_FAIL;
        assert(cp_network_attempt_save(a) == ESP_FAIL && !handle_open);
        assert(!memcmp(&saved, &baseline, sizeof saved));
        assert(sets == before_set + (fault != 0));
        assert(commits == before_commit + (fault == 2));
        assert(closes == before_close + (fault != 0));
        open_error = set_error = commit_error = ESP_OK;
        assert(cp_network_attempt_load(&out) == ESP_OK);
        cp_network_attempt_t original = example(); assert_same(&original, &out);
    }
    assert(cp_network_attempt_save(a) == ESP_OK);
    assert(cp_network_attempt_load(&out) == ESP_OK); assert_same(a, &out);
    free(a);

    saved = baseline;
    get_error = ESP_FAIL; assert_load_error(ESP_FAIL);
    get_error = ESP_ERR_NVS_NOT_FOUND; assert_load_error(ESP_ERR_NOT_FOUND);
    get_error = ESP_OK;
    for (size_t size = 0; size < WIRE_SIZE; ++size) {
        saved = baseline; saved.size = size; assert_load_error(ESP_ERR_INVALID_STATE);
    }
    saved = baseline; saved.size = WIRE_SIZE + 1; assert_load_error(ESP_ERR_INVALID_SIZE);
    const size_t corrupt_offsets[] = {
        0, 1, 2, 3, 4, 8, 12, 48, 49, 85, /* magic/version/state/UUIDs */
        86, 90, 99, 103, 118, 119,          /* enums/bounded numerics/flags */
    };
    for (size_t i = 0; i < sizeof corrupt_offsets / sizeof corrupt_offsets[0]; ++i) {
        saved = baseline; saved.bytes[corrupt_offsets[i]] = 0xff;
        assert_load_error(ESP_ERR_INVALID_STATE);
    }
    /* Numeric errors remain signed evidence; they are never parsed as strings. */
    saved = baseline; memset(saved.bytes + 94, 0x80, 4); memset(saved.bytes + 106, 0x80, 4);
    assert(cp_network_attempt_load(&out) == ESP_OK);
    assert(out.diagnostic.esp_err == (int32_t)0x80808080u && out.diagnostic.tls_code == (int32_t)0x80808080u);
    assert(!handle_open);
}
static void test_preserve_failure_at_deadline(void)
{
    cp_network_diag_finish_timeout(NULL,90000);
    cp_network_diagnostic_t d={0};
    cp_network_diag_update(&d,CP_DIAG_TLS,CP_DIAG_TLS_CERTIFICATE_FAILED,ESP_FAIL,12000,false,false);
    d.tls_code=-123;d.tls_flags=8;
    cp_network_diag_finish_timeout(&d,90000);
    assert(d.code==CP_DIAG_TLS_CERTIFICATE_FAILED && d.esp_err==ESP_FAIL && d.tls_code==-123 && d.tls_flags==8 && d.terminal && d.elapsed_ms==90000);
    cp_network_diag_reset(&d);
    cp_network_diag_update(&d,CP_DIAG_CLOUD_AUTH,CP_DIAG_RESOURCE_EXHAUSTED,ESP_ERR_NO_MEM,14000,true,false);
    cp_network_diag_finish_timeout(&d,90000);
    assert(d.code==CP_DIAG_RESOURCE_EXHAUSTED && d.esp_err==ESP_ERR_NO_MEM && d.terminal);
    cp_network_diag_reset(&d);
    cp_network_diag_update(&d,CP_DIAG_TLS,CP_DIAG_TLS_CONNECTING,ESP_OK,14000,true,false);
    cp_network_diag_finish_timeout(&d,90000);
    assert(d.code==CP_DIAG_TLS_TIMEOUT && d.esp_err==ESP_ERR_TIMEOUT && d.terminal);
    cp_network_diagnostic_t original=d;cp_network_diag_finish_timeout(&d,91000);
    assert(!memcmp(&d,&original,sizeof d));
}
int main(void)
{
    test_preserve_failure_at_deadline(); test_safe_diagnostic(); test_wifi_and_timeout(); test_attempt_validation(); test_storage();
    puts("diagnostics: safe enums/numerics, Wi-Fi/timeouts, canonical NVS schema, corrupt history and write faults passed");
}
