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
    esp_err_t last_error;
} cp_pipeline_snapshot_t;
esp_err_t cp_pipeline_init(const char *node_id, const char *boot_id);
/* Stop seals/drains the original policy before it can be replaced. */
esp_err_t cp_pipeline_apply(const cp_network_policy_t *policy);
esp_err_t cp_pipeline_stop(void);
/* Supervisor only: monitor idle RAM, release a stopped radio, and retain
 * periodic status during pauses. Never calls from BLE callbacks. */
esp_err_t cp_pipeline_maintain(void);
/* Fresh desired-policy response only; historical reads/upload never call this. */
void cp_pipeline_renew_lease(uint64_t deadline_mono_ms);
void cp_pipeline_snapshot(cp_pipeline_snapshot_t *out);
