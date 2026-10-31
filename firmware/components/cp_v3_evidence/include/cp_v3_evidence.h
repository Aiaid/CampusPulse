#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* Pure bounded building block, not a runtime, capability registration, uploader,
 * policy validator or durable queue. No TF, display, radio or credential API.
 * Supports only all_worker_reports, company IDs and Appearance. No categories,
 * UUIDs, names or templates. Adapters must not advertise unsupported fields.
 * Raw address/type mappings live only in window RAM and never serialize.
 * Entropy must be cryptographic; SHA callback must compute actual SHA-256.
 */
#define CP_V3_EXTRACTOR "cp-v3-ad/1"
#define CP_V3_PRODUCER "cp-v3-producer/1"
#define CP_V3_MAX_IDENTIFIERS 16u
#define CP_V3_BODY_MAX 4096u
#define CP_V3_COMPANY 1u
#define CP_V3_APPEARANCE 2u
#define CP_V3_REPORT_LIMIT 10000000u
typedef enum { CP_V3_OK, CP_V3_INVALID, CP_V3_UNSUPPORTED, CP_V3_MALFORMED,
    CP_V3_PRESSURE, CP_V3_ADDRESS_FULL, CP_V3_ENTROPY_FAILED, CP_V3_OUTPUT_FULL } cp_v3_result_t;
typedef bool (*cp_v3_entropy_fn)(void *, uint8_t token[16]);
typedef bool (*cp_v3_sha256_fn)(void *, const void *, size_t, uint8_t digest[32]);
typedef struct { uint64_t mono_ms, utc_ms; uint32_t clock_epoch, uncertainty_ms; } cp_v3_time_t;
typedef struct {
    char node_id[65], boot_id[37], placement_id[65], policy_id[65], policy_sha256[65], dataset[17];
    uint64_t assignment_generation;
    uint32_t window_seq;
} cp_v3_scope_t;
typedef struct {
    uint32_t window_ms, max_reports, max_evidence_bytes;
    uint8_t max_identifiers, fields, company_limit, appearance_limit;
} cp_v3_limits_t;
typedef struct { uint16_t value; uint32_t support, adv, scan_response; } cp_v3_value_t;
typedef struct {
    uint8_t address[6], address_type, token[16];
    uint32_t available, examined, parsed, malformed, unsupported, unexamined, adv, scan_response;
    uint32_t fragment_more, truncated, unknown_status; /* Examined report diagnostics; wire uses unsupported_reports. */
    cp_v3_value_t company[4], appearance[2];
    uint8_t company_count, appearance_count;
    bool company_overflow, appearance_overflow;
} cp_v3_identifier_t;
typedef struct {
    cp_v3_scope_t scope;
    cp_v3_limits_t limits;
    cp_v3_time_t start, end;
    cp_v3_identifier_t identifiers[CP_V3_MAX_IDENTIFIERS];
    uint32_t worker_reports, aggregated_reports, address_overflow_reports, examined_reports;
    uint32_t ingress_seen, ingress_drops, evidence_bytes;
    uint8_t count;
    bool ingress_known, sealed, failed;
    cp_v3_entropy_fn entropy;
    void *entropy_context;
} cp_v3_window_t;
typedef struct {
    uint8_t address[6], address_type;
    uint8_t kind; /* 0 legacy, 1 extended; neither implies complete payload. */
    uint8_t data_status; /* 0 complete, 1 more fragments, 2 truncated. */
    uint8_t report_type; /* 0 ADV, 1 SCAN_RSP; other values unsupported. */
    const uint8_t *payload;
    size_t length;
} cp_v3_report_t;
typedef struct {
    cp_v3_scope_t scope;
    char batch_id[37], body_sha256[65], stream[24];
    uint32_t seq_first, seq_last, accepted_count;
    size_t body_bytes;
} cp_v3_expected_t;
typedef struct {
    cp_v3_time_t time;
    bool failed, paused;
    uint32_t feature_pending_items, feature_pending_bytes, status_pending_items, status_pending_bytes;
    uint32_t feature_items_dropped, feature_bytes_dropped, status_samples_coalesced, upload_failures, ack_failures;
} cp_v3_status_t;

cp_v3_result_t cp_v3_window_begin(cp_v3_window_t *, const cp_v3_scope_t *, const cp_v3_limits_t *,
    cp_v3_time_t start, cp_v3_entropy_fn, void *);
cp_v3_result_t cp_v3_window_observe(cp_v3_window_t *, const cp_v3_report_t *);
/* seen/drops are callback-source claims; omit rather than invent zero if unknown.
 * Seal fails before any body is available if the complete evidence byte budget
 * does not fit. Overflow values are unknown-count/partial, never silently zero.
 */
cp_v3_result_t cp_v3_window_seal(cp_v3_window_t *, cp_v3_time_t end,
    bool ingress_known, uint32_t seen, uint32_t drops);
void cp_v3_window_clear(cp_v3_window_t *);
cp_v3_result_t cp_v3_feature_body(const cp_v3_window_t *, unsigned identifier_index,
    const char *batch_id, uint32_t seq, cp_v3_sha256_fn, void *, char *, size_t, size_t *, cp_v3_expected_t *);
cp_v3_result_t cp_v3_status_body(const cp_v3_scope_t *, const cp_v3_status_t *, const char *batch_id,
    uint32_t seq, cp_v3_sha256_fn, void *, char *, size_t, size_t *, cp_v3_expected_t *);
/* Strict bounded flat JSON receipt parser. All required identities/commit fields
 * and counters match. Unknown/duplicate fields, escapes, nested values, invalid
 * dates, unsafe integers and trailing bytes fail closed. No reclaim is performed.
 * Receipts from the current server are unescaped ASCII; other encodings require
 * a reviewed parser extension instead of optimistic acceptance.
 */
bool cp_v3_receipt_matches(const void *, size_t, const cp_v3_expected_t *);
/* Independent compact statistics route: new receipt schema/custody, only
 * window_statistics/candidate_events/node_status. Legacy matcher unchanged. */
bool cp_v3_statistics_receipt_matches(const void *,size_t,const cp_v3_expected_t *);
