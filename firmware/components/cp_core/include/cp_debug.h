#ifndef CP_DEBUG_H
#define CP_DEBUG_H
#include <stdbool.h>
#include <stdint.h>

/* Local display telemetry only. No credentials, BSSID or cloud identifiers.
 * All byte counters describe payload/journal data, never radio throughput. */
typedef enum {
    CP_DEBUG_UPLOAD_NONE, CP_DEBUG_UPLOAD_ACKED, CP_DEBUG_UPLOAD_RETRY,
    CP_DEBUG_UPLOAD_REJECTED, CP_DEBUG_UPLOAD_AUTH, CP_DEBUG_UPLOAD_POLICY,
    CP_DEBUG_UPLOAD_BAD_ACK
} cp_debug_upload_result_t;
typedef struct {
    bool known, in_flight;
    cp_debug_upload_result_t result; /* Latest completed attempt, not last success. */
    uint32_t attempt_bytes, attempt_elapsed_ms;
    uint32_t last_bytes, last_elapsed_ms, last_age_ms;
    int32_t last_http_status, last_error;
    uint32_t consecutive_failures, failures;
    /* Latest attempt only: zero for any unverified response. */
    uint32_t acked_bytes, goodput_bytes_per_sec;
    bool goodput_known;
} cp_debug_upload_t;

typedef enum {
    CP_DEVICE_PAGE_DEBUG, CP_DEVICE_PAGE_ACTIVITY, CP_DEVICE_PAGE_VEHICLE,
    CP_DEVICE_PAGE_ELEVATOR, CP_DEVICE_PAGE_COUNT
} cp_device_page_t;
#define CP_DEBUG_DOMAIN_BINS 16u
/* Worker-published bounded aggregate slice. No address/name/payload/identifier.
 * A bin counts processed BLE reports, including address-table overflow reports.
 * Ingress losses have unknown bin times and are excluded; bins are never person
 * counts or inferred occupancy. age_ms measures publication freshness.
 * Candidate evidence means a brand-name mask with no exclusion evidence; this
 * diagnostic rule does not implement the server's vehicle inference model. */
typedef struct {
    bool known, window_partial, address_overflow;
    uint8_t bin_count;
    uint32_t window_seq, window_ms, bin_ms, age_ms;
    uint32_t reports_seen, reports_aggregated, addresses;
    uint32_t aggregation_drops, summary_drops, rssi_samples;
    int16_t rssi_min, rssi_mean, rssi_max;
    uint32_t bin_reports[CP_DEBUG_DOMAIN_BINS];
    uint32_t vehicle_candidates, vehicle_name_addresses;
    uint32_t vehicle_ecosystem_addresses, vehicle_excluded_addresses;
    uint32_t vehicle_parsed_reports, vehicle_malformed_reports;
} cp_debug_domain_t;
typedef struct {
    bool wifi_connected, wifi_rssi_known, wifi_phy_known;
    char wifi_ssid[33]; /* Exactly 32 driver octets copied, plus our terminator. */
    int8_t wifi_rssi_dbm;
    char wifi_phy[20]; /* Actual negotiated PHY and interface bandwidth. */
    bool wifi_mbps_known; /* Pinned SDK has no reliable negotiated Mbps API. */
    uint32_t wifi_mbps;
    bool heap_known;
    uint32_t heap_internal_free, heap_internal_total, heap_internal_largest;
    uint32_t heap_sample_min_free, heap_sample_min_largest;
    uint32_t heap_boot_min_8bit; /* SDK boot-lifetime low water, not sample minimum. */
    bool queue_known;
    uint32_t queue_pending, queue_capacity, queue_quarantined;
    bool ble_collecting, ble_memory_paused, ble_raw_paused, ble_pressure_paused;
    uint32_t aggregation_drops, summary_drops, raw_drops, storage_drops;
    uint32_t windows_dropped;
    cp_debug_upload_t upload;
    cp_debug_domain_t domain;
    uint32_t reports_total, windows_total, summaries_total;
    bool clock_trusted, clock_estimated;
    uint32_t clock_epoch, clock_uncertainty_ms;
} cp_debug_snapshot_t;
#endif
