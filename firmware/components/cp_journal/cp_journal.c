#include "cp_journal.h"
#include <string.h>

/* Explicit little-endian header; no compiler ABI or host padding on Flash.
 * Body first, commit header last. One batch per erase-aligned slot. */
#define HEADER_BYTES 40u
#define STATE_OFFSET 32u
#define COMMITTED 0xfffffffeu
#define ACKED 0xfffffffcu
static const unsigned char magic[8] = {'C', 'P', 'Q', '2', 'B', 'A', 'T', 'C'};
static uint32_t get32(const unsigned char *p) {
    return (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24;
}
static void put32(unsigned char *p, uint32_t x) {
    for (unsigned i = 0; i < 4; i++)
        p[i] = (unsigned char)(x >> (i * 8));
}
static uint64_t get64(const unsigned char *p) { return get32(p) | (uint64_t)get32(p + 4) << 32; }
static void put64(unsigned char *p, uint64_t x) {
    put32(p, (uint32_t)x);
    put32(p + 4, (uint32_t)(x >> 32));
}
static uint32_t crc_update(uint32_t crc, const unsigned char *p, size_t n) {
    while (n--) {
        crc ^= *p++;
        for (unsigned i = 0; i < 8; i++)
            crc = (crc >> 1) ^ ((crc & 1) ? 0xedb88320u : 0);
    }
    return crc;
}
static uint32_t crc(const void *data, size_t n) { return ~crc_update(0xffffffffu, data, n); }
static cp_journal_result_t io_error(cp_journal_t *j) {
    j->io_failures++;
    return CP_JOURNAL_IO;
}
static bool erased_slot(cp_journal_t *j, unsigned slot, bool *empty) {
    unsigned char chunk[256];
    *empty = true;
    for (size_t i = 0; i < CP_JOURNAL_SLOT_BYTES; i += sizeof chunk) {
        if (!j->flash.read(j->flash.context, slot * CP_JOURNAL_SLOT_BYTES + i, chunk, sizeof chunk))
            return false;
        for (size_t k = 0; k < sizeof chunk; k++)
            if (chunk[k] != 0xff) {
                *empty = false;
                return true;
            }
    }
    return true;
}
static bool body_crc(cp_journal_t *j, unsigned slot, size_t len, uint32_t *out) {
    unsigned char chunk[256];
    uint32_t c = 0xffffffffu;
    for (size_t off = 0; off < len;) {
        size_t n = len - off < sizeof chunk ? len - off : sizeof chunk;
        if (!j->flash.read(j->flash.context, slot * CP_JOURNAL_SLOT_BYTES + HEADER_BYTES + off,
                           chunk, n))
            return false;
        c = crc_update(c, chunk, n);
        off += n;
    }
    *out = ~c;
    return true;
}
cp_journal_result_t cp_journal_open(cp_journal_t *j, cp_flash_t flash) {
    if (!j || !flash.read || !flash.write || !flash.erase || flash.size < CP_JOURNAL_SLOT_BYTES ||
        flash.size / CP_JOURNAL_SLOT_BYTES > CP_JOURNAL_MAX_SLOTS)
        return CP_JOURNAL_INVALID;
    memset(j, 0, sizeof *j);
    j->flash = flash;
    j->count = (uint16_t)(flash.size / CP_JOURNAL_SLOT_BYTES);
    j->next_ordinal = 1;
    for (unsigned i = 0; i < j->count; i++) {
        unsigned char h[HEADER_BYTES];
        bool empty;
        if (!flash.read(flash.context, i * CP_JOURNAL_SLOT_BYTES, h, sizeof h))
            return io_error(j);
        uint32_t length = get32(h + 16), state = get32(h + STATE_OFFSET), c;
        bool valid = !memcmp(h, magic, 8) && get32(h + 8) == 2 && length > 0 &&
                     length <= CP_JOURNAL_MAX_BODY && get32(h + 28) == crc(h, 28) &&
                     (state == COMMITTED || state == ACKED) && get64(h + 20) > 0;
        if (valid) {
            if (!body_crc(j, i, length, &c))
                return io_error(j);
            valid = c == get32(h + 12);
        }
        if (valid) {
            j->slots[i] = (cp_journal_slot_t){get64(h + 20), length,
                                              state == ACKED ? CP_SLOT_ACKED : CP_SLOT_PENDING};
            if (j->slots[i].ordinal == UINT64_MAX)
                return CP_JOURNAL_CORRUPT;
            if (j->next_ordinal <= j->slots[i].ordinal)
                j->next_ordinal = j->slots[i].ordinal + 1;
        } else {
            if (!erased_slot(j, i, &empty))
                return io_error(j);
            j->slots[i].state = empty ? CP_SLOT_FREE : CP_SLOT_QUARANTINED;
            if (!empty)
                j->corrupt_slots++;
        }
    }
    j->ready = true;
    return CP_JOURNAL_OK;
}
unsigned cp_journal_pending(const cp_journal_t *j) {
    unsigned n = 0;
    if (j)
        for (unsigned i = 0; i < j->count; i++)
            n += j->slots[i].state == CP_SLOT_PENDING;
    return n;
}
unsigned cp_journal_free_slots(const cp_journal_t *j) {
    unsigned n = 0;
    if (j)
        for (unsigned i = 0; i < j->count; i++)
            n += j->slots[i].state == CP_SLOT_FREE || j->slots[i].state == CP_SLOT_ACKED;
    return n;
}
cp_journal_result_t cp_journal_append(cp_journal_t *j, const void *data, size_t n, bool control,
                                      uint16_t *slot) {
    if (!j || !j->ready || !data || !n || n > CP_JOURNAL_MAX_BODY || !slot)
        return CP_JOURNAL_INVALID;
    unsigned free = cp_journal_free_slots(j);
    if (!free || (!control && free <= CP_JOURNAL_CONTROL_RESERVE))
        return CP_JOURNAL_FULL;
    unsigned selected = j->count;
    for (unsigned i = 0; i < j->count; i++)
        if (j->slots[i].state == CP_SLOT_FREE) {
            selected = i;
            break;
        }
    if (selected == j->count)
        for (unsigned i = 0; i < j->count; i++)
            if (j->slots[i].state == CP_SLOT_ACKED) {
                selected = i;
                break;
            }
    if (selected == j->count || j->next_ordinal == UINT64_MAX)
        return CP_JOURNAL_FULL;
    size_t base = selected * CP_JOURNAL_SLOT_BYTES;
    const bool reclaim = j->slots[selected].state == CP_SLOT_ACKED;
    j->slots[selected].state = CP_SLOT_QUARANTINED;
    j->corrupt_slots++;
    if (reclaim && !j->flash.erase(j->flash.context, base, CP_JOURNAL_SLOT_BYTES))
        return io_error(j);
    if (!j->flash.write(j->flash.context, base + HEADER_BYTES, data, n))
        return io_error(j);
    unsigned char h[HEADER_BYTES];
    memset(h, 0xff, sizeof h);
    memcpy(h, magic, 8);
    put32(h + 8, 2);
    put32(h + 12, crc(data, n));
    put32(h + 16, (uint32_t)n);
    put64(h + 20, j->next_ordinal);
    put32(h + 28, crc(h, 28));
    put32(h + STATE_OFFSET, COMMITTED);
    if (!j->flash.write(j->flash.context, base, h, sizeof h))
        return io_error(j);
    unsigned char check[HEADER_BYTES];
    uint32_t c;
    if (!j->flash.read(j->flash.context, base, check, sizeof check) || memcmp(h, check, sizeof h) ||
        !body_crc(j, selected, n, &c) || c != get32(h + 12))
        return io_error(j);
    j->slots[selected] = (cp_journal_slot_t){j->next_ordinal++, (uint32_t)n, CP_SLOT_PENDING};
    j->corrupt_slots--;
    *slot = (uint16_t)selected;
    return CP_JOURNAL_OK;
}
cp_journal_result_t cp_journal_oldest(const cp_journal_t *j, uint16_t *slot) {
    if (!j || !j->ready || !slot)
        return CP_JOURNAL_INVALID;
    unsigned best = j->count;
    for (unsigned i = 0; i < j->count; i++)
        if (j->slots[i].state == CP_SLOT_PENDING &&
            (best == j->count || j->slots[i].ordinal < j->slots[best].ordinal))
            best = i;
    if (best == j->count)
        return CP_JOURNAL_NOT_FOUND;
    *slot = (uint16_t)best;
    return CP_JOURNAL_OK;
}
cp_journal_result_t cp_journal_read(cp_journal_t *j, uint16_t slot, void *out, size_t cap,
                                    size_t *len) {
    if (!j || !j->ready || slot >= j->count || !out || !len ||
        j->slots[slot].state != CP_SLOT_PENDING || cap < j->slots[slot].length)
        return CP_JOURNAL_INVALID;
    size_t base = slot * CP_JOURNAL_SLOT_BYTES;
    unsigned char h[HEADER_BYTES];
    if (!j->flash.read(j->flash.context, base, h, sizeof h) ||
        !j->flash.read(j->flash.context, base + HEADER_BYTES, out, j->slots[slot].length))
        return io_error(j);
    if (memcmp(h, magic, 8) || get32(h + 8) != 2 || get32(h + 16) != j->slots[slot].length ||
        get64(h + 20) != j->slots[slot].ordinal || get32(h + 28) != crc(h, 28) ||
        (get32(h + STATE_OFFSET) != COMMITTED && get32(h + STATE_OFFSET) != ACKED) ||
        get32(h + 12) != crc(out, j->slots[slot].length)) {
        j->slots[slot].state = CP_SLOT_QUARANTINED;
        j->corrupt_slots++;
        return CP_JOURNAL_CORRUPT;
    }
    /* An ACK write can succeed while its readback fails. Keep RAM pending and
     * retry the exact body; only another verified cloud ACK may reclaim it.
     * Treating this valid ACKED marker as corruption would strand capacity. */
    *len = j->slots[slot].length;
    return CP_JOURNAL_OK;
}
cp_journal_result_t cp_journal_ack(cp_journal_t *j, uint16_t slot) {
    if (!j || !j->ready || slot >= j->count)
        return CP_JOURNAL_INVALID;
    if (j->slots[slot].state == CP_SLOT_ACKED)
        return CP_JOURNAL_OK;
    if (j->slots[slot].state != CP_SLOT_PENDING)
        return CP_JOURNAL_INVALID;
    unsigned char value[4], check[4];
    put32(value, ACKED);
    size_t offset = slot * CP_JOURNAL_SLOT_BYTES + STATE_OFFSET;
    if (!j->flash.write(j->flash.context, offset, value, 4) ||
        !j->flash.read(j->flash.context, offset, check, 4) || memcmp(value, check, 4))
        return io_error(j);
    j->slots[slot].state = CP_SLOT_ACKED;
    return CP_JOURNAL_OK;
}
