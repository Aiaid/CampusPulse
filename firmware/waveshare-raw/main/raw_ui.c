#include "raw_ui.h"
#include "raw_fonts.h"
#include <inttypes.h>
#include <stdio.h>
#include <string.h>
#include <time.h>

/* Only the display owner calls this module. No timer, animation or I/O is used. */
static lv_obj_t *s_screen, *s_status, *s_labels[20], *s_bars[10];
static lv_obj_t *s_usage[4], *s_unknown[4], *s_rssi_lines[9];
static lv_point_precise_t s_points[9][2];
static unsigned s_page = 99;
static unsigned s_pages;

static lv_obj_t *label(int x, int y, int width, const lv_font_t *font, const char *text) {
    lv_obj_t *o = lv_label_create(s_screen);
    lv_obj_set_pos(o, x, y); lv_obj_set_width(o, width);
    lv_obj_set_style_text_font(o, font, 0);
    lv_obj_set_style_text_color(o, lv_color_black(), 0);
    lv_label_set_long_mode(o, LV_LABEL_LONG_MODE_CLIP);
    lv_label_set_text(o, text); return o;
}
static lv_obj_t *center(int y, const lv_font_t *font, const char *text) {
    lv_obj_t *o = label(5, y, 190, font, text);
    lv_obj_set_style_text_align(o, LV_TEXT_ALIGN_CENTER, 0); return o;
}
static lv_obj_t *box(int x, int y, int w, int h, bool fill) {
    lv_obj_t *o = lv_obj_create(s_screen); lv_obj_remove_style_all(o);
    lv_obj_set_pos(o, x, y); lv_obj_set_size(o, w, h);
    lv_obj_remove_flag(o, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_set_style_bg_color(o, fill ? lv_color_black() : lv_color_white(), 0);
    lv_obj_set_style_bg_opa(o, LV_OPA_COVER, 0);
    if (!fill) {lv_obj_set_style_border_width(o, 1, 0); lv_obj_set_style_border_color(o, lv_color_black(), 0);}
    return o;
}
static void rule(int y) { box(5, y, 190, 1, true); }
static void count(char *out, size_t n, uint64_t v) {
    if (v < 1000000) {snprintf(out, n, "%" PRIu64, v); return;}
    const char *units[] = {"", "k", "M", "G", "T", "P", "E"};
    uint64_t scale = 1; unsigned unit = 0;
    while (unit < 6 && v / scale >= 1000) {scale *= 1000; unit++;}
    /* Integer formatting avoids float support and uint64 overflow. */
    snprintf(out, n, "%" PRIu64 ".%u%s", v / scale,
             (unsigned)((v % scale) * 10 / scale), units[unit]);
}
static void bytes(char *out, size_t n, uint64_t v) {
    uint64_t scale = 1; unsigned unit = 0; const char *u[] = {"B","KiB","MiB","GiB","TiB","PiB","EiB"};
    while (unit < 6 && v / scale >= 1024) {scale *= 1024; unit++;}
    if (!unit) snprintf(out, n, "%" PRIu64 "B", v);
    else snprintf(out, n, "%" PRIu64 ".%u%s", v / scale,
                  (unsigned)((v % scale) * 10 / scale), u[unit]);
}
static void fit(lv_obj_t *o, const char *text) {
    char safe[128]; snprintf(safe, sizeof(safe), "%s", text);
    lv_point_t size; const lv_font_t *f = lv_obj_get_style_text_font(o, 0);
    for (;;) {
        lv_text_get_size(&size, safe, f, 0, 0, 10000, LV_TEXT_FLAG_NONE);
        if (size.x <= lv_obj_get_width(o)) break;
        size_t n = strlen(safe); if (n < 4) break;
        /* Remove a UTF-8 code point, then add an ASCII ellipsis. */
        if (n >= 3 && !strcmp(safe + n - 3, "...")) n -= 3;
        if (!n) break;
        n--; while (n && ((unsigned char)safe[n] & 0xc0) == 0x80) n--;
        strcpy(safe + n, "...");
    }
    lv_label_set_text(o, safe);
}
static void usage(unsigned i, int x, int y, int width) {
    s_unknown[i] = box(x, y, width, 6, false);
    s_usage[i] = box(x + 1, y + 1, width - 2, 4, true);

}
static void set_usage(unsigned i, int width, uint64_t used, uint64_t total, bool known) {
    known = known && total != 0;
    lv_obj_set_flag(s_usage[i], LV_OBJ_FLAG_HIDDEN, !known || !used);
    lv_obj_set_flag(s_unknown[i], LV_OBJ_FLAG_HIDDEN, !known);
    if (known) {
        if (used > total) used = total;
        /* Avoid multiplication overflow for uint64 storage sizes. */
        unsigned percent = (unsigned)((long double)used * 100 / total);
        lv_obj_set_width(s_usage[i], (width - 2) * percent / 100 ?: 1);
    }
}
static void percent(char *out, size_t n, const char *name, uint64_t used, uint64_t total, bool known) {
    if (!known || !total) snprintf(out, n, "%s --", name);
    else snprintf(out, n, "%s %u%%", name, (unsigned)((long double)(used > total ? total : used) * 100 / total));
}
static const char *state_text(const char *state) {
    if (!strcmp(state, "POWER OFF")) return "已关机";
    if (strstr(state, "ERROR")) return strstr(state, "STORAGE") || strstr(state, "CARD ERROR") ? "存储错误" : "错误";
    if (strstr(state, "FULL")) return "存储错误";
    if (strstr(state, "STOPPING")) return "停止中";
    if (strstr(state, "SAFE")) return "可移除";
    if (!strncmp(state, "RECORD", 6)) return "记录中";
    if (!strncmp(state, "STOP", 4)) return "已停止";
    return "启动中";
}

static void build(unsigned page, unsigned pages) {
    lv_obj_clean(s_screen); memset(s_labels, 0, sizeof(s_labels));
    const char *titles[] = {"设备诊断", "BLE活动", "车辆线索", "候梯观测", "USB"};
    label(5, 2, 80, &raw_font_16, titles[page]);
    char t[8]; snprintf(t, sizeof(t), "%u/%u", page + 1, pages);
    label(88, 4, 30, &raw_font_12, t);
    s_status = label(123, 3, 72, &raw_font_12, "启动中");
    lv_obj_set_style_bg_color(s_status, lv_color_black(), 0);
    lv_obj_set_style_bg_opa(s_status, LV_OPA_COVER, 0);
    lv_obj_set_style_text_color(s_status, lv_color_white(), 0);
    lv_obj_set_style_text_align(s_status, LV_TEXT_ALIGN_CENTER, 0);
    rule(23); rule(183);
    for (unsigned i = 0; i < pages; i++) {
        lv_obj_t *dot = box(9 + i * (pages == 5 ? 11 : 13), 190, 6, 6, i == page);
        lv_obj_set_style_radius(dot, LV_RADIUS_CIRCLE, 0);
    }
    if (page == 0) label(65, 184, 130, &raw_font_12, "BOOT | USB/CHG ?");
    else label(90, 184, 105, &raw_font_12, "BOOT 切页");
    if (page == 0) {
        s_labels[0] = label(5, 26, 190, &raw_font_14, "Wi-Fi 关闭");
        s_labels[1] = label(5, 43, 111, &raw_font_12, "SSID --");
        s_labels[2] = label(120, 43, 75, &raw_font_12, "RSSI --");
        s_labels[3] = label(5, 59, 80, &raw_font_12, "IP --");
        s_labels[12] = label(90, 59, 105, &raw_font_12, "时间 --");
        s_labels[4] = label(5, 75, 92, &raw_font_12, "RAM --");
        s_labels[5] = label(104, 75, 91, &raw_font_12, "PSRAM --");
        usage(0, 5, 94, 92); usage(1, 104, 94, 91);
        s_labels[6] = label(5, 100, 190, &raw_font_12, "TF已用 --"); usage(2, 5, 118, 190);
        s_labels[7] = label(5, 124, 190, &raw_font_12, "接收缓冲 --"); usage(3, 5, 142, 190);
        s_labels[8] = label(5, 150, 115, &raw_font_12, "BAT --");
        s_labels[9] = label(122, 150, 73, &raw_font_12, "估计 --");
        s_labels[10] = label(5, 166, 120, &raw_font_12, "ETA --");
        s_labels[11] = label(127, 166, 68, &raw_font_12, "错误 --");
    } else if (page == 1) {
        s_labels[0] = center(27, &lv_font_montserrat_28, "0");
        center(60, &raw_font_14, "包/秒");
        for (unsigned i = 0; i < 10; i++) s_bars[i] = box(7 + i * 19, 109, 15, 1, true);
        rule(110); label(5, 112, 90, &raw_font_12, "60秒前");
        lv_obj_t *o = label(150, 112, 45, &raw_font_12, "现在"); lv_obj_set_style_text_align(o, LV_TEXT_ALIGN_RIGHT, 0);
        rule(129); label(5, 132, 92, &raw_font_12, "近60秒接收"); label(104, 132, 91, &raw_font_12, "近60秒写入");
        s_labels[1] = label(5, 148, 92, &raw_font_16, "0"); s_labels[2] = label(104, 148, 91, &raw_font_16, "0");
        s_labels[3] = label(5, 168, 190, &raw_font_12, "软件丢包 0");
    } else if (page == 2) {
        center(27, &lv_font_montserrat_28, "--"); center(58, &raw_font_14, "车辆候选 / 未分析");
        center(77, &raw_font_12, "当前仅记录原始广播"); rule(95);
        label(5, 99, 190, &raw_font_12, "品牌名称  --"); label(5, 115, 190, &raw_font_12, "厂商线索  --");
        label(5, 131, 190, &raw_font_12, "排除项    --"); label(5, 147, 190, &raw_font_12, "已解析    --");
        rule(163); s_labels[0] = label(5, 166, 190, &raw_font_14, "已保存 0 条");
    } else if (page == 3) {
        label(57, 29, 50, &lv_font_montserrat_28, "--");
        label(111, 35, 45, &raw_font_14, "分钟");
        center(60, &raw_font_14, "候梯估计未启用"); rule(81);
        for (unsigned i = 0; i < 3; i++) {
            s_labels[i] = label(5 + i * 65, 86, 60, &raw_font_16, "--");
            lv_obj_set_style_text_align(s_labels[i], LV_TEXT_ALIGN_CENTER, 0);
            lv_obj_t *o = label(5 + i * 65, 106, 60, &raw_font_12, (const char *[]) {"最弱","平均","最强"}[i]);
            lv_obj_set_style_text_align(o, LV_TEXT_ALIGN_CENTER, 0);
        }
        label(5, 122, 130, &raw_font_12, "近60秒RSSI/dBm");
        box(5, 138, 190, 28, false);
        rule(166);
        for (unsigned i = 0; i < 9; i++) {
            s_rssi_lines[i] = lv_line_create(s_screen);
            lv_obj_set_pos(s_rssi_lines[i], 8, 139);
            lv_obj_set_style_line_width(s_rssi_lines[i], 2, 0);
            lv_obj_set_style_line_color(s_rssi_lines[i], lv_color_black(), 0);
            lv_line_set_points(s_rssi_lines[i], s_points[i], 2);
        }
        s_labels[3] = label(5, 168, 100, &raw_font_12, "样本 0");
        s_labels[5] = label(108, 168, 87, &raw_font_12, "UTC未校准");
        s_labels[4] = label(150, 122, 45, &raw_font_12, "--");
    } else {
        center(31, &raw_font_16, "USB provisioning");
        s_labels[0] = center(62, &raw_font_12, "Hold BOOT 2s to enter");
        s_labels[1] = center(88, &raw_font_12, "Use the computer USB wizard");
        s_labels[2] = center(112, &raw_font_12, "");
        s_labels[3] = center(138, &raw_font_12, "");
        s_labels[4] = center(163, &raw_font_12, "BAT --");
    }
}
void raw_ui_init(lv_display_t *display) {
    s_screen = lv_display_get_screen_active(display); s_page = 99;
    lv_obj_set_style_bg_color(s_screen, lv_color_white(), 0);
    lv_obj_set_style_bg_opa(s_screen, LV_OPA_COVER, 0);
    lv_obj_set_style_pad_all(s_screen, 0, 0); lv_obj_remove_flag(s_screen, LV_OBJ_FLAG_SCROLLABLE);
}
void raw_ui_update(const raw_display_snapshot_t *s) {
    unsigned pages = s->setup_available ? 5 : 4;
    unsigned page = s->page % pages;
    if (page != s_page || pages != s_pages) {build(page, pages); lv_obj_update_layout(s_screen); s_page = page; s_pages = pages;}
    char state[sizeof(s->state) + 1]; memcpy(state, s->state, sizeof(s->state)); state[sizeof(s->state)] = 0;
    lv_label_set_text(s_status, state_text(state));
    char t[128], n[32];
    if (page == 0) {
        lv_label_set_text(s_labels[0], !s->wifi_enabled ? "Wi-Fi 关闭" :
            s->setup_available && s->setup_state == RAW_SETUP_TESTING ? "Wi-Fi testing" :
            s->wifi_connected ? "Wi-Fi 已连接" : "Wi-Fi 未连接");
        snprintf(t, sizeof(t), "SSID %.*s", (int)sizeof(s->wifi_ssid), s->wifi_connected && s->wifi_ssid[0] ? s->wifi_ssid : "--"); fit(s_labels[1], t);
        if (s->wifi_connected && s->wifi_rssi_known) snprintf(t, sizeof(t), "RSSI %d", s->wifi_rssi); else strcpy(t, "RSSI --"); fit(s_labels[2], t);
        snprintf(t, sizeof(t), "IP %.*s", (int)sizeof(s->ip), s->wifi_connected && s->ip[0] ? s->ip : "--"); fit(s_labels[3], t);
        if (s->clock_known) {
            time_t local = (time_t)(s->utc_epoch + 8u * 3600u);
            struct tm date;
            gmtime_r(&local, &date);
            strftime(t, sizeof t, "%m-%d %H:%M:%S", &date);
        } else strcpy(t, "时间 --");
        fit(s_labels[12], t);
        uint32_t ram_used = s->internal_total > s->internal_free ? s->internal_total - s->internal_free : 0;
        uint32_t psram_used = s->psram_total > s->psram_free ? s->psram_total - s->psram_free : 0;
        percent(t, sizeof(t), "RAM", ram_used, s->internal_total, s->memory_known); fit(s_labels[4], t);
        percent(t, sizeof(t), "PSRAM", psram_used, s->psram_total, s->psram_known); fit(s_labels[5], t);
        set_usage(0, 92, ram_used, s->internal_total, s->memory_known); set_usage(1, 91, psram_used, s->psram_total, s->psram_known);
        uint64_t used = s->total_bytes > s->free_bytes ? s->total_bytes - s->free_bytes : 0;
        if (s->free_known) bytes(n, sizeof(n), s->free_bytes); else strcpy(n, "--");
        char used_percent[32]; percent(used_percent, sizeof used_percent, "TF", used, s->total_bytes, s->free_known);
        snprintf(t, sizeof t, "%s / free %s", used_percent, n); fit(s_labels[6], t);
        set_usage(2, 190, used, s->total_bytes, s->free_known);
        char buffer_percent[48]; percent(buffer_percent, sizeof buffer_percent, "接收缓冲", s->buffer_used, s->buffer_capacity, s->buffer_capacity != 0);
        count(n, sizeof n, s->uptime_s);
        snprintf(t, sizeof t, "%s / up %ss", buffer_percent, n); fit(s_labels[7], t);
        set_usage(3, 190, s->buffer_used, s->buffer_capacity, s->buffer_capacity != 0);
        bool battery_known = s->battery_known && s->battery_mv >= 2600 && s->battery_mv <= 4500;
        if (battery_known)
            snprintf(t, sizeof t, "BAT %u.%03uV", s->battery_mv / 1000u, s->battery_mv % 1000u);
        else strcpy(t, "BAT --");
        fit(s_labels[8], t);
        if (battery_known && s->battery_percent >= 0 && s->battery_percent <= 100)
            snprintf(t, sizeof(t), "估计 %d%%", s->battery_percent);
        else strcpy(t, "估计 --");
        fit(s_labels[9], t);
        /* No capacity, calibrated load model, charge/current or source signal.
         * A voltage slope cannot establish remaining discharge runtime. */
        fit(s_labels[10], "ETA --");
        count(n, sizeof(n), s->storage_errors); snprintf(t, sizeof(t), "错误 %s", n); fit(s_labels[11], t);
    } else if (page == 1) {
        snprintf(t, sizeof(t), "%" PRIu32, s->reports_per_second); fit(s_labels[0], t);
        count(t, sizeof(t), s->recent_received); fit(s_labels[1], t); count(t, sizeof(t), s->recent_written); fit(s_labels[2], t);
        count(n, sizeof(n), s->dropped); snprintf(t, sizeof(t), "软件丢包 %s", n); fit(s_labels[3], t);
        uint32_t maximum = 1; for (unsigned i = 0; i < 10; i++) if (s->report_bins[i] > maximum) maximum = s->report_bins[i];
        for (unsigned i = 0; i < 10; i++) {
            unsigned h = (uint64_t)s->report_bins[i] * 30 / maximum;
            lv_obj_set_flag(s_bars[i], LV_OBJ_FLAG_HIDDEN, s->report_bins[i] == 0);
            lv_obj_set_height(s_bars[i], h ? h : 1); lv_obj_set_y(s_bars[i], 110 - (h ? h : 1));
        }
    } else if (page == 2) {
        count(n, sizeof(n), s->synced); snprintf(t, sizeof(t), "已保存 %s 条", n); fit(s_labels[0], t);
    } else if (page == 3) {
        lv_label_set_text(s_labels[5], s->clock_known ? (s->clock_calibrated ? "UTC已校准" : "RTC时间") : "UTC未校准");
        const int values[] = {s->rssi_min, s->rssi_mean, s->rssi_max};
        for (unsigned i = 0; i < 3; i++) {if (s->rssi_known) snprintf(t, sizeof(t), "%d", values[i]); else strcpy(t, "--"); fit(s_labels[i], t);}
        count(n, sizeof(n), s->rssi_samples); snprintf(t, sizeof(t), "样本 %s", n); fit(s_labels[3], t);
        bool any = false;
        for (unsigned i = 0; i < 9; i++) {
            bool known = s->rssi_bin_known[i] && s->rssi_bin_known[i + 1]; any |= known;
            lv_obj_set_flag(s_rssi_lines[i], LV_OBJ_FLAG_HIDDEN, !known);
            for (unsigned j = 0; j < 2; j++) {
                int value = s->rssi_bins[i + j]; if (value < -100) value = -100; if (value > -20) value = -20;
                s_points[i][j].x = (i + j) * 20; s_points[i][j].y = (-20 - value) * 25 / 80;
            }
            lv_line_set_points(s_rssi_lines[i], s_points[i], 2); lv_obj_invalidate(s_rssi_lines[i]);
        }
        lv_label_set_text(s_labels[4], any ? "" : "--");
    } else {
        const char *phase = "Hold BOOT 2s to enter", *help = "Use the computer USB wizard", *detail = "";
        if (s->setup_stopping) { phase = "Stopping raw recording..."; help = "Draining and syncing TF"; detail = "Keep power connected"; }
        else switch (s->setup_state) {
        case RAW_SETUP_ENTERING: phase = "Opening USB setup..."; help = "Raw recording is stopped"; break;
        case RAW_SETUP_READY: phase = "Waiting for credentials"; help = "Connect USB to computer"; detail = "Open the existing setup wizard"; break;
        case RAW_SETUP_AWAIT_REPLY: phase = "Credentials received"; help = "Finishing USB response..."; break;
        case RAW_SETUP_TESTING: phase = "Testing Wi-Fi and cloud"; help = "Keep power connected"; break;
        case RAW_SETUP_SAVING: phase = "Saving local settings..."; help = "Keep power connected"; break;
        case RAW_SETUP_SAVED: phase = "Local settings saved"; help = "Restart to record again"; detail = "Raw recording stays stopped"; break;
        case RAW_SETUP_FAILED: phase = "Setup failed"; help = "Hold BOOT 2s to retry"; break;
        case RAW_SETUP_FAULT: phase = "Setup handoff failed"; help = "Restart before retrying"; break;
        case RAW_SETUP_CANCELLING: phase = "Closing USB setup..."; help = "Keep power connected"; break;
        default: break;
        }
        fit(s_status, "USB"); fit(s_labels[0], phase); fit(s_labels[1], help); fit(s_labels[2], detail);
        if (s->setup_error) snprintf(t, sizeof t, "Error 0x%lx", (unsigned long)(uint32_t)s->setup_error);
        else strcpy(t, "Short BOOT: change page");
        fit(s_labels[3], t);
        if (s->battery_known && s->battery_mv >= 2600 && s->battery_mv <= 4500)
            snprintf(t, sizeof t, "BAT %u.%03uV", s->battery_mv / 1000u, s->battery_mv % 1000u);
        else strcpy(t, "BAT --");
        fit(s_labels[4], t);
    }
}
