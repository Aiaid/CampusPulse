#include "cJSON.h"
#include "cp_codec.h"
#include <stdint.h>

bool cp_codec_status(cp_codec_t *c, const cp_codec_status_t *s, uint32_t seq) {
    if (!c || !s || !seq || !s->slots || s->free_slots > s->slots)
        return false;
    uint64_t pending = s->unclassified_pending_slots;
    for (unsigned i = 0; i < 4; i++)
        pending += s->queue_pending[i];
    if (pending > s->slots - s->free_slots || s->raw_paused_ms > s->mono_ms)
        return false;
    cJSON *items = cp_codec_begin_items(c, 1), *o = cp_codec_object(c, items, NULL);
    cp_codec_number(c, o, "seq", seq);
    cp_codec_time(c, o, s->mono_ms);
    cp_codec_number(c, o, "uptime_ms", (double)s->mono_ms);
    cp_codec_string(c, o, "scan_state", s->collecting ? "running" : "paused");
    cp_codec_string(c, o, "wifi_state", s->connected ? "connected" : "disconnected");
    cp_codec_number(c, o, "free_heap_bytes", s->free_heap);
    const char *names[] = {"ble_windows", "address_summaries", "ble_reports", "node_status"};
    cJSON *q = cp_codec_object(c, o, "queue_pending"),
          *caps = cp_codec_object(c, o, "queue_capacity");
    for (unsigned i = 0; i < 4; i++) {
        cp_codec_number(c, q, names[i], s->queue_pending[i]);
        cp_codec_number(c, caps, names[i], s->slots);
    }
    cp_codec_number(c, o, "storage_free_bytes", (double)s->free_slots * 12288u);
    cp_codec_string(c, o, "raw_capture_state", s->raw_enabled ? "sampled" : "off");
    cJSON *l = cp_codec_object(c, o, "loss_totals");
#define LOSS(field) cp_codec_number(c, l, #field, s->field)
    LOSS(aggregation_drops);
    LOSS(raw_queue_drops);
    LOSS(storage_drops);
    LOSS(windows_dropped);
    LOSS(upload_failures);
    LOSS(ack_failures);
    LOSS(raw_pressure_skips);
    LOSS(address_summaries_dropped);
    LOSS(address_table_overflow_reports);
    LOSS(accounting_overrun_reports);
    LOSS(unpersisted_window_reports);
    LOSS(status_samples_coalesced);
#undef LOSS
    cJSON *b = cp_codec_object(c, o, "buffer_health");
    cp_codec_number(c, b, "log_budget_bytes", (double)s->slots * 12288u);
    cp_codec_number(c, b, "used_bytes", (double)(s->slots - s->free_slots) * 12288u);
    cp_codec_number(c, b, "unacked_bytes", (double)pending * 12288u);
    cp_codec_number(c, b, "reclaimable_bytes", 0);
    cp_codec_null(c, b, "incoming_local_Bps");
    cp_codec_null(c, b, "newly_acknowledged_local_Bps");
    cp_codec_null(c, b, "time_to_full_s");
    cp_codec_string(c, b, "growth_state", "unknown");
    unsigned percent = (unsigned)((uint64_t)(s->slots - s->free_slots) * 100 / s->slots);
    cp_codec_string(c, b, "pressure_level",
                    percent >= s->critical_pct    ? "critical"
                    : percent >= s->raw_pause_pct ? "high"
                    : percent >= s->warn_pct      ? "warning"
                                                  : "normal");
    if (percent >= s->critical_pct)
        cp_codec_string(c, b, "pause_reason", "storage_pressure");
    else if (s->raw_enabled && percent >= s->raw_pause_pct)
        cp_codec_string(c, b, "pause_reason", "raw_pressure");
    else
        cp_codec_null(c, b, "pause_reason");
    cp_codec_number(c, b, "raw_paused_ms", (double)s->raw_paused_ms);
    cp_codec_null(c, b, "pre_pause_incoming_local_Bps");
    return cp_codec_emit_items(c, "node_status", items, true);
}
