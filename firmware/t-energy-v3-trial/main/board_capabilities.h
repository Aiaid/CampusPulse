#pragma once
#include "board_resources.h"
#include <stdint.h>

/* Upload bodies, not the larger capability/registration JSON itself. */
#define TE_V3_CAPABILITY_BODY_MAX 1024u
#define TE_V3_CAPABILITY_QUEUE_BYTES 3072u
#define TE_V3_CAPABILITY_QUEUE_ITEMS 3u

/* All inputs are caller-owned evidence, never values inferred from the board's
 * nominal RAM/Flash size. This builder neither allocates nor reserves anything.
 * Recheck admission at policy apply and every durable push. Serialize callers
 * with memory/queue owners; snapshots can become stale immediately. */
typedef struct {
    uint64_t measured_at_utc_ms, valid_until_utc_ms;
    te_v3_pools_t pools;
    te_v3_resource_sizes_t allocated;
    te_v3_pool_external_t external;
    void *external_context;
    bool arenas_initialized_verified;
    size_t report_slots;
    size_t psram_free_bytes, psram_headroom_bytes;
    size_t internal_free_bytes, internal_headroom_bytes;
    /* Includes actual allocated arenas plus additional measured PSRAM budget;
     * rolling must also cover the backend's conservative cross-ABI floor. */
    uint64_t working_budget_bytes, storage_write_budget_bytes_per_day;
    /* Measured worst-case processing time for exactly the advertised profile,
     * including rolling history when present. Not a future throughput promise. */
    bool cpu_profile_verified, scanner_profile_verified;
    uint64_t measured_cpu_us_per_window, cpu_budget_us_per_window;
    /* Actual read-only queue/recovery checks under the NVS owner's lock.
     * All three slots must be free (damaged/foreign/tombstone keys count used).
     * Body budgets exclude encoded-record/NVS overhead, checked separately. */
    /* Must be based on the actual medium's power-loss/recovery acceptance,
     * not only host fault injection or an NVS read-only capacity snapshot. */
    bool queue_recovery_verified, queue_power_loss_verified, queue_budget_is_not_physical_reservation;
    uint32_t free_queue_slots;
    uint64_t queue_body_budget_bytes, queue_item_budget, available_nvs_entries;
} te_v3_capability_evidence_t;

typedef struct {
    char node_id[65], boot_id[37], capability_id[65];
    uint64_t issued_at_utc_ms, expires_at_utc_ms;
    uint16_t max_addresses;
    uint8_t max_bins;
    uint32_t max_window_ms, min_scan_interval_units, max_scan_interval_units;
    /* NULL grants no rolling-history capability. Otherwise only this exact
     * slice/history/track/event profile is claimed, with report mode off.
     * An initialized, externally placed arena is required in evidence. */
    const cp_v3_temporal_config_t *temporal;
    const te_v3_capability_evidence_t *evidence;
} te_v3_capability_request_t;

typedef enum {
    TE_V3_CAPABILITIES_OK, TE_V3_CAPABILITIES_INVALID,
    TE_V3_CAPABILITIES_UNPROVEN, TE_V3_CAPABILITIES_NO_SPACE
} te_v3_capability_result_t;

/* now_lower/upper are trusted conservative UTC bounds, not an unknown-clock
 * sentinel. The full capability lifetime must fit the evidence validity.
 * Strings use the control parser's strict ASCII IDs / lowercase UUIDv4 syntax.
 * No TF, raw archive/sampling, feature or candidate-event upload is advertised.
 * out must not alias request/evidence/arenas. Failure sets length=0 and clears
 * out[0] when provided; a partial JSON can never be used as a capability. */
te_v3_capability_result_t te_v3_capabilities_build(
    const te_v3_capability_request_t *, uint64_t now_lower_utc_ms,
    uint64_t now_upper_utc_ms, char *out, size_t capacity, size_t *length);
