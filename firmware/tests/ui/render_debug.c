// Host-only visual fixture: real stripe renderer and licensed fonts, synthetic
// telemetry. Writes a PPM framebuffer to argv[1]; optional argv[2] selects
// "setup", "activity", "vehicle" or "elevator" (default: memory debug).
// Compile with ui_mini.c, page_status.c, font_zh.c, font_digit.c and this dir's
// ESP stubs, plus cp_core/include and the Passport main include directories.
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include "page_status.h"
#include "ui_mini.h"

static uint16_t pixels[UI_H][UI_W];
static unsigned rows;

esp_err_t esp_lcd_panel_draw_bitmap(esp_lcd_panel_handle_t panel,
                                   int x0, int y0, int x1, int y1,
                                   const void *data)
{
    assert(panel == (void *)1 && x0 == 0 && x1 == UI_W);
    assert(y0 == (int)rows && y1 - y0 == 4 && y1 <= UI_H);
    const uint16_t *src = data;
    for (int y = y0; y < y1; y++)
        for (int x = x0; x < x1; x++) {
            uint16_t c = *src++;
            pixels[y][x] = (uint16_t)((c << 8) | (c >> 8));
        }
    rows = (unsigned)y1;
    return ESP_OK;
}

int main(int argc, char **argv)
{
    assert(argc == 2 || argc == 3);
    cp_status_view_t view = {0};
    strcpy(view.authentication, "registered");
    strcpy(view.collection, "collecting");
    cp_debug_snapshot_t *d = &view.debug;
    d->wifi_connected = d->wifi_rssi_known = d->wifi_phy_known = true;
    strcpy(d->wifi_ssid, "Synthetic Debug AP");
    strcpy(d->wifi_phy, "11n/20");
    d->wifi_rssi_dbm = -61;
    d->heap_known = d->queue_known = d->ble_collecting = true;
    d->heap_internal_free = 72 * 1024;
    d->heap_internal_total = 320 * 1024;
    d->heap_sample_min_free = 34 * 1024;
    d->heap_sample_min_largest = 18 * 1024;
    d->heap_internal_largest = 22 * 1024;
    d->heap_boot_min_8bit = 16 * 1024;
    d->queue_pending = 7; d->queue_capacity = 341;
    d->aggregation_drops = 2;
    d->upload.known = d->upload.goodput_known = true;
    d->upload.result = CP_DEBUG_UPLOAD_ACKED;
    d->upload.goodput_bytes_per_sec = 18944;
    d->upload.last_age_ms = 12000;
    d->upload.last_http_status = 200;
    d->clock_trusted = d->clock_estimated = true;
    d->clock_epoch = 2; d->clock_uncertainty_ms = 350;
    d->reports_total = 12034; d->windows_total = 18; d->summaries_total = 237;
    cp_debug_domain_t *slice = &d->domain;
    slice->known = slice->window_partial = slice->address_overflow = true;
    slice->window_seq = 19; slice->window_ms = 16000; slice->bin_ms = 1000;
    slice->age_ms = 1000; slice->bin_count = CP_DEBUG_DOMAIN_BINS;
    const uint32_t bins[CP_DEBUG_DOMAIN_BINS] = {3, 7, 12, 18, 26, 35, 29, 21, 13, 9, 5, 2};
    memcpy(slice->bin_reports, bins, sizeof bins);
    for (unsigned i = 0; i < CP_DEBUG_DOMAIN_BINS; i++) slice->reports_seen += bins[i];
    slice->reports_aggregated = slice->reports_seen - 6;
    slice->addresses = 16; slice->aggregation_drops = 6;
    slice->rssi_samples = slice->reports_seen;
    slice->rssi_min = -90; slice->rssi_mean = -65; slice->rssi_max = -42;
    slice->vehicle_candidates = 3; slice->vehicle_name_addresses = 4;
    slice->vehicle_ecosystem_addresses = 2; slice->vehicle_excluded_addresses = 1;
    slice->vehicle_parsed_reports = slice->reports_seen - 2;
    slice->vehicle_malformed_reports = 2;
    if (argc == 3) {
        if (!strcmp(argv[2], "setup")) {
            view.setup_active = view.setup_softap = true;
            strcpy(view.node_id, "synthetic-node");
            strcpy(view.setup_name, "Synthetic Setup AP");
            strcpy(view.setup_proof, "12345678");
            strcpy(view.setup_password, "example12345");
            strcpy(view.setup_state, "waiting");
        } else if (!strcmp(argv[2], "activity")) view.page = CP_DEVICE_PAGE_ACTIVITY;
        else if (!strcmp(argv[2], "vehicle")) view.page = CP_DEVICE_PAGE_VEHICLE;
        else if (!strcmp(argv[2], "elevator")) view.page = CP_DEVICE_PAGE_ELEVATOR;
        else assert(!"unknown fixture page");
    }
    assert(ui_init((void *)1) == ESP_OK);
    status_page_render(&view);
    assert(rows == UI_H);
    FILE *out = fopen(argv[1], "wb");
    assert(out && fprintf(out, "P6\n%d %d\n255\n", UI_W, UI_H) > 0);
    for (int y = 0; y < UI_H; y++)
        for (int x = 0; x < UI_W; x++) {
            uint16_t c = pixels[y][x];
            unsigned char rgb[3] = {
                (unsigned char)(((c >> 11) & 31) * 255 / 31),
                (unsigned char)(((c >> 5) & 63) * 255 / 63),
                (unsigned char)((c & 31) * 255 / 31)
            };
            assert(fwrite(rgb, sizeof rgb, 1, out) == 1);
        }
    assert(fclose(out) == 0);
    return 0;
}
