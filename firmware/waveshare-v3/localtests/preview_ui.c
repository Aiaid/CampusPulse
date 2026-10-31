#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "raw_ui.h"
#include "edge_ui.h"

#define WIDTH 200
#define HEIGHT 200
static uint8_t frame[WIDTH * HEIGHT];
static unsigned flush_count;
static bool has_label(lv_obj_t *screen, const char *text) {
    for (uint32_t i = 0; i < lv_obj_get_child_count(screen); i++) {
        lv_obj_t *o = lv_obj_get_child(screen, i);
        if (lv_obj_check_type(o, &lv_label_class) && !strcmp(lv_label_get_text(o), text)) return true;
    }
    return false;
}
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
        if (lv_obj_has_flag(o, LV_OBJ_FLAG_HIDDEN)) continue;
        lv_area_t bounds; lv_obj_get_coords(o, &bounds);
        if (bounds.x1 < 0 || bounds.y1 < 0 || bounds.x2 >= WIDTH || bounds.y2 >= HEIGHT) {
            fputs("object outside display bounds\n", stderr); exit(1);
        }
        if (!lv_obj_check_type(o, &lv_label_class)) continue;
        lv_area_t r; lv_obj_get_coords(o, &r); lv_point_t text;
        const unsigned char *utf8 = (const unsigned char *)lv_label_get_text(o);
        while (*utf8) {
            uint32_t cp = *utf8++;
            unsigned following = cp < 128 ? 0 : cp < 224 ? 1 : cp < 240 ? 2 : 3;
            if (following) { cp &= (1u << (6 - following)) - 1; while (following--) cp = (cp << 6) | (*utf8++ & 63); }
            lv_font_glyph_dsc_t glyph;
            if (!lv_font_get_glyph_dsc(lv_obj_get_style_text_font(o, 0), &glyph, cp, 0) || glyph.is_placeholder) {
                fprintf(stderr, "missing glyph U+%04x\n", (unsigned)cp); exit(1);
            }
        }
        lv_text_get_size(&text, lv_label_get_text(o), lv_obj_get_style_text_font(o, 0), 0, 0, 10000, LV_TEXT_FLAG_NONE);
        if (r.x1 < 0 || r.y1 < 0 || r.x2 >= WIDTH || r.y2 >= HEIGHT || text.x > lv_obj_get_width(o) || text.y > lv_obj_get_height(o)) {
            fprintf(stderr, "outside bounds: %s text %d available %d rect %d,%d,%d,%d\n", lv_label_get_text(o),
                    (int)text.x, (int)lv_obj_get_width(o), (int)r.x1, (int)r.y1, (int)r.x2, (int)r.y2); exit(1);
        }
        if (!strcmp(lv_label_get_text(o), "...")) {fputs("meaningful value lost to ellipsis\n", stderr); exit(1);}
        if (!lv_label_get_text(o)[0]) continue;
        for (uint32_t j = 0; j < i; j++) {
            lv_obj_t *p = lv_obj_get_child(screen, (int32_t)j);
            if (lv_obj_has_flag(p, LV_OBJ_FLAG_HIDDEN)) continue;
            bool is_label = lv_obj_check_type(p, &lv_label_class);
            if (is_label && !lv_label_get_text(p)[0]) continue;
            /* Original decorative rules can touch a label's empty baseline. */
            if (!is_label && lv_obj_get_height(p) == 1) continue;
            lv_area_t q; lv_obj_get_coords(p, &q);
            if (r.x1 <= q.x2 && r.x2 >= q.x1 && r.y1 <= q.y2 && r.y2 >= q.y1) {
                fprintf(stderr, "overlap: %s / %s\n", lv_label_get_text(o), is_label ? lv_label_get_text(p) : "graphic"); exit(1);
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
    for (unsigned variant = 0; variant < 11; ++variant) {
        edge_ui_metrics_t m = {.phase = EDGE_UI_COLLECTING, .metrics_known = true, .capture_known = true,
            .raw_policy_enabled = true, .raw_active = true, .queue_known = true, .rate_known = true,
            .history_known = true, .last_window_known = true, .tf_mounted = true,
            .history_slices = 300, .history_ms = 600000, .windows = 3, .confirmed_windows = 2,
            .current_pending = 1, .historical_pending = 1, .last_window_reports = 6326,
            .last_window_drops = 0, .raw_queue_used = 4, .raw_queue_capacity = 64};
        raw_display_snapshot_t s = {.received = 126480, .written = 126450, .synced = 126400, .dropped = 6,
            .reports_per_second = 128, .free_bytes = 28200000000ULL, .total_bytes = 32000000000ULL, .free_known = true,
            .internal_free = 248000, .internal_total = 400000, .memory_known = true, .psram_free = 6240000, .psram_total = 8000000, .psram_known = true,
            .buffer_used = 4, .buffer_capacity = 12, .battery_known = true, .battery_mv = 3800,
            .battery_percent = 66, .wifi_enabled = true, .wifi_connected = true, .clock_known = true, .clock_calibrated = true, .utc_epoch = 1793270000,
            .wifi_rssi_known = true, .wifi_rssi = -63, .rssi_known = true, .rssi_min = -88, .rssi_mean = -63, .rssi_max = -42, .rssi_samples = 6326};
        strcpy(s.wifi_ssid, "Test network"); strcpy(s.ip, "192.0.2.1");
        for (unsigned i = 0; i < 10; ++i) { s.rssi_bins[i] = -88 + i * 4; s.rssi_bin_known[i] = true; }
        for (unsigned i = 0; i < 10; ++i) s.report_bins[i] = (uint32_t[]) {40,55,80,128,100,80,70,55,75,95}[i];
        const char *name = (const char *[]) {"normal", "unknown", "large", "error", "waiting", "starting", "stopping", "safe", "raw-disabled", "known-zero", "safe-error"}[variant];
        if (variant == 1) { m = (edge_ui_metrics_t) {.phase = EDGE_UI_PAUSED}; s = (raw_display_snapshot_t) {0}; }
        if (variant == 2) {
            m.windows = m.confirmed_windows = m.current_pending = m.historical_pending = m.upload_failures = m.retries = UINT32_MAX;
            m.last_window_reports = m.last_window_drops = UINT64_MAX;
            m.history_slices = UINT16_MAX; m.history_ms = UINT32_MAX;
            s.received = s.written = s.synced = s.dropped = s.free_bytes = UINT64_MAX;
            s.reports_per_second = s.internal_free = s.psram_free = s.storage_errors = s.buffer_used = s.buffer_capacity = UINT32_MAX;
            s.battery_mv = 4500; s.battery_percent = 100;
            for (unsigned i = 0; i < 10; ++i) s.report_bins[i] = UINT32_MAX;
        }
        if (variant == 3) { m.phase = EDGE_UI_ERROR; m.raw_fault = m.storage_fault = true; m.raw_active = false; s.storage_errors = 42; }
        if (variant == 4) { m = (edge_ui_metrics_t) {.phase = EDGE_UI_WAIT_USB}; s = (raw_display_snapshot_t) {0}; }
        if (variant == 5) { m = (edge_ui_metrics_t) {.phase = EDGE_UI_STARTING}; s = (raw_display_snapshot_t) {0}; }
        if (variant == 6) { m.phase = EDGE_UI_STOPPING; m.raw_active = false; }
        if (variant == 7) { m.phase = EDGE_UI_STOPPED_SAFE; m.raw_active = m.tf_mounted = false; }
        if (variant == 8) { m.raw_policy_enabled = m.raw_active = false; s.written = s.synced = 0; }
        if (variant == 9) { s.received = s.dropped = s.written = s.synced = s.reports_per_second = 0; memset(s.report_bins, 0, sizeof s.report_bins); }
        if (variant == 10) { m.phase = EDGE_UI_ERROR; m.raw_active = m.tf_mounted = false; m.raw_fault = m.storage_fault = true; s.setup_available = true; s.storage_errors = 42; }
        edge_ui_state(&m);
        for (unsigned page = 0; page < 5; ++page) {
            s.page = page; char filename[64]; snprintf(filename, sizeof filename, "%s-page-%u", name, page + 1);
            if (render(d, &s, argv[1], filename)) return 1;
            lv_obj_t *screen = lv_display_get_screen_active(d);
            if (page == 0 && !has_label(screen, "ETA -- 待标定")) return 1;
            if (page == 0 && variant == 7 && !has_label(screen, "TF 未挂载")) return 1;
            if (page == 0 && !has_label(screen, "设备诊断")) return 1;
            if (page == 1 && (!has_label(screen, "上一窗接收") || !has_label(screen, "已确认窗") || !has_label(screen, "接收趋势"))) return 1;
            if (page == 2 && (!has_label(screen, "车辆候选 / 未分析") || !has_label(screen, "品牌名称  --"))) return 1;
            if (page == 2 && variant == 8 && (!has_label(screen, "当前仅采集V3统计") || !has_label(screen, "本地原始记录已关闭"))) return 1;
            if (page == 3 && (!has_label(screen, "候梯估计未启用") || !has_label(screen, "近10窗RSSI/dBm"))) return 1;
            if (page == 4 && variant == 4 && !has_label(screen, "等待电脑配置")) return 1;
            if (page == 4 && variant == 7 && !has_label(screen, "需重启后重新配置")) return 1;
            if (page == 1 && variant == 1 && !has_label(screen, "--")) return 1;
            if (page == 1 && variant == 7 && !has_label(screen, "--")) return 1;
            if (page == 1 && variant == 9 && !has_label(screen, "0")) return 1;
            if (page == 4 && variant == 10 &&
                (!has_label(screen, "错误") || !has_label(screen, "启动或运行错误") ||
                 !has_label(screen, "已安全停止") || !has_label(screen, "需重启后重新配置") ||
                 !has_label(screen, "可安全关机") || !has_label(screen, "请连接电脑查看诊断") ||
                 has_label(screen, "请保持供电") || has_label(screen, "不能确认安全停止"))) return 1;
            if (page == 4 && variant == 3 && (!has_label(screen, "请保持供电") || has_label(screen, "可安全关机"))) return 1;
            raw_ui_update(&s); check_layout(screen);
        }
        /* Mutating the source after publishing must not alter the copied view. */
        m.phase = EDGE_UI_ERROR; s.page = 4; raw_ui_update(&s);
        if (variant == 4 && !has_label(lv_display_get_screen_active(d), "等待电脑配置")) return 1;
    }
    return 0;
}
