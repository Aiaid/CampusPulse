#pragma once
#include <stdbool.h>
#include <stdint.h>

/* Internal, byte-addressable RAM only. These conservative C3 guardrails are
 * separate from the server's desired sampling policy and storage thresholds. */
#define CP_MEMORY_RAW_FREE (32u * 1024u)
#define CP_MEMORY_RAW_LARGEST (18u * 1024u)
#define CP_MEMORY_STOP_FREE (24u * 1024u)
#define CP_MEMORY_STOP_LARGEST (16u * 1024u)
#define CP_MEMORY_RAW_RESUME_FREE (36u * 1024u)
#define CP_MEMORY_RAW_RESUME_LARGEST (20u * 1024u)
#define CP_MEMORY_START_FREE (56u * 1024u)
#define CP_MEMORY_START_LARGEST (24u * 1024u)
#define CP_MEMORY_RAW_DELAY_MS 2000u
#define CP_MEMORY_STOP_DELAY_MS 5000u
#define CP_MEMORY_HEALTHY_MS 10000u
#define CP_MEMORY_COOLDOWN_MS 30000u

typedef struct {
    bool raw_paused, scan_paused, restart_ready;
    bool raw_low, scan_low, healthy;
    bool init_fault;
    bool sample_seen, http_busy;
    uint32_t healthy_idle_ms;
    uint64_t raw_since, scan_since, paused_at, last_sample;
} cp_memory_guard_t;

/* Supervisor-owned state, no allocation or IO. In-flight HTTP samples reset
 * pressure intervals and pause healthy-idle recovery accounting. Unhealthy idle
 * samples reset recovery; HTTP never clears an existing pause. */
void cp_memory_guard_observe(cp_memory_guard_t *, uint64_t now_ms, uint32_t free_bytes,
                             uint32_t largest_bytes, bool http_busy, bool collecting);
void cp_memory_guard_pause(cp_memory_guard_t *, uint64_t now_ms);
bool cp_memory_guard_start_allowed(cp_memory_guard_t *, uint64_t now_ms,
                                   uint32_t free_bytes, uint32_t largest_bytes, bool http_busy);
/* A partial SDK init failure cannot be safely retried/deinitialized this boot. */
void cp_memory_guard_init_failed(cp_memory_guard_t *);
void cp_memory_guard_started(cp_memory_guard_t *);
