#ifndef CP_UPLOAD_SCHEDULER_H
#define CP_UPLOAD_SCHEDULER_H

#ifdef ESP_PLATFORM
#include "sdkconfig.h"
#endif
#include "cp_journal.h"
#include <stdbool.h>
#include <stdint.h>

#define CP_UPLOAD_STREAM_COUNT 4u
#define CP_UPLOAD_NO_SLOT UINT16_MAX
#define CP_UPLOAD_STREAM_UNKNOWN UINT8_MAX
#define CP_UPLOAD_RETRY_MAX_MS 60000u
#define CP_UPLOAD_RETRY_JITTER_MS 250u

/* Pure scheduling state. Caller serializes access with the journal mutex.
 * Slots are bound after recovery/append, and rebound whenever reused.
 * Unbound pending slots use a fifth, fairly scheduled metadata-discovery lane.
 * This state never grants permission to reclaim or modify a frozen request body. */
typedef struct {
    uint64_t retry_at[CP_JOURNAL_MAX_SLOTS];
    uint8_t retry_exp[CP_JOURNAL_MAX_SLOTS];
    uint8_t stream[CP_JOURNAL_MAX_SLOTS];
    bool blocked[CP_JOURNAL_MAX_SLOTS];
#if CONFIG_CP_UPLOAD_PREFER_CURRENT_BOOT
    bool current[CP_JOURNAL_MAX_SLOTS];
#endif
    uint8_t next_stream;
} cp_upload_scheduler_t;

void cp_upload_scheduler_init(cp_upload_scheduler_t *scheduler);
bool cp_upload_scheduler_bind(cp_upload_scheduler_t *scheduler, uint16_t slot, unsigned stream);
#if CONFIG_CP_UPLOAD_PREFER_CURRENT_BOOT
/* Classification comes from frozen metadata, never from physical slot order. */
void cp_upload_scheduler_set_current(cp_upload_scheduler_t *scheduler, uint16_t slot, bool current);
#else
static inline void cp_upload_scheduler_set_current(cp_upload_scheduler_t *scheduler,
                                                   uint16_t slot, bool current) {
    (void)scheduler; (void)slot; (void)current;
}
#endif
void cp_upload_scheduler_block(cp_upload_scheduler_t *scheduler, uint16_t slot);
void cp_upload_scheduler_confirmed(cp_upload_scheduler_t *scheduler, uint16_t slot);
/* Choose the oldest unblocked pending batch in each stream BEFORE considering
 * its retry deadline. A delayed head blocks only its own stream; later batches
 * cannot overtake it. Permanently blocked evidence remains stored and is skipped.
 * Round robin advances only when a slot is selected. Unknown metadata is a fifth
 * lane: after discovery binds its stream, rerun selection before upload so it
 * cannot overtake an older known batch in that stream.
 * With current-boot preference enabled, ordering/backoff apply independently
 * within the current and historical lanes of each stream. Ready current heads
 * take priority; history is eligible only when all current heads are empty or
 * delayed. Blocked bodies are preserved in both lanes. */
uint16_t cp_upload_scheduler_select(cp_upload_scheduler_t *scheduler,
                                    const cp_journal_slot_t *slots, unsigned count,
                                    uint64_t now_ms);
/* 1,2,4,8,16,32,60 seconds, capped there, plus random_value % 250 ms.
 * Deadline addition saturates instead of wrapping into immediate eligibility. */
uint64_t cp_upload_scheduler_retry(cp_upload_scheduler_t *scheduler, uint16_t slot, uint64_t now_ms,
                                   uint32_t random_value);

#endif
