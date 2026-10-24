#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define CP_JOURNAL_SLOT_BYTES 12288u
#define CP_JOURNAL_MAX_BODY 8192u
#define CP_JOURNAL_MAX_SLOTS 384u
#define CP_JOURNAL_CONTROL_RESERVE 8u
typedef bool (*cp_flash_read_fn)(void *, size_t, void *, size_t);
typedef bool (*cp_flash_write_fn)(void *, size_t, const void *, size_t);
typedef bool (*cp_flash_erase_fn)(void *, size_t, size_t);
typedef struct {
    void *context;
    size_t size;
    cp_flash_read_fn read;
    cp_flash_write_fn write;
    cp_flash_erase_fn erase;
} cp_flash_t;
typedef enum { CP_SLOT_FREE, CP_SLOT_PENDING, CP_SLOT_ACKED, CP_SLOT_QUARANTINED } cp_slot_state_t;
typedef struct {
    uint64_t ordinal;
    uint32_t length;
    cp_slot_state_t state;
} cp_journal_slot_t;
typedef struct {
    cp_flash_t flash;
    cp_journal_slot_t slots[CP_JOURNAL_MAX_SLOTS];
    uint16_t count;
    uint64_t next_ordinal;
    uint32_t io_failures;
    uint32_t corrupt_slots;
    bool ready;
} cp_journal_t;
typedef enum {
    CP_JOURNAL_OK,
    CP_JOURNAL_FULL,
    CP_JOURNAL_INVALID,
    CP_JOURNAL_IO,
    CP_JOURNAL_CORRUPT,
    CP_JOURNAL_NOT_FOUND
} cp_journal_result_t;
/* Open never formats unknown data. Partial/foreign slots are quarantined. */
cp_journal_result_t cp_journal_open(cp_journal_t *, cp_flash_t);
cp_journal_result_t cp_journal_append(cp_journal_t *, const void *, size_t, bool control_record,
                                      uint16_t *slot);
cp_journal_result_t cp_journal_oldest(const cp_journal_t *, uint16_t *slot);
cp_journal_result_t cp_journal_read(cp_journal_t *, uint16_t, void *, size_t, size_t *);
/* Call ONLY after the protocol client has matched every durable ACK identity. */
cp_journal_result_t cp_journal_ack(cp_journal_t *, uint16_t);
unsigned cp_journal_pending(const cp_journal_t *);
unsigned cp_journal_free_slots(const cp_journal_t *);
