#include <assert.h>
#include <stdio.h>
#include "display_schedule.h"

static void test_normal_cadence_and_dedup(void)
{
    cp_status_view_t shown = {0}, next = {0};
    assert(!cp_display_should_render(NULL, &shown, false, 0, 0, 2000));
    assert(cp_display_should_render(&next, &shown, false, 0, 0, 2000));
    assert(!cp_display_should_render(&next, &shown, true, 2000, 0, 2000));
    next.debug.heap_internal_free = 43000;
    assert(!cp_display_should_render(&next, &shown, true, 500, 0, 2000));
    assert(!cp_display_should_render(&next, &shown, true, 1000, 0, 2000));
    assert(!cp_display_should_render(&next, &shown, true, 1999, 0, 2000));
    assert(cp_display_should_render(&next, &shown, true, 2000, 0, 2000));
    shown = next;
    assert(!cp_display_should_render(&next, &shown, true, 9000, 2000, 2000));
    next.debug.heap_internal_free--;
    assert(cp_display_should_render(&next, &shown, true, 1999, 2000, 2000));
    assert(!cp_display_should_render(&shown, &shown, true, 1999, 2000, 2000));
    assert(!cp_display_should_render(&next, &shown, true, 11999, 2000, 10000));
    assert(cp_display_should_render(&next, &shown, true, 12000, 2000, 10000));
}

static void test_immediate_controls_and_failure_edges(void)
{
    cp_status_view_t shown = {0}, next;
#define URGENT_CHANGE(field, value) do { \
    next = shown; next.field = (value); \
    assert(cp_display_should_render(&next, &shown, true, 1001, 1000, 2000)); \
} while (0)
    URGENT_CHANGE(page, CP_DEVICE_PAGE_ACTIVITY);
    URGENT_CHANGE(setup_active, true);
    URGENT_CHANGE(setup_softap, true);
    URGENT_CHANGE(setup_usb, true);
    URGENT_CHANGE(authentication[0], 'A');
    URGENT_CHANGE(collection[0], 'E');
    URGENT_CHANGE(debug.upload.failures, 1);
    URGENT_CHANGE(debug.storage_drops, 1);
    URGENT_CHANGE(debug.windows_dropped, 1);
    URGENT_CHANGE(debug.queue_quarantined, 1);
    shown.setup_active = true;
    URGENT_CHANGE(setup_name[0], 'N');
    URGENT_CHANGE(setup_proof[0], '9');
    URGENT_CHANGE(setup_password[0], 'P');
    URGENT_CHANGE(setup_state[0], 'S');
#undef URGENT_CHANGE
    shown.debug.upload.failures = 8;
    next = shown; next.debug.upload.failures = 7;
    assert(!cp_display_should_render(&next, &shown, true, 1001, 1000, 2000));
    next.debug.upload.failures = 9;
    assert(cp_display_should_render(&next, &shown, true, 1001, 1000, 2000));
}

static void test_upload_and_sensor_updates_cannot_drive_fps(void)
{
    cp_status_view_t shown = {0}, next = {0};
#define NORMAL_CHANGE(field, value) do { \
    next = shown; next.field = (value); \
    assert(!cp_display_should_render(&next, &shown, true, 1999, 1000, 2000)); \
    assert(cp_display_should_render(&next, &shown, true, 3000, 1000, 2000)); \
} while (0)
    NORMAL_CHANGE(debug.upload.in_flight, true);
    NORMAL_CHANGE(debug.upload.known, true);
    NORMAL_CHANGE(debug.upload.result, CP_DEBUG_UPLOAD_ACKED);
    NORMAL_CHANGE(debug.upload.goodput_bytes_per_sec, 1234);
    NORMAL_CHANGE(debug.upload.last_age_ms, 9999);
    NORMAL_CHANGE(debug.upload.last_http_status, 200);
    NORMAL_CHANGE(debug.upload.last_error, -1);
    NORMAL_CHANGE(debug.queue_pending, 5);
    NORMAL_CHANGE(debug.queue_capacity, 341);
    NORMAL_CHANGE(debug.heap_internal_free, 43000);
    NORMAL_CHANGE(debug.heap_boot_min_8bit, 16464);
    NORMAL_CHANGE(debug.domain.age_ms, 4000);
    NORMAL_CHANGE(debug.domain.reports_seen, 100);
    NORMAL_CHANGE(debug.raw_drops, 12);
    NORMAL_CHANGE(debug.summary_drops, 13);
    NORMAL_CHANGE(debug.aggregation_drops, 14);
    // Hidden setup fields cannot defeat normal cadence outside setup.
    NORMAL_CHANGE(setup_proof[0], '9');
    NORMAL_CHANGE(setup_password[0], 'P');
#undef NORMAL_CHANGE
    // A continuing upload toggles every 500 ms. Normal changed frames remain
    // exactly two seconds apart, rather than following those transitions.
    uint64_t last_ms = 0;
    unsigned draws = 0;
    for (uint64_t now = 500; now <= 10000; now += 500) {
        next.debug.upload.in_flight = !next.debug.upload.in_flight;
        next.debug.upload.last_age_ms = (uint32_t)now;
        if (cp_display_should_render(&next, &shown, true, now, last_ms, 2000)) {
            assert(now - last_ms == 2000);
            shown = next;
            last_ms = now;
            draws++;
        }
    }
    assert(draws == 5);
}

int main(void)
{
    test_normal_cadence_and_dedup();
    test_immediate_controls_and_failure_edges();
    test_upload_and_sensor_updates_cannot_drive_fps();
    puts("Display admission: 0.5 FPS normal, immediate controls/failures, dedup and rollback PASS");
    return 0;
}
