#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "raw_ui.h"

#define WIDTH 200
#define HEIGHT 200
static uint8_t frame[WIDTH * HEIGHT];
static unsigned flush_count;
static void flush(lv_display_t *d, const lv_area_t *a, uint8_t *pixels) {
    if (a->x1 != 0 || a->y1 != 0 || a->x2 != 199 || a->y2 != 199 || pixels != frame) {
        fputs("unexpected frame area\n", stderr); exit(1);
    }
    flush_count++; lv_display_flush_ready(d);
}
static void check_layout(lv_obj_t *screen) {
    lv_obj_update_layout(screen);
    uint32_t count = lv_obj_get_child_count(screen);
    for (uint32_t i = 0; i < count; i++) {
        lv_obj_t *o = lv_obj_get_child(screen, (int32_t)i);
        if (lv_obj_has_flag(o, LV_OBJ_FLAG_HIDDEN) || !lv_obj_check_type(o, &lv_label_class)) continue;
        lv_area_t r; lv_obj_get_coords(o, &r); lv_point_t text;
        lv_text_get_size(&text, lv_label_get_text(o), lv_obj_get_style_text_font(o, 0), 0, 0, 10000, LV_TEXT_FLAG_NONE);
        if (r.x1 < 0 || r.y1 < 0 || r.x2 >= WIDTH || r.y2 >= HEIGHT || text.x > lv_obj_get_width(o)) {
            fprintf(stderr, "outside bounds: %s text %d available %d rect %d,%d,%d,%d\n", lv_label_get_text(o),
                    (int)text.x, (int)lv_obj_get_width(o), (int)r.x1, (int)r.y1, (int)r.x2, (int)r.y2); exit(1);
        }
        if (!strcmp(lv_label_get_text(o), "...")) {fputs("meaningful value lost to ellipsis\n", stderr); exit(1);}
        if (!lv_label_get_text(o)[0]) continue;
        for (uint32_t j = 0; j < i; j++) {
            lv_obj_t *p = lv_obj_get_child(screen, (int32_t)j);
            if (lv_obj_has_flag(p, LV_OBJ_FLAG_HIDDEN) || !lv_obj_check_type(p, &lv_label_class) || !lv_label_get_text(p)[0]) continue;
            lv_area_t q; lv_obj_get_coords(p, &q);
            if (r.x1 <= q.x2 && r.x2 >= q.x1 && r.y1 <= q.y2 && r.y2 >= q.y1) {
                fprintf(stderr, "overlap: %s / %s\n", lv_label_get_text(o), lv_label_get_text(p)); exit(1);
            }
        }
    }
}
static int render(lv_display_t *d, const raw_display_snapshot_t *s, const char *dir, const char *name) {
    raw_ui_update(s); check_layout(lv_display_get_screen_active(d)); flush_count = 0;
    lv_obj_invalidate(lv_display_get_screen_active(d)); lv_refr_now(d);
    if (flush_count != 1) {fputs("expected one full software flush\n", stderr); return 1;}
    char path[1024]; snprintf(path, sizeof(path), "%s/%s.pgm", dir, name);
    uint8_t mono[sizeof(frame)];
    for (size_t i = 0; i < sizeof(frame); i++) mono[i] = frame[i] >= 128 ? 255 : 0;
    FILE *out = fopen(path, "wb");
    if (!out || fprintf(out, "P5\n200 200\n255\n") < 0 || fwrite(mono, 1, sizeof(mono), out) != sizeof(frame) || fclose(out)) return 1;
    printf("%s: labels fit; no overlap; 1 full software frame\n", name); return 0;
}
int main(int argc, char **argv) {
    if (argc != 2) return 2;
    lv_init(); lv_display_t *d = lv_display_create(WIDTH, HEIGHT); if (!d) return 1;
    lv_display_set_color_format(d, LV_COLOR_FORMAT_L8);
    lv_display_set_buffers(d, frame, NULL, sizeof(frame), LV_DISPLAY_RENDER_MODE_FULL);
    lv_display_set_flush_cb(d, flush); raw_ui_init(d);
    for (unsigned variant = 0; variant < 4; variant++) {
        raw_display_snapshot_t s = {.received = 126480, .written = 126450, .synced = 126400, .dropped = 6,
            .reports_per_second = 128, .free_bytes = 28200000000ULL, .total_bytes = 32000000000ULL, .free_known = true,
            .uptime_s = 766, .recent_received = 7680, .recent_written = 7674,
            .internal_total = 400000, .internal_free = 248000, .memory_known = true,
            .psram_total = 8000000, .psram_free = 6240000, .psram_known = true,
            .buffer_used = 80, .buffer_capacity = 1000, .rssi_known = true,
            .rssi_min = -88, .rssi_mean = -63, .rssi_max = -42, .rssi_samples = 7680};
        strcpy(s.state, "RECORDING");
        if (variant == 0) { s.clock_known = s.clock_calibrated = true; s.utc_epoch = 1793270000; }
        for (unsigned i = 0; i < 10; i++) {s.report_bins[i] = (uint32_t[]){40,55,80,128,100,80,70,55,75,95}[i]; s.rssi_bins[i] = -88 + i * 4; s.rssi_bin_known[i] = true;}
        if (variant == 1) {
            s.free_known = s.memory_known = s.psram_known = s.rssi_known = false;
            s.total_bytes = s.buffer_capacity = s.rssi_samples = 0;
            memset(s.rssi_bin_known, 0, sizeof(s.rssi_bin_known)); memset(s.report_bins, 0, sizeof(s.report_bins));
        } else if (variant == 2) {
            s.received = s.written = s.synced = s.dropped = s.recent_received = s.recent_written = s.uptime_s = UINT64_MAX;
            s.reports_per_second = s.rssi_samples = s.storage_errors = UINT32_MAX;
            s.free_bytes = UINT64_MAX - 1024; s.total_bytes = UINT64_MAX;
            s.wifi_enabled = s.wifi_connected = s.wifi_rssi_known = true; s.wifi_rssi = -127;
            memset(s.wifi_ssid, 'W', sizeof(s.wifi_ssid) - 1); strcpy(s.ip, "255.255.255.255");
            s.battery_known = true; s.battery_percent = 100;
        } else if (variant == 3) {
            strcpy(s.state, "STORAGE ERROR"); s.storage_errors = 42; s.free_known = false;
            s.wifi_enabled = true; s.rssi_bin_known[4] = s.rssi_bin_known[5] = false;
        }
        for (unsigned page = 0; page < 4; page++) {
            s.page = page; char name[64]; snprintf(name, sizeof(name), "%s-page-%u", (const char *[]) {"normal", "unknown", "large", "error"}[variant], page + 1);
            if (render(d, &s, argv[1], name)) return 1;
            /* Repeat updates without rebuilding to cover the live-update path. */
            raw_ui_update(&s); check_layout(lv_display_get_screen_active(d));
        }
    }
    const char *states[] = {"STOPPING", "LOW SPACE; STOPPING", "SAFE TO REMOVE", "LOW SPACE; CARD SAFE", "CARD FULL", "BLE ERROR", "CARD SAFE SCAN ERROR"};
    const char *expected[] = {"停止中", "停止中", "可移除", "可移除", "存储错误", "错误", "错误"};
    for (unsigned i = 0; i < sizeof(states) / sizeof(states[0]); i++) {
        raw_display_snapshot_t s = {0}; snprintf(s.state, sizeof(s.state), "%s", states[i]);
        char name[64]; snprintf(name, sizeof(name), "state-%u", i);
        if (render(d, &s, argv[1], name)) return 1;
        bool found = false; lv_obj_t *screen = lv_display_get_screen_active(d);
        for (uint32_t j = 0; j < lv_obj_get_child_count(screen); j++) {
            lv_obj_t *o = lv_obj_get_child(screen, j);
            if (lv_obj_check_type(o, &lv_label_class) && !strcmp(lv_label_get_text(o), expected[i])) found = true;
        }
        if (!found) {fprintf(stderr, "missing state text for %s\n", states[i]); return 1;}
    }
    return 0;
}
