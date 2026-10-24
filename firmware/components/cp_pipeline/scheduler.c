#include "cp_upload_scheduler.h"
#include <string.h>
#define CP_UPLOAD_LANE_COUNT (CP_UPLOAD_STREAM_COUNT + 1u)

void cp_upload_scheduler_init(cp_upload_scheduler_t *scheduler) {
    if (!scheduler)
        return;
    memset(scheduler, 0, sizeof(*scheduler));
    memset(scheduler->stream, UINT8_MAX, sizeof(scheduler->stream));
}

bool cp_upload_scheduler_bind(cp_upload_scheduler_t *scheduler, uint16_t slot, unsigned stream) {
    if (!scheduler || slot >= CP_JOURNAL_MAX_SLOTS)
        return false;
    scheduler->retry_at[slot] = 0;
    scheduler->retry_exp[slot] = 0;
    scheduler->blocked[slot] = stream >= CP_UPLOAD_STREAM_COUNT;
    scheduler->stream[slot] = stream < CP_UPLOAD_STREAM_COUNT ? (uint8_t)stream : UINT8_MAX;
    return !scheduler->blocked[slot];
}

void cp_upload_scheduler_block(cp_upload_scheduler_t *scheduler, uint16_t slot) {
    if (!scheduler || slot >= CP_JOURNAL_MAX_SLOTS)
        return;
    scheduler->blocked[slot] = true;
}

void cp_upload_scheduler_confirmed(cp_upload_scheduler_t *scheduler, uint16_t slot) {
    if (!scheduler || slot >= CP_JOURNAL_MAX_SLOTS)
        return;
    scheduler->retry_at[slot] = 0;
    scheduler->retry_exp[slot] = 0;
}

uint16_t cp_upload_scheduler_select(cp_upload_scheduler_t *scheduler,
                                    const cp_journal_slot_t *slots, unsigned count,
                                    uint64_t now_ms) {
    if (!scheduler || !slots || count > CP_JOURNAL_MAX_SLOTS)
        return CP_UPLOAD_NO_SLOT;
    uint16_t candidates[CP_UPLOAD_LANE_COUNT];
    for (unsigned stream = 0; stream < CP_UPLOAD_LANE_COUNT; ++stream)
        candidates[stream] = CP_UPLOAD_NO_SLOT;
    for (unsigned slot = 0; slot < count; ++slot) {
        unsigned stream = scheduler->stream[slot];
        if (slots[slot].state != CP_SLOT_PENDING || scheduler->blocked[slot])
            continue;
        if (stream == CP_UPLOAD_STREAM_UNKNOWN)
            stream = CP_UPLOAD_STREAM_COUNT;
        else if (stream >= CP_UPLOAD_STREAM_COUNT)
            continue;
        uint16_t prior = candidates[stream];
        if (prior == CP_UPLOAD_NO_SLOT || slots[slot].ordinal < slots[prior].ordinal)
            candidates[stream] = (uint16_t)slot;
    }
    for (unsigned offset = 0; offset < CP_UPLOAD_LANE_COUNT; ++offset) {
        unsigned stream = (scheduler->next_stream + offset) % CP_UPLOAD_LANE_COUNT;
        uint16_t slot = candidates[stream];
        if (slot != CP_UPLOAD_NO_SLOT && scheduler->retry_at[slot] <= now_ms) {
            scheduler->next_stream = (uint8_t)((stream + 1) % CP_UPLOAD_LANE_COUNT);
            return slot;
        }
    }
    return CP_UPLOAD_NO_SLOT;
}

uint64_t cp_upload_scheduler_retry(cp_upload_scheduler_t *scheduler, uint16_t slot, uint64_t now_ms,
                                   uint32_t random_value) {
    if (!scheduler || slot >= CP_JOURNAL_MAX_SLOTS || scheduler->blocked[slot] ||
        (scheduler->stream[slot] >= CP_UPLOAD_STREAM_COUNT &&
         scheduler->stream[slot] != CP_UPLOAD_STREAM_UNKNOWN))
        return 0;
    unsigned exponent = scheduler->retry_exp[slot];
    uint64_t delay = (exponent >= 6 ? CP_UPLOAD_RETRY_MAX_MS : (1u << exponent) * 1000u) +
                     random_value % CP_UPLOAD_RETRY_JITTER_MS;
    scheduler->retry_exp[slot] = exponent < 6 ? (uint8_t)(exponent + 1) : 6;
    scheduler->retry_at[slot] = now_ms > UINT64_MAX - delay ? UINT64_MAX : now_ms + delay;
    return scheduler->retry_at[slot];
}
