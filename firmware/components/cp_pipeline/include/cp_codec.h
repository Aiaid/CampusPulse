#pragma once
#include "cp_collect.h"
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
typedef bool (*cp_codec_sink_fn)(void *context, const char *body, size_t length, const char *stream,
                                 unsigned count, bool control);
typedef void (*cp_codec_uuid_fn)(char output[37]);
typedef struct {
    const char *node_id, *boot_id, *placement_id, *config_id, *dataset, *firmware_version;
    unsigned max_items, max_body_bytes;
    bool clock_known;
    uint64_t clock_mono_ms, clock_utc_ms;
    uint32_t clock_epoch, uncertainty_ms;
    uint32_t *summary_sequence;
    cp_codec_uuid_fn uuid;
    cp_codec_sink_fn sink;
    void *sink_context;
    unsigned windows_committed, summaries_committed, raw_committed, failed_batches;
    unsigned failed_items, summaries_dropped, windows_dropped, raw_dropped, status_dropped;
    uint32_t unpersisted_window_reports;
    /* Build state belongs to this context, never to a process-wide allocator.
     * A failed item/add latches until the attempted batch is accounted for. */
    bool build_failed;
    unsigned build_items;
} cp_codec_t;
/* Serializes actual collection records into immutable versioned request bytes.
 * sink must durably store bytes before returning success. No HTTP in this layer.
 * Window result describes the overall-window batch; stream losses have separate
 * counters so a summary failure never turns a stored window into a false drop. */
bool cp_codec_window(cp_codec_t *, cp_collect_t *, uint32_t duration_ms);
bool cp_codec_flush_raw(cp_codec_t *, cp_collect_t *);
struct cJSON;
/* Checked builders: new children immediately belong to their parent. A NULL
 * key appends to an array. Failure makes later additions no-ops for this batch.
 * Begin returns the owning root array; emit always consumes that array. */
struct cJSON *cp_codec_begin_items(cp_codec_t *, unsigned expected_items);
struct cJSON *cp_codec_object(cp_codec_t *, struct cJSON *, const char *key);
struct cJSON *cp_codec_array(cp_codec_t *, struct cJSON *, const char *key);
void cp_codec_number(cp_codec_t *, struct cJSON *, const char *key, double value);
void cp_codec_string(cp_codec_t *, struct cJSON *, const char *key, const char *value);
void cp_codec_null(cp_codec_t *, struct cJSON *, const char *key);
void cp_codec_bool(cp_codec_t *, struct cJSON *, const char *key, bool value);
/* UTC is a server-relative estimate. Age adds 100 ppm oscillator uncertainty
 * from the anchor; this does not bound the server's absolute clock error. */
void cp_codec_time(cp_codec_t *, struct cJSON *parent, uint64_t mono_ms);
/* Takes ownership of items on success or failure; never sinks a failed build. */
bool cp_codec_emit_items(cp_codec_t *, const char *stream, struct cJSON *items, bool control);
typedef struct {
    uint64_t mono_ms, raw_paused_ms;
    bool collecting, connected, raw_enabled;
    bool raw_paused, memory_paused, memory_raw_paused;
    uint32_t free_heap, queue_pending[4], slots, free_slots;
    /* Recovered slots whose metadata could not yet be parsed (e.g. transient
     * OOM) still occupy durable unacknowledged storage. */
    uint32_t unclassified_pending_slots;
    uint32_t aggregation_drops, raw_queue_drops, storage_drops, windows_dropped;
    uint32_t upload_failures, ack_failures, raw_pressure_skips;
    uint32_t address_summaries_dropped, address_table_overflow_reports;
    uint32_t accounting_overrun_reports, unpersisted_window_reports;
    uint32_t status_samples_coalesced;
    uint8_t warn_pct, raw_pause_pct, critical_pct;
} cp_codec_status_t;
bool cp_codec_status(cp_codec_t *, const cp_codec_status_t *, uint32_t seq);
