#include "cJSON.h"
#include "cp_codec.h"
#include <limits.h>
#include <stdio.h>
#include <string.h>

static const char *address_types[] = {"public", "random", "public_identity", "random_identity",
                                      "unknown"};
static const char *report_types[] = {"adv_ind", "adv_direct_ind", "adv_scan_ind", "adv_nonconn_ind",
                                     "scan_rsp"};

/* These schema keys have static lifetime. Interning only this closed set keeps
 * caller-owned/dynamic keys safe while avoiding one heap allocation per field
 * in the common six-address tree. Values still retain normal copy semantics. */
static const char *schema_key(const char *key) {
    static const char *const keys[] = {
        "seq", "time", "mono_ms", "clock_epoch", "utc_ms", "uncertainty_ms",
        "window_seq", "duration_ms", "bin_ms", "address", "address_type",
        "reports", "adv_reports", "scan_response_reports", "first_offset_ms",
        "last_offset_ms", "rssi", "samples", "min_dbm", "max_dbm", "mean_dbm",
        "bins", "vehicle_evidence", "schema_version", "parsed_reports",
        "malformed_reports", "name_brand_mask", "exclusion_mask", "ecosystem_mask",
        "protocol", "node_id", "boot_id", "placement_id", "capture_config_id",
        "dataset", "firmware_version", "batch_id", "stream", "items"
    };
    for (size_t i = 0; i < sizeof keys / sizeof keys[0]; ++i)
        if (!strcmp(key, keys[i]))
            return keys[i];
    return NULL;
}

static void dropped(cp_codec_t *c, const char *stream, unsigned count) {
    c->failed_batches++;
    c->failed_items += count;
    if (!strcmp(stream, "address_summaries"))
        c->summaries_dropped += count;
    else if (!strcmp(stream, "ble_windows"))
        c->windows_dropped += count;
    else if (!strcmp(stream, "ble_reports"))
        c->raw_dropped += count;
    else if (!strcmp(stream, "node_status"))
        c->status_dropped += count;
}
static cJSON *attach(cp_codec_t *c, cJSON *parent, const char *key, cJSON *child) {
    if (!child || !parent || c->build_failed) {
        c->build_failed = true;
        cJSON_Delete(child);
        return NULL;
    }
    const char *interned = key ? schema_key(key) : NULL;
    bool ok = !key ? cJSON_AddItemToArray(parent, child)
              : interned ? cJSON_AddItemToObjectCS(parent, interned, child)
                         : cJSON_AddItemToObject(parent, key, child);
    if (!ok) {
        c->build_failed = true;
        cJSON_Delete(child);
        return NULL;
    }
    return child;
}
cJSON *cp_codec_begin_items(cp_codec_t *c, unsigned count) {
    if (!c)
        return NULL;
    c->build_items = count;
    c->build_failed = false;
    cJSON *items = cJSON_CreateArray();
    if (!items)
        c->build_failed = true;
    return items;
}
cJSON *cp_codec_object(cp_codec_t *c, cJSON *p, const char *k) {
    return c && !c->build_failed ? attach(c, p, k, cJSON_CreateObject()) : NULL;
}
cJSON *cp_codec_array(cp_codec_t *c, cJSON *p, const char *k) {
    return c && !c->build_failed ? attach(c, p, k, cJSON_CreateArray()) : NULL;
}
void cp_codec_number(cp_codec_t *c, cJSON *p, const char *k, double v) {
    if (c && !c->build_failed)
        (void)attach(c, p, k, cJSON_CreateNumber(v));
}
void cp_codec_string(cp_codec_t *c, cJSON *p, const char *k, const char *v) {
    if (c && !c->build_failed)
        (void)attach(c, p, k, v ? cJSON_CreateString(v) : NULL);
}
void cp_codec_null(cp_codec_t *c, cJSON *p, const char *k) {
    if (c && !c->build_failed)
        (void)attach(c, p, k, cJSON_CreateNull());
}
void cp_codec_bool(cp_codec_t *c, cJSON *p, const char *k, bool v) {
    if (c && !c->build_failed)
        (void)attach(c, p, k, cJSON_CreateBool(v));
}
void cp_codec_time(cp_codec_t *c, cJSON *parent, uint64_t at) {
    cJSON *t = cp_codec_object(c, parent, "time");
    cp_codec_number(c, t, "mono_ms", (double)at);
    cp_codec_number(c, t, "clock_epoch", c->clock_epoch);
    bool known = c->clock_known;
    uint64_t utc = 0;
    uint64_t age = at >= c->clock_mono_ms ? at - c->clock_mono_ms : c->clock_mono_ms - at;
    if (known) {
        if (at >= c->clock_mono_ms) {
            if (age <= UINT64_MAX - c->clock_utc_ms)
                utc = c->clock_utc_ms + age;
            else
                known = false;
        } else if (c->clock_utc_ms >= age)
            utc = c->clock_utc_ms - age;
        else
            known = false;
        if (!utc || utc > 8640000000000000ULL)
            known = false;
    }
    if (known)
        cp_codec_number(c, t, "utc_ms", (double)utc);
    else
        cp_codec_null(c, t, "utc_ms");
    if (known && c->uncertainty_ms != UINT32_MAX) {
        uint64_t growth = age / 10000 + (age % 10000 != 0); /* ceil(age_ms * 100 ppm) */
        if (growth < (uint64_t)UINT32_MAX - c->uncertainty_ms)
            cp_codec_number(c, t, "uncertainty_ms", (double)(c->uncertainty_ms + growth));
        else
            cp_codec_null(c, t, "uncertainty_ms");
    } else
        cp_codec_null(c, t, "uncertainty_ms");
}
static void rssi_json(cp_codec_t *c, cJSON *parent, uint32_t n, int16_t min, int16_t max,
                      int64_t sum) {
    cJSON *r = cp_codec_object(c, parent, "rssi");
    cp_codec_number(c, r, "samples", n);
    if (n) {
        cp_codec_number(c, r, "min_dbm", min);
        cp_codec_number(c, r, "max_dbm", max);
        cp_codec_number(c, r, "mean_dbm", (double)sum / n);
    } else {
        cp_codec_null(c, r, "min_dbm");
        cp_codec_null(c, r, "max_dbm");
        cp_codec_null(c, r, "mean_dbm");
    }
}
static void mac_text(const uint8_t *a, char out[18]) {
    snprintf(out, 18, "%02x:%02x:%02x:%02x:%02x:%02x", a[0], a[1], a[2], a[3], a[4], a[5]);
}
static char *print_bounded(const cJSON *value, unsigned body_limit) {
    /* cJSON requests five spare bytes for PrintPreallocated. A failed print
     * only means this buffer is too small (or the tree is invalid); it never
     * reallocates. Release it before growing, so the tree coexists with at most
     * one bounded output buffer, never both a growth buffer and a final copy. */
    if (body_limit > INT_MAX - 5u)
        return NULL;
    const size_t limit = (size_t)body_limit + 5u;
    size_t capacity = limit < 256u ? limit : 256u;
    for (;;) {
        char *body = cJSON_malloc(capacity);
        if (!body)
            return NULL;
        if (cJSON_PrintPreallocated((cJSON *)value, body, (int)capacity, false))
            return body;
        cJSON_free(body);
        if (capacity == limit)
            return NULL;
        capacity = capacity > limit / 2u ? limit : capacity * 2u;
    }
}
bool cp_codec_emit_items(cp_codec_t *c, const char *stream, cJSON *items, bool control) {
    if (!c || !stream) {
        cJSON_Delete(items);
        return false;
    }
    unsigned count = c->build_items;
    if (!c->sink || !c->uuid || !cJSON_IsArray(items) ||
        (unsigned)cJSON_GetArraySize(items) != count)
        c->build_failed = true;
    if (!count && !c->build_failed) {
        cJSON_Delete(items);
        return true;
    }
    cJSON *b = NULL;
    char *body = NULL;
    bool ok = false;
    if (!c->build_failed) {
        b = cJSON_CreateObject();
        if (!b)
            c->build_failed = true;
    }
    if (!c->build_failed) {
        char id[37];
        c->uuid(id);
        cp_codec_string(c, b, "protocol", "campuspulse/2");
        cp_codec_string(c, b, "node_id", c->node_id);
        cp_codec_string(c, b, "boot_id", c->boot_id);
        cp_codec_string(c, b, "placement_id", c->placement_id);
        cp_codec_string(c, b, "capture_config_id", c->config_id);
        cp_codec_string(c, b, "dataset", c->dataset);
        cp_codec_string(c, b, "firmware_version", c->firmware_version);
        cp_codec_string(c, b, "batch_id", id);
        cp_codec_string(c, b, "stream", stream);
        if (!c->build_failed) {
            if (cJSON_AddItemToObjectCS(b, "items", items))
                items = NULL;
            else
                c->build_failed = true;
        }
        if (!c->build_failed) {
            body = print_bounded(b, c->max_body_bytes);
            if (!body)
                c->build_failed = true;
        }
    }
    /* The sink only needs immutable request bytes. Free the construction tree
     * before Flash work, preserving the body's lifetime until sink returns. */
    cJSON_Delete(items);
    cJSON_Delete(b);
    if (!c->build_failed && body) {
        size_t n = strlen(body);
        if (n <= c->max_body_bytes && count <= c->max_items)
            ok = c->sink(c->sink_context, body, n, stream, count, control);
    }
    cJSON_free(body);
    if (!ok)
        dropped(c, stream, count);
    return ok;
}
bool cp_codec_flush_raw_reports(cp_codec_t *c, const cp_report_t *reports,
                                unsigned report_count, uint32_t window_seq) {
    if (!c || !reports || !c->sink || !c->uuid || !c->max_items || report_count > CP_COLLECT_RAW)
        return false;
    if (!report_count)
        return true;
    bool all_ok = true;
    for (unsigned first = 0; first < report_count;) {
        unsigned count = report_count - first;
        if (count > c->max_items)
            count = c->max_items;
        cJSON *items = cp_codec_begin_items(c, count);
        for (unsigned i = first; i < first + count; i++) {
            const cp_report_t *r = &reports[i];
            cJSON *o = cp_codec_object(c, items, NULL);
            char mac[18], hex[63];
            mac_text(r->address, mac);
            if (r->payload_length > 31 || r->address_type > 4) {
                c->build_failed = true;
                continue;
            }
            for (unsigned k = 0; k < r->payload_length; k++)
                snprintf(hex + k * 2, 3, "%02x", r->payload[k]);
            hex[r->payload_length * 2] = 0;
            cp_codec_number(c, o, "seq", r->report_seq);
            cp_codec_time(c, o, r->mono_ms);
            cp_codec_number(c, o, "window_seq", window_seq);
            cJSON *id = cp_codec_object(c, o, "identity");
            cp_codec_string(c, id, "scheme", "mac");
            cp_codec_string(c, id, "address", mac);
            cp_codec_string(c, id, "address_type", address_types[r->address_type]);
            if (r->rssi >= -127 && r->rssi <= 126)
                cp_codec_number(c, o, "rssi_dbm", r->rssi);
            else
                cp_codec_null(c, o, "rssi_dbm");
            cp_codec_string(c, o, "report_type",
                            r->report_type < 5 ? report_types[r->report_type] : "unknown");
            cp_codec_number(c, o, "report_type_code", r->report_type);
            cp_codec_string(c, o, "format", "legacy_ad");
            cp_codec_number(c, o, "payload_length", r->payload_length);
            cp_codec_string(c, o, "payload_hex", hex);
        }
        bool ok = cp_codec_emit_items(c, "ble_reports", items, false);
        if (ok)
            c->raw_committed += count;
        else {
            all_ok = false;
        }
        first += count;
    }
    return all_ok;
}
bool cp_codec_flush_raw(cp_codec_t *c, cp_collect_t *w) {
    if (!c || !w || !c->sink || !c->uuid || !c->max_items || w->raw_count > CP_COLLECT_RAW)
        return false;
    unsigned before = c->raw_dropped;
    bool ok = cp_codec_flush_raw_reports(c, w->raw, w->raw_count, w->window_seq);
    w->raw_drops += c->raw_dropped - before;
    /* Successful bodies are frozen in the journal; failed attempts are explicit
     * drops. Neither may be serialized again with a new batch identity. */
    w->raw_count = 0;
    return ok;
}
cp_codec_window_view_t cp_codec_window_from_collect(const cp_collect_t *w) {
    if (!w)
        return (cp_codec_window_view_t){0};
    return (cp_codec_window_view_t){
        .start_ms = w->start_ms, .window_ms = w->window_ms, .bin_ms = w->bin_ms,
        .window_seq = w->window_seq, .address_capacity = w->address_capacity,
        .reports_seen = w->reports_seen, .reports_aggregated = w->reports_aggregated,
        .aggregation_drops = w->aggregation_drops, .adv = w->adv,
        .scan_responses = w->scan_responses, .rssi_samples = w->rssi_samples,
        .rssi_min = w->rssi_min, .rssi_max = w->rssi_max, .rssi_sum = w->rssi_sum,
        .address_overflow = w->address_overflow, .raw_enabled = w->raw_enabled,
        .summary_drops = w->summary_drops, .selected = w->selected,
        .intentional = w->intentional, .pressure = w->pressure, .raw_drops = w->raw_drops,
        .address_count = w->address_count, .raw_count = w->raw_count,
        .addresses = w->addresses, .raw = w->raw
    };
}
cp_codec_window_view_t cp_codec_window_from_compact(const cp_collect_compact_t *w) {
    if (!w)
        return (cp_codec_window_view_t){0};
    return (cp_codec_window_view_t){
        .start_ms = w->start_ms, .window_ms = w->window_ms, .bin_ms = w->bin_ms,
        .window_seq = w->window_seq, .address_capacity = w->address_capacity,
        .reports_seen = w->reports_seen, .reports_aggregated = w->reports_aggregated,
        .aggregation_drops = w->aggregation_drops, .adv = w->adv,
        .scan_responses = w->scan_responses, .rssi_samples = w->rssi_samples,
        .rssi_min = w->rssi_min, .rssi_max = w->rssi_max, .rssi_sum = w->rssi_sum,
        .address_overflow = w->address_overflow, .raw_enabled = w->raw_enabled,
        .summary_drops = w->summary_drops, .selected = w->selected,
        .intentional = w->intentional, .pressure = w->pressure, .raw_drops = w->raw_drops,
        .address_count = w->address_count, .raw_count = w->raw_count,
        .cores = w->addresses, .bins = w->bins, .bin_count = w->bin_count, .raw = w->raw
    };
}
static const cp_address_core_t *address_core(const cp_codec_window_view_t *w, unsigned i) {
    return w->addresses ? &w->addresses[i].core : &w->cores[i];
}
static const uint32_t *address_bins(const cp_codec_window_view_t *w, unsigned i) {
    return w->addresses ? w->addresses[i].bins : w->bins + (size_t)i * w->bin_count;
}
static bool window_valid(const cp_codec_t *c, const cp_codec_window_view_t *w,
                         uint32_t duration) {
    if (!c || !w || !c->summary_sequence || !c->uuid || !c->sink || !c->max_items ||
        c->max_body_bytes < 1024 || duration > w->window_ms || !w->bin_ms ||
        ((uint64_t)w->window_ms + w->bin_ms - 1) / w->bin_ms > CP_COLLECT_BINS ||
        w->address_count > CP_COLLECT_ADDRESSES || w->raw_count > CP_COLLECT_RAW ||
        (w->addresses && (w->cores || w->bins || w->bin_count)) ||
        (!w->addresses && w->address_count &&
         (!w->cores || !w->bins || w->bin_count > CP_COLLECT_BINS ||
          w->bin_count < ((uint64_t)w->window_ms + w->bin_ms - 1) / w->bin_ms)) ||
        (w->raw_count && !w->raw))
        return false;
    return true;
}
bool cp_codec_window(cp_codec_t *c, cp_collect_t *w, uint32_t duration) {
    if (!w)
        return false;
    const cp_codec_window_view_t view = cp_codec_window_from_collect(w);
    if (!window_valid(c, &view, duration))
        return false;
    unsigned before = c->raw_dropped;
    bool ok = cp_codec_encode_window_view(c, &view, duration);
    w->raw_drops += c->raw_dropped - before;
    w->raw_count = 0;
    return ok;
}
bool cp_codec_encode_window_view(cp_codec_t *c, const cp_codec_window_view_t *w,
                                 uint32_t duration) {
    if (!window_valid(c, w, duration))
        return false;
    uint64_t end = w->start_ms + duration;
    unsigned before = c->raw_dropped;
    if (w->raw_count)
        (void)cp_codec_flush_raw_reports(c, w->raw, w->raw_count, w->window_seq);
    uint32_t raw_drops = w->raw_drops + (c->raw_dropped - before);
    if (duration < 1000) {
        /* The wire protocol requires at least one second. Preserve selected
         * raw reports, then account for the omitted window/summary records. */
        dropped(c, "ble_windows", 1);
        if (w->address_count)
            dropped(c, "address_summaries", w->address_count);
        c->unpersisted_window_reports += w->reports_seen;
        return false;
    }
    /* A partial stop must contain every admitted report. Never silently clamp
     * offsets, discard trailing bins or expand scan coverage to repair a bad
     * boundary. Preserve selected raw and account for the unrepresentable
     * aggregate instead of freezing a batch the server can never accept. */
    for (unsigned i = 0; i < w->address_count; i++) {
        const cp_address_core_t *a = address_core(w, i);
        const uint32_t *bins = address_bins(w, i);
        uint64_t reports = 0;
        bool valid = a->first_ms <= a->last_ms && a->last_ms < duration;
        const cp_vehicle_evidence_t *e = &a->vehicle_evidence;
        if ((uint64_t)e->parsed_reports + e->malformed_reports != a->reports ||
            (e->name_brand_mask & ~CP_VEHICLE_NAME_MASK_ALL) ||
            (e->exclusion_mask & ~CP_VEHICLE_EXCLUSION_MASK_ALL) ||
            (e->ecosystem_mask & ~CP_VEHICLE_ECOSYSTEM_MASK_ALL) ||
            (!e->parsed_reports && (e->name_brand_mask || e->exclusion_mask || e->ecosystem_mask)))
            valid = false;
        unsigned bin_count = w->addresses ? CP_COLLECT_BINS : w->bin_count;
        for (unsigned k = 0; k < bin_count; k++) {
            reports += bins[k];
            if (bins[k] && (k < a->first_ms / w->bin_ms || k > a->last_ms / w->bin_ms))
                valid = false;
        }
        if (!valid || reports != a->reports || !bins[a->first_ms / w->bin_ms] ||
            !bins[a->last_ms / w->bin_ms]) {
            dropped(c, "ble_windows", 1);
            dropped(c, "address_summaries", w->address_count);
            c->unpersisted_window_reports += w->reports_seen;
            return false;
        }
    }
    /* Reserve envelope space and budget a full 16-bin record plus compact
     * evidence. Cap at six addresses even under a larger body policy: cJSON
     * retains the tree and print buffer simultaneously on the no-PSRAM C3.
     * The final serialized body limit is checked independently below. */
    unsigned target = (c->max_body_bytes - 1024) / 1024;
    if (!target)
        target = 1;
    if (target > 6)
        target = 6;
    if (target > c->max_items)
        target = c->max_items;
    for (unsigned first = 0; first < w->address_count; first += target) {
        unsigned count = w->address_count - first;
        if (count > target)
            count = target;
        if (count > UINT32_MAX - *c->summary_sequence) {
            dropped(c, "address_summaries", w->address_count - first);
            break;
        }
        cJSON *items = cp_codec_begin_items(c, count);
        for (unsigned i = first; i < first + count; i++) {
            const cp_address_core_t *a = address_core(w, i);
            const uint32_t *address_counts = address_bins(w, i);
            cJSON *o = cp_codec_object(c, items, NULL);
            char mac[18];
            mac_text(a->address, mac);
            uint32_t seq = ++*c->summary_sequence;
            if (a->address_type > 4) {
                c->build_failed = true;
                continue;
            }
            cp_codec_number(c, o, "seq", seq);
            cp_codec_time(c, o, end);
            cp_codec_number(c, o, "window_seq", w->window_seq);
            cp_codec_number(c, o, "duration_ms", duration);
            cp_codec_number(c, o, "bin_ms", w->bin_ms);
            cp_codec_string(c, o, "address", mac);
            cp_codec_string(c, o, "address_type", address_types[a->address_type]);
            cp_codec_number(c, o, "reports", a->reports);
            cp_codec_number(c, o, "adv_reports", a->adv);
            cp_codec_number(c, o, "scan_response_reports", a->scan_responses);
            cp_codec_number(c, o, "first_offset_ms", a->first_ms);
            cp_codec_number(c, o, "last_offset_ms", a->last_ms);
            rssi_json(c, o, a->samples, a->rssi_min, a->rssi_max, a->rssi_sum);
            cJSON *bins = cp_codec_array(c, o, "bins");
            for (unsigned k = 0; k < ((uint64_t)duration + w->bin_ms - 1) / w->bin_ms; k++)
                cp_codec_number(c, bins, NULL, address_counts[k]);
            const cp_vehicle_evidence_t *e = &a->vehicle_evidence;
            cJSON *vehicle = cp_codec_object(c, o, "vehicle_evidence");
            cp_codec_string(c, vehicle, "schema_version", CP_VEHICLE_SCHEMA_VERSION);
            cp_codec_number(c, vehicle, "parsed_reports", e->parsed_reports);
            cp_codec_number(c, vehicle, "malformed_reports", e->malformed_reports);
            cp_codec_number(c, vehicle, "name_brand_mask", e->name_brand_mask);
            cp_codec_number(c, vehicle, "exclusion_mask", e->exclusion_mask);
            cp_codec_number(c, vehicle, "ecosystem_mask", e->ecosystem_mask);
        }
        if (cp_codec_emit_items(c, "address_summaries", items, false))
            c->summaries_committed += count;
    }
    cJSON *items = cp_codec_begin_items(c, 1), *o = cp_codec_object(c, items, NULL);
    cp_codec_number(c, o, "seq", w->window_seq);
    cp_codec_time(c, o, end);
    cp_codec_number(c, o, "duration_ms", duration);
    cp_codec_number(c, o, "scan_enabled_ms", duration);
    cp_codec_number(c, o, "reports_seen", w->reports_seen);
    cp_codec_number(c, o, "reports_aggregated", w->reports_aggregated);
    cp_codec_number(c, o, "aggregation_drops", w->aggregation_drops);
    cp_codec_number(c, o, "adv_reports", w->adv);
    cp_codec_number(c, o, "scan_response_reports", w->scan_responses);
    cp_codec_number(c, o, "visible_identifiers", w->address_count);
    cp_codec_number(c, o, "unique_table_capacity", w->address_capacity);
    cp_codec_bool(c, o, "unique_table_overflow", w->address_overflow);
    rssi_json(c, o, w->rssi_samples, w->rssi_min, w->rssi_max, w->rssi_sum);
    cJSON *r = cp_codec_object(c, o, "raw_capture");
    cp_codec_string(c, r, "mode", w->raw_enabled ? "sampled" : "off");
    cp_codec_number(c, r, "selected_reports", w->selected);
    cp_codec_number(c, r, "intentional_skips", w->intentional);
    cp_codec_number(c, r, "pressure_skips", w->pressure);
    cp_codec_number(c, r, "drops", raw_drops);
    cJSON *f = cp_codec_array(c, o, "quality_flags");
    if (duration < w->window_ms)
        cp_codec_string(c, f, NULL, "partial_window");
    if (w->address_overflow)
        cp_codec_string(c, f, NULL, "unique_table_overflow");
    if (w->aggregation_drops)
        cp_codec_string(c, f, NULL, "aggregation_drops");
    if (raw_drops)
        cp_codec_string(c, f, NULL, "raw_drops");
    if (w->pressure)
        cp_codec_string(c, f, NULL, "raw_pressure_pause");
    bool ok = cp_codec_emit_items(c, "ble_windows", items, true);
    if (ok)
        c->windows_committed++;
    else
        c->unpersisted_window_reports += w->reports_seen;
    return ok;
}
