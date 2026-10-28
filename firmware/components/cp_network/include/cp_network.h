#ifndef CP_NETWORK_H
#define CP_NETWORK_H
#include "cp_core.h"
#include "cp_debug.h"
#include "cp_settings.h"
#include "cp_network_diag.h"
#include <stddef.h>
#include <stdint.h>
#define CP_PROTOCOL "campuspulse/2"
#define CP_NETWORK_ADAPTER "cp-nimble-v2"
#define CP_NETWORK_FIRMWARE "campuspulse-passport-v2"
#define CP_NETWORK_BODY_MAX 8192u
#define CP_NETWORK_ITEMS_MAX 16u
#define CP_NETWORK_LEASE_MS 120000u
#define CP_NETWORK_UUID_SIZE 37u
/* Validated complete collector policy. Values unsupported by this firmware are
 * rejected; max_items/body_bytes are safe lowered upload ceilings. */
typedef struct {
    cp_policy_t core;
    char node_id[16], placement_id[65], dataset[17];
    char adapter_version[81];
    uint32_t scan_interval_ms, scan_window_ms;
    bool scan_active, filter_duplicates;
    uint32_t summary_window_ms, summary_bin_ms, max_addresses;
    bool raw_enabled;
    uint32_t sample_every_n, max_raw_per_window;
    uint32_t max_items, max_body_bytes, flush_max_age_ms;
    uint8_t warn_pct, raw_pause_pct, critical_pct, resume_pct;
    bool overload_pause_scan;
    uint64_t lease_ms, request_sequence, fetched_mono_ms;
} cp_network_policy_t;
typedef struct {
    cp_network_state_t network;
    cp_auth_state_t auth;
    bool clock_trusted, policy_valid, policy_present, activation_confirmed;
    /* Runtime memory admission ignores temporary TLS working-set pressure. */
    bool http_in_flight;
    /* Saturating boot-lifetime count; retained across setup/network restarts. */
    uint32_t resource_exhaustions;
    /* Only completed desired GET responses advance this sequence. Transient
     * failures retain the previous grant/time; rejected/expired/unassigned
     * responses invalidate policy immediately and must stop the collector. */
    bool policy_rejected, policy_expired;
    uint64_t policy_response_sequence;
    char desired_config_id[65];
    uint64_t clock_mono_ms, clock_utc_ms;
    uint32_t clock_epoch, clock_uncertainty_ms;
    /* HTTPS server-time midpoint/half-RTT estimate; excludes unknown absolute
     * server clock error. Caller grows by conservative oscillator drift age. */
    bool clock_estimated;
    cp_network_policy_t policy;
    char applied_config_id[65];
    uint32_t connection_failures, upload_failures, ack_failures;
    int last_http_status;
    esp_err_t last_error;
    cp_network_diagnostic_t diagnostic;
} cp_network_snapshot_t;
typedef struct {
    char node_id[16], boot_id[37], batch_id[65], stream[24], body_sha256[65];
    uint32_t accepted_count;
} cp_network_batch_t;
typedef enum {
    CP_NET_UPLOAD_ACKED, CP_NET_UPLOAD_RETRY, CP_NET_UPLOAD_REJECTED,
    CP_NET_UPLOAD_AUTH, CP_NET_UPLOAD_POLICY, CP_NET_UPLOAD_BAD_ACK
} cp_net_upload_result_t;
typedef struct { int http_status; char receipt_id[65]; } cp_network_ack_t;
/* Called once with immutable factory identity and a new random UUIDv4 per boot.
 * Provisioning must have completely stopped/deinitialized its Wi-Fi before start.
 * No APIs are safe in radio callbacks; copy candidates into a task-owned queue. */
esp_err_t cp_network_init(const char *node_id, const char *boot_id);
esp_err_t cp_network_start(const cp_settings_t *settings);
esp_err_t cp_network_stop(void);
void cp_network_snapshot(cp_network_snapshot_t *out);
/* Supervisor task only, at most once/second. Samples current driver association
 * and copies ingest-only metrics; never changes Wi-Fi configuration. */
void cp_network_debug_snapshot(cp_debug_snapshot_t *out);
/* Returns latest validated policy; root uses request_sequence to renew core's
 * monotonic lease but only applies hardware when config ID actually changes. */
bool cp_network_get_policy(cp_network_policy_t *out);
/* Worker-task memory admission, shared with network transports and radio startup. A zero
 * timeout is nonblocking; waits are bounded to 15 seconds. Never nest claims. */
bool cp_network_begin_memory_work(uint32_t timeout_ms);
/* Uploader only: may preserve a bounded idle transport when its post-allocation
 * RAM reserve is sufficient. Encoders/radio must use the generic claim. HTTPS releases idle TLS; MQTT
 * retains its established session with automatic TLS reconnect disabled. Pair with end_memory_work in the same task. */
bool cp_network_begin_upload_memory_work(uint32_t timeout_ms,size_t allocation_bytes);
/* Under a successful upload-memory claim, immediately after malloc and before
 * the store lock: close idle TLS on failed allocation or insufficient actual
 * active-attempt RAM. Returns whether the remaining active budget is adequate. */
bool cp_network_upload_memory_ready(bool allocation_succeeded);
void cp_network_end_memory_work(void);
/* Runtime task only: nonblocking admission against transport working-set
 * allocations. Pair every successful claim with end in the same task, before
 * calling report_activation (which acquires the same resource). */
bool cp_network_begin_radio_transition(void);
void cp_network_end_radio_transition(void);
/* Stage report only after actual application/failure. Worker retries current
 * application sequence; stale failures cannot overwrite a newer success. */
esp_err_t cp_network_report_activation(const char *config_id, bool applied, const char *reason);
void cp_network_set_capture_state(const char *state);
/* Starts temporary network, waits for verified authenticated cloud response,
 * then stops it. Does not save credentials. Missing assignment is success;
 * bad Wi-Fi/TLS/auth leaves the previous NVS record untouched. */
esp_err_t cp_network_validate_candidate(const cp_settings_t *settings, uint32_t timeout_ms);
esp_err_t cp_network_validate_candidate_with_progress(const cp_settings_t *settings,
    uint32_t timeout_ms,cp_network_progress_fn progress,void *context);
void cp_network_diagnostic_snapshot(cp_network_diagnostic_t *out);
/* At most one transport RPC. Caller retains exact bytes/identity on any result
 * except ACKED; caller schedules bounded retries. No redirects are followed. */
cp_net_upload_result_t cp_network_upload_frozen(const void *body, size_t length,
    const cp_network_batch_t *expected, cp_network_ack_t *ack);
/* Upload worker, immediately AFTER freeing its immutable body, with no memory
 * or store claim held. Optional for callers that do not want reuse: an omitted
 * finalization expires the provisional transport in the control worker. */
void cp_network_finalize_upload_body(void);
typedef enum { CP_ACK_CANONICAL_MATCH, CP_ACK_CANONICAL_INVALID,
               CP_ACK_NEEDS_GENERAL } cp_ack_canonical_result_t;
/* Allocation-free canonical Worker ACK path. NEEDS_GENERAL must close any
 * retained TLS client before calling the general parser below. */
cp_ack_canonical_result_t cp_network_parse_ack_canonical(const char *json,size_t length,
    const cp_network_batch_t *expected,cp_network_ack_t *ack);
/* Pure protocol checks for meaningful host regression tests. */
bool cp_network_parse_policy(const char *json, size_t length, const char *node_id,
    cp_network_policy_t *out, bool *present, bool *expired);
bool cp_network_parse_ack(const char *json, size_t length,
    const cp_network_batch_t *expected, cp_network_ack_t *ack);
bool cp_network_sha256(const void *bytes, size_t length, char output[65]);
#endif
