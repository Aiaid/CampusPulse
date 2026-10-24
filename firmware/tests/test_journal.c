#include "cp_journal.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define SLOTS 12u
typedef struct {
    unsigned char bytes[SLOTS * CP_JOURNAL_SLOT_BYTES];
    int writes, fail_write, reads, fail_read;
    size_t prefix;
    unsigned erases;
} flash_t;
static bool read_flash(void *c, size_t o, void *out, size_t n) {
    flash_t *f = c;
    if (++f->reads == f->fail_read)
        return false;
    if (o + n > sizeof f->bytes)
        return false;
    memcpy(out, f->bytes + o, n);
    return true;
}
static bool write_flash(void *c, size_t o, const void *in, size_t n) {
    flash_t *f = c;
    if (o + n > sizeof f->bytes)
        return false;
    bool fail = ++f->writes == f->fail_write;
    size_t actual = fail ? (f->prefix < n ? f->prefix : n) : n;
    const unsigned char *p = in;
    for (size_t i = 0; i < actual; i++) {
        if ((f->bytes[o + i] & p[i]) != p[i])
            return false;
        f->bytes[o + i] &= p[i];
    }
    return !fail;
}
static bool erase_flash(void *c, size_t o, size_t n) {
    flash_t *f = c;
    if (o % 4096 || n % 4096 || o + n > sizeof f->bytes)
        return false;
    memset(f->bytes + o, 255, n);
    f->erases++;
    return true;
}
static cp_flash_t adapter(flash_t *f) {
    return (cp_flash_t){f, sizeof f->bytes, read_flash, write_flash, erase_flash};
}
static void blank(flash_t *f) {
    memset(f, 0, sizeof *f);
    memset(f->bytes, 255, sizeof f->bytes);
}
static void test_frozen_retry_and_reboot(flash_t *f, cp_journal_t *j) {
    blank(f);
    assert(cp_journal_open(j, adapter(f)) == CP_JOURNAL_OK);
    const char body[] = "{\"batch_id\":\"synthetic\",\"items\":[1,2]}\n";
    uint16_t a, b;
    size_t len;
    char copy[128];
    assert(cp_journal_append(j, body, sizeof body - 1, false, &a) == CP_JOURNAL_OK);
    assert(f->erases == 0);
    assert(cp_journal_open(j, adapter(f)) == CP_JOURNAL_OK);
    assert(cp_journal_pending(j) == 1 && cp_journal_oldest(j, &b) == CP_JOURNAL_OK && a == b);
    assert(cp_journal_read(j, b, copy, sizeof copy, &len) == CP_JOURNAL_OK &&
           len == sizeof body - 1 && !memcmp(body, copy, len));
    /* A lost network response leaves the exact same bytes pending across boot. */
    assert(cp_journal_open(j, adapter(f)) == CP_JOURNAL_OK && cp_journal_pending(j) == 1);
    assert(cp_journal_ack(j, b) == CP_JOURNAL_OK && cp_journal_ack(j, b) == CP_JOURNAL_OK);
    assert(cp_journal_open(j, adapter(f)) == CP_JOURNAL_OK && cp_journal_pending(j) == 0);
}
static void test_pressure_and_no_unacked_erase(flash_t *f, cp_journal_t *j) {
    blank(f);
    assert(cp_journal_open(j, adapter(f)) == CP_JOURNAL_OK);
    uint16_t slot;
    for (unsigned i = 0; i < SLOTS - CP_JOURNAL_CONTROL_RESERVE; i++)
        assert(cp_journal_append(j, "raw", 3, false, &slot) == CP_JOURNAL_OK);
    assert(cp_journal_append(j, "raw", 3, false, &slot) == CP_JOURNAL_FULL);
    for (unsigned i = 0; i < CP_JOURNAL_CONTROL_RESERVE; i++)
        assert(cp_journal_append(j, "status", 6, true, &slot) == CP_JOURNAL_OK);
    assert(cp_journal_pending(j) == SLOTS &&
           cp_journal_append(j, "window", 6, true, &slot) == CP_JOURNAL_FULL && f->erases == 0);
    assert(cp_journal_oldest(j, &slot) == CP_JOURNAL_OK && slot == 0);
    assert(cp_journal_ack(j, slot) == CP_JOURNAL_OK);
    assert(cp_journal_append(j, "new", 3, true, &slot) == CP_JOURNAL_OK && slot == 0 &&
           f->erases == 1);
    assert(cp_journal_open(j, adapter(f)) == CP_JOURNAL_OK && cp_journal_pending(j) == SLOTS);
}
static void test_power_loss(flash_t *f, cp_journal_t *j) {
    for (int phase = 1; phase <= 3; phase++)
        for (size_t prefix = 0; prefix < 8; prefix++) {
            blank(f);
            assert(cp_journal_open(j, adapter(f)) == CP_JOURNAL_OK);
            uint16_t slot;
            f->fail_write = phase;
            f->prefix = prefix;
            cp_journal_result_t result =
                cp_journal_append(j, "frozen sample payload", 21, true, &slot);
            if (phase < 3) {
                assert(result == CP_JOURNAL_IO);
                assert(j->corrupt_slots == 1); // Visible before a reboot/reopen.
            } else {
                assert(result == CP_JOURNAL_OK);
                assert(j->corrupt_slots == 0);
            }
            if (phase == 3)
                assert(cp_journal_ack(j, slot) == CP_JOURNAL_IO);
            f->fail_write = 0;
            assert(cp_journal_open(j, adapter(f)) == CP_JOURNAL_OK);
            if (phase < 3)
                assert(cp_journal_pending(j) == 0);
            else
                assert(cp_journal_pending(j) <=
                       1); /* Fully written ACK can survive lost readback. */
            assert(f->erases == 0);
        }
}
static void test_unknown_and_corrupt(flash_t *f, cp_journal_t *j) {
    blank(f);
    memcpy(f->bytes, "OLD_CAPTURE_DO_NOT_ERASE", 24);
    assert(cp_journal_open(j, adapter(f)) == CP_JOURNAL_OK && j->corrupt_slots == 1);
    uint16_t slot;
    assert(cp_journal_append(j, "new", 3, true, &slot) == CP_JOURNAL_OK && slot == 1);
    assert(!memcmp(f->bytes, "OLD_CAPTURE_DO_NOT_ERASE", 24) && f->erases == 0);
    f->bytes[slot * CP_JOURNAL_SLOT_BYTES + 40] ^= 1;
    char out[10];
    size_t len;
    assert(cp_journal_read(j, slot, out, sizeof out, &len) == CP_JOURNAL_CORRUPT);
    assert(cp_journal_ack(j, slot) == CP_JOURNAL_INVALID);
    assert(cp_journal_open(j, adapter(f)) == CP_JOURNAL_OK && j->corrupt_slots == 2 &&
           f->erases == 0);
}
static void test_ambiguous_ack_readback(flash_t *f, cp_journal_t *j) {
    blank(f);
    assert(cp_journal_open(j, adapter(f)) == CP_JOURNAL_OK);
    uint16_t slot;
    assert(cp_journal_append(j, "unchanged request", 17, true, &slot) == CP_JOURNAL_OK);
    f->fail_read = f->reads + 1;
    // Model a verified server ACK followed by an uncertain local marker write.
    assert(cp_journal_ack(j, slot) == CP_JOURNAL_IO);
    assert(cp_journal_pending(j) == 1 && cp_journal_free_slots(j) == SLOTS - 1);
    char body[32];
    size_t len;
    assert(cp_journal_read(j, slot, body, sizeof body, &len) == CP_JOURNAL_OK);
    assert(len == 17 && !memcmp(body, "unchanged request", len) && j->corrupt_slots == 0);
    // An exact cloud retry is confirmed before trying the durable marker again.
    assert(cp_journal_ack(j, slot) == CP_JOURNAL_OK);
    assert(cp_journal_pending(j) == 0 && cp_journal_free_slots(j) == SLOTS && f->erases == 0);
}
int main(void) {
    flash_t *f = malloc(sizeof *f);
    cp_journal_t *j = malloc(sizeof *j);
    assert(f && j);
    test_frozen_retry_and_reboot(f, j);
    test_pressure_and_no_unacked_erase(f, j);
    test_power_loss(f, j);
    test_unknown_and_corrupt(f, j);
    test_ambiguous_ack_readback(f, j);
    free(f);
    free(j);
    puts("Frozen Flash journal, power cuts, pressure and evidence preservation: PASS");
    return 0;
}
