/* Synthetic table/time fixtures; no observations from physical devices. */
#include "scan_maintenance.h"
#include "veh_rules.h"

#include <assert.h>
#include <stdint.h>
#include <stdio.h>

static const uint8_t key[SCAN_KEY_LEN] = {0x02, 0, 0, 0, 0, 1};

static void observe(scan_table_t *table, uint32_t now)
{
    scan_table_observe_classified(table, key, false, -50, "YD-DEMO", 7,
                                 0, 0, false, false, true,
                                 EVID_POSITIVE, false, 0, now);
}

static void test_silent_clock(void)
{
    scan_table_t table;
    scan_table_reset(&table);
    const uint32_t start = 1000;
    observe(&table, start);
    const int slot = scan_table_find(&table, key);
    assert(slot >= 0);

    // No further advertisements or UI reads: the service's actual pure tick
    // must progress both dwell and confirmation clocks independently.
    scan_maintenance_tick(&table, start + 100);
    assert(table.entries[slot].dwell_ms == 100);
    scan_maintenance_tick(&table, start + SCAN_GATE_SAMPLE_MS);
    assert(table.entries[slot].gate_last_ms == start + SCAN_GATE_SAMPLE_MS);
    assert(table.entries[slot].gate_bits == 1);
    scan_maintenance_tick(&table, start + 5 * SCAN_GATE_SAMPLE_MS);
    assert(table.entries[slot].gate_last_ms == start + 5 * SCAN_GATE_SAMPLE_MS);
    assert(!table.entries[slot].counted);
    assert(table.entries[slot].dwell_ms == 5 * SCAN_GATE_SAMPLE_MS);
    scan_maintenance_tick(&table, start + SCAN_PRUNE_WINDOW_MS);
    assert(!table.entries[slot].used);
    assert(scan_table_count(&table, start + SCAN_PRUNE_WINDOW_MS) == 0);
    assert(scan_table_total(&table) == 1);

    // Return after expiry starts a new segment, preserving inherited semantics.
    observe(&table, start + SCAN_PRUNE_WINDOW_MS + 200);
    assert(scan_table_total(&table) == 2);
    const int new_slot = scan_table_find(&table, key);
    assert(new_slot >= 0 && table.entries[new_slot].dwell_ms == 0);
}

static void test_clock_wrap(void)
{
    scan_table_t table;
    scan_table_reset(&table);
    const uint32_t start = UINT32_MAX - 500;
    observe(&table, start);
    const int slot = scan_table_find(&table, key);
    assert(slot >= 0);
    scan_maintenance_tick(&table, start + 200u);
    assert(table.entries[slot].dwell_ms == 200);
    scan_maintenance_tick(&table, start + 1000u);
    assert(table.entries[slot].dwell_ms == 1000);
    assert(table.entries[slot].gate_last_ms == start + 1000u);
    scan_maintenance_tick(&table, start + SCAN_PRUNE_WINDOW_MS);
    assert(!table.entries[slot].used);
    assert(scan_table_total(&table) == 1);
}

static uint32_t locked_clock;
static unsigned clock_reads;

static uint32_t read_locked_clock(void)
{
    clock_reads++;
    return locked_clock;
}

static void test_observation_before_lock_acquisition(void)
{
    scan_table_t table;
    scan_table_reset(&table);
    observe(&table, 1000);
    // The worker's earlier scheduling instant was 1999. A higher-priority host
    // then writes a report at 2000 before the worker acquires the mutex.
    observe(&table, 2000);
    const int slot = scan_table_find(&table, key);
    assert(slot >= 0);
    locked_clock = 2000;
    clock_reads = 0;
    assert(scan_maintenance_run_locked(&table, read_locked_clock) == 2000);
    assert(clock_reads == 1);
    assert(table.entries[slot].used);
    assert(table.entries[slot].last_seen_ms == 2000);
    assert(scan_table_count(&table, locked_clock) == 1);
    assert(scan_table_total(&table) == 1);

    // Expose why the precondition matters using the same production table
    // operation: reusing the pre-lock 1999 instant wraps age and erases it.
    scan_table_t stale_clock_table = table;
    stale_clock_table.last_prune_ms = 0;
    scan_maintenance_tick(&stale_clock_table, 1999);
    assert(!stale_clock_table.entries[slot].used);
}

int main(void)
{
    test_silent_clock();
    test_clock_wrap();
    test_observation_before_lock_acquisition();
    puts("Independent table clock and millisecond-wrap regressions: PASS");
    return 0;
}
