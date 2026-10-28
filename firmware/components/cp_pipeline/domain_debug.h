#pragma once
#include "cp_collect.h"
#include "cp_debug.h"

/* Collector-worker only. Never called from the BLE callback. Published state
 * contains counts/evidence only; it retains no addresses, names or raw AD. */
void cp_domain_debug_observe(const cp_collect_t *, const cp_report_t *, bool counted);
void cp_domain_debug_refresh(const cp_collect_t *, uint64_t now_ms,
                             bool sealed, uint32_t duration_ms);

void cp_domain_debug_observe_compact(const cp_collect_compact_t *, const cp_report_t *, bool counted);
void cp_domain_debug_refresh_compact(const cp_collect_compact_t *, uint64_t now_ms,
                                     bool sealed, uint32_t duration_ms);
