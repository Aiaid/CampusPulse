#include "raw_activity.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

static uint64_t bin_us(unsigned epoch) {
    return (uint64_t)epoch * RAW_ACTIVITY_BIN_US;
}

static void test_ten_six_second_bins_roll(void) {
    raw_activity_t activity = {0};
    raw_activity_view_t view;

    for (unsigned epoch = 0; epoch < RAW_ACTIVITY_BINS; ++epoch)
        raw_activity_report(&activity, bin_us(epoch), -60);

    raw_activity_read(&activity, bin_us(9), &view);
    assert(view.received == RAW_ACTIVITY_BINS);
    for (unsigned i = 0; i < RAW_ACTIVITY_BINS; ++i)
        assert(view.reports[i] == 1);

    raw_activity_report(&activity, bin_us(10), -60);
    raw_activity_read(&activity, bin_us(10), &view);
    assert(view.received == RAW_ACTIVITY_BINS);
    for (unsigned i = 0; i < RAW_ACTIVITY_BINS; ++i)
        assert(view.reports[i] == 1);
}

static void test_unknown_rssi_and_aggregate_statistics(void) {
    raw_activity_t activity = {0};
    raw_activity_view_t view;

    raw_activity_report(&activity, bin_us(0), -90);
    raw_activity_report(&activity, bin_us(0) + 1, 127); /* unknown sentinel */
    raw_activity_report(&activity, bin_us(0) + 2, -30);
    raw_activity_report(&activity, bin_us(1), -60);
    raw_activity_report(&activity, bin_us(1) + 1, 21); /* out of range */

    raw_activity_read(&activity, bin_us(1), &view);
    assert(view.received == 5); /* invalid signal still counts as a report */
    assert(view.signal_known);
    assert(view.rssi_samples == 3);
    assert(view.rssi_min == -90);
    assert(view.rssi_mean == -60);
    assert(view.rssi_max == -30);
    assert(view.rssi_known[8] && view.rssi[8] == -60);
    assert(view.rssi_known[9] && view.rssi[9] == -60);
}

static void test_late_written_event_cannot_repopulate_expired_bin(void) {
    raw_activity_t activity = {0};
    raw_activity_view_t view;

    raw_activity_report(&activity, bin_us(0), -70);
    raw_activity_written(&activity, bin_us(0));
    raw_activity_report(&activity, bin_us(10), -70);

    /* A delayed storage completion for the expired receive window is ignored. */
    raw_activity_written(&activity, bin_us(0) + 1);
    raw_activity_read(&activity, bin_us(10), &view);
    assert(view.written == 0);
    assert(view.reports[0] == 0);
    assert(view.reports[9] == 1);

    raw_activity_written(&activity, bin_us(10));
    raw_activity_read(&activity, bin_us(10), &view);
    assert(view.written == 1);
}

static void test_clock_rollback_and_empty_state(void) {
    raw_activity_t activity = {0};
    raw_activity_view_t view;

    memset(&view, 0xa5, sizeof view);
    raw_activity_read(&activity, bin_us(20), &view);
    assert(view.received == 0 && view.written == 0);
    assert(!view.signal_known && view.rssi_samples == 0);
    for (unsigned i = 0; i < RAW_ACTIVITY_BINS; ++i) {
        assert(view.reports[i] == 0);
        assert(!view.rssi_known[i]);
    }

    raw_activity_report(&activity, bin_us(20), -50);
    raw_activity_read(&activity, bin_us(19), &view); /* now before first_us */
    assert(view.received == 0 && !view.signal_known);

    raw_activity_report(&activity, bin_us(19), -80); /* clock moved backwards */
    assert(activity.latest_epoch == 20); /* rollback must not move the frontier */
    raw_activity_read(&activity, bin_us(20), &view);
    assert(view.received == 2);
    assert(view.rssi_samples == 2);
    assert(view.rssi_min == -80 && view.rssi_max == -50);
}

static void test_fixed_bounded_state_has_no_address_or_payload_storage(void) {
    /* The API takes only time and RSSI; state is a fixed-size numeric ring. */
    assert(sizeof(raw_activity_t) <= RAW_ACTIVITY_BINS * 64u);
    assert(sizeof(raw_activity_view_t) <= 256u);
}

int main(void) {
    test_ten_six_second_bins_roll();
    test_unknown_rssi_and_aggregate_statistics();
    test_late_written_event_cannot_repopulate_expired_bin();
    test_clock_rollback_and_empty_state();
    test_fixed_bounded_state_has_no_address_or_payload_storage();
    puts("raw activity host tests passed");
    return 0;
}
