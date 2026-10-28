#pragma once
#include "cp_network.h"
#include "esp_err.h"
#include <stdint.h>
typedef struct {
    bool storage_ready, collecting;
    bool pressure_paused,raw_paused;
    bool memory_paused, memory_raw_paused, memory_restart_ready;
    bool radio_restart_required, stop_failed;
    uint32_t capacity_slots;
    uint32_t pending, free_slots, quarantined_slots;
    uint32_t aggregation_drops, summary_drops, raw_drops, storage_drops;
    uint32_t windows_dropped, upload_failures, ack_failures, rejected_batches;
    uint32_t reports_seen, windows_committed, summaries_committed;
    uint32_t callback_queue_drops, collector_rejections, report_queue_highwater;
    uint32_t sealed_pending, sealed_highwater, seal_overflows, final_window_pending;
    uint32_t seal_wait_max_ms, persist_max_ms;
    esp_err_t last_error;
} cp_pipeline_snapshot_t;
esp_err_t cp_pipeline_init(const char *node_id, const char *boot_id);
/* Runtime holds the radio-transition memory claim for apply. Stop seals/drains
 * the original policy before its capacity-sized address bank can be replaced.
 * Bank allocation failure leaves admission closed and is safe to retry. */
esp_err_t cp_pipeline_apply(const cp_network_policy_t *policy);
esp_err_t cp_pipeline_stop(void);
/* Supervisor only: monitor idle RAM, release a stopped radio, and retain
 * periodic status during pauses. Never calls from BLE callbacks. */
esp_err_t cp_pipeline_maintain(void);
/* Fresh desired-policy response only; historical reads/upload never call this. */
void cp_pipeline_renew_lease(uint64_t deadline_mono_ms);
void cp_pipeline_snapshot(cp_pipeline_snapshot_t *out);
/* Local numeric-only current/latest collector slice, with snapshot age. */
void cp_pipeline_domain_snapshot(cp_debug_domain_t *out);
