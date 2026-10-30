#include "raw_activity.h"
#include <limits.h>
#include <string.h>

static raw_activity_bin_t *bucket(raw_activity_t *a, uint64_t us) {
    uint64_t epoch = us / RAW_ACTIVITY_BIN_US;
    if (!a->started) { a->started = true; a->first_us = us; }
    if (epoch > a->latest_epoch) a->latest_epoch = epoch;
    if (a->latest_epoch - epoch >= RAW_ACTIVITY_BINS) return NULL;
    raw_activity_bin_t *b = &a->bins[epoch % RAW_ACTIVITY_BINS];
    if (b->valid && b->epoch > epoch) return NULL;
    if (!b->valid || b->epoch != epoch) {
        memset(b, 0, sizeof *b);
        b->valid = true; b->epoch = epoch;
    }
    return b;
}

void raw_activity_report(raw_activity_t *a, uint64_t us, int rssi) {
    raw_activity_bin_t *b = bucket(a, us);
    if (!b) return;
    if (b->reports != UINT32_MAX) b->reports++;
    if (rssi == 127 || rssi < -128 || rssi > 20 || b->rssi_samples == UINT32_MAX) return;
    if (!b->rssi_samples || rssi < b->rssi_min) b->rssi_min = rssi;
    if (!b->rssi_samples || rssi > b->rssi_max) b->rssi_max = rssi;
    b->rssi_sum += rssi; b->rssi_samples++;
}

void raw_activity_written(raw_activity_t *a, uint64_t us) {
    raw_activity_bin_t *b = bucket(a, us);
    if (b && b->written != UINT32_MAX) b->written++;
}

void raw_activity_read(const raw_activity_t *a, uint64_t now, raw_activity_view_t *v) {
    memset(v, 0, sizeof *v);
    if (!a->started || now < a->first_us) return;
    uint64_t current = now / RAW_ACTIVITY_BIN_US, samples = 0;
    int64_t sum = 0;
    for (unsigned i = 0; i < RAW_ACTIVITY_BINS; i++) {
        unsigned ago = RAW_ACTIVITY_BINS - 1 - i;
        if (current < ago) continue;
        uint64_t epoch = current - ago;
        const raw_activity_bin_t *b = &a->bins[epoch % RAW_ACTIVITY_BINS];
        if (!b->valid || b->epoch != epoch) continue;
        v->reports[i] = b->reports;
        v->received += b->reports; v->written += b->written;
        if (b->rssi_samples) {
            if (!samples || b->rssi_min < v->rssi_min) v->rssi_min = b->rssi_min;
            if (!samples || b->rssi_max > v->rssi_max) v->rssi_max = b->rssi_max;
            v->rssi_known[i] = true;
            v->rssi[i] = (int16_t)(b->rssi_sum / b->rssi_samples);
            samples += b->rssi_samples; sum += b->rssi_sum;
        }
    }
    uint64_t oldest = current >= 9 ? (current - 9) * RAW_ACTIVITY_BIN_US : 0;
    if (a->first_us > oldest) oldest = a->first_us;
    uint64_t span = now - oldest;
    if (span < 1000000) span = 1000000;
    uint64_t rate = v->received * 1000000 / span;
    v->rate = rate > UINT32_MAX ? UINT32_MAX : (uint32_t)rate;
    v->signal_known = samples != 0;
    v->rssi_samples = samples > UINT32_MAX ? UINT32_MAX : (uint32_t)samples;
    if (samples) v->rssi_mean = (int16_t)(sum / (int64_t)samples);
}
