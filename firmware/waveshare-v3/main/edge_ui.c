#include "raw_ui.h"
#include "edge_fonts.h"
#include "edge_ui.h"
#include <inttypes.h>
#include <stdio.h>
#include <string.h>
#include <time.h>

#ifdef ESP_PLATFORM
#include "freertos/FreeRTOS.h"
static portMUX_TYPE state_lock = portMUX_INITIALIZER_UNLOCKED;
#define STATE_LOCK() portENTER_CRITICAL(&state_lock)
#define STATE_UNLOCK() portEXIT_CRITICAL(&state_lock)
#else
#include <stdatomic.h>
static atomic_flag state_lock = ATOMIC_FLAG_INIT;
#define STATE_LOCK() while (atomic_flag_test_and_set(&state_lock)) {}
#define STATE_UNLOCK() atomic_flag_clear(&state_lock)
#endif

/* Only the display owner touches LVGL; geometry restores the raw UI. */
static edge_ui_metrics_t state;
void edge_ui_state(const edge_ui_metrics_t *metrics) {
    if (!metrics) return;
    STATE_LOCK(); state = *metrics; STATE_UNLOCK();
}

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
static const char *phase_text(edge_ui_phase_t phase) {
    switch (phase) {
    case EDGE_UI_WAIT_USB: return "等待电脑";
    case EDGE_UI_STARTING: return "启动中";
    case EDGE_UI_COLLECTING: return "采集中";
    case EDGE_UI_PAUSED: return "已暂停";
    case EDGE_UI_STOPPING: return "停止中";
    case EDGE_UI_STOPPED_SAFE: return "安全停止";
    default: return "错误";
    }
}

static void build(unsigned page, unsigned pages) {
    lv_obj_clean(s_screen); memset(s_labels, 0, sizeof(s_labels));
    const char *titles[] = {"设备诊断", "BLE活动", "车辆线索", "候梯观测", "USB"};
    label(5, 2, 80, &edge_font_16, titles[page]);
    char t[8]; snprintf(t, sizeof(t), "%u/%u", page + 1, pages);
    label(88, 4, 30, &edge_font_12, t);
    s_status = label(123, 3, 72, &edge_font_12, "启动中");
    lv_obj_set_style_bg_color(s_status, lv_color_black(), 0);
    lv_obj_set_style_bg_opa(s_status, LV_OPA_COVER, 0);
    lv_obj_set_style_text_color(s_status, lv_color_white(), 0);
    lv_obj_set_style_text_align(s_status, LV_TEXT_ALIGN_CENTER, 0);
    rule(23); rule(183);
    for (unsigned i = 0; i < pages; i++) {
        lv_obj_t *dot = box(9 + i * (pages == 5 ? 11 : 13), 190, 6, 6, i == page);
        lv_obj_set_style_radius(dot, LV_RADIUS_CIRCLE, 0);
    }
    if (page == 0) label(65, 184, 130, &edge_font_12, "BOOT | USB/CHG ?");
    else label(90, 184, 105, &edge_font_12, "BOOT 切页");
    if (page == 0) {
        s_labels[0] = label(5, 26, 190, &edge_font_14, "Wi-Fi 关闭");
        s_labels[1] = label(5, 43, 111, &edge_font_12, "SSID --");
        s_labels[2] = label(120, 43, 75, &edge_font_12, "RSSI --");
        s_labels[3] = label(5, 59, 80, &edge_font_12, "IP --");
        s_labels[12] = label(90, 59, 105, &edge_font_12, "时间 --");
        s_labels[4] = label(5, 75, 92, &edge_font_12, "RAM --");
        s_labels[5] = label(104, 75, 91, &edge_font_12, "PSRAM --");
        usage(0, 5, 94, 92); usage(1, 104, 94, 91);
        s_labels[6] = label(5, 100, 190, &edge_font_12, "TF已用 --"); usage(2, 5, 118, 190);
        s_labels[7] = label(5, 124, 190, &edge_font_12, "接收缓冲 --"); usage(3, 5, 142, 190);
        s_labels[8] = label(5, 150, 115, &edge_font_12, "BAT --");
        s_labels[9] = label(122, 150, 73, &edge_font_12, "估计 --");
        s_labels[10] = label(5, 166, 120, &edge_font_12, "ETA --");
        s_labels[11] = label(127, 166, 68, &edge_font_12, "错误 --");
    } else if (page == 1) {
        s_labels[0] = center(27, &lv_font_montserrat_28, "--");
        center(60, &edge_font_14, "包/秒");
        for (unsigned i = 0; i < 10; i++) s_bars[i] = box(7 + i * 19, 109, 15, 1, true);
        rule(110); label(5, 112, 90, &edge_font_12, "接收趋势");
        lv_obj_t *o = label(150, 112, 45, &edge_font_12, "现在"); lv_obj_set_style_text_align(o, LV_TEXT_ALIGN_RIGHT, 0);
        rule(129); label(5, 132, 92, &edge_font_12, "上一窗接收"); label(104, 132, 91, &edge_font_12, "已确认窗");
        s_labels[1] = label(5, 148, 92, &edge_font_16, "0"); s_labels[2] = label(104, 148, 91, &edge_font_16, "0");
        s_labels[3] = label(5, 168, 190, &edge_font_12, "软件丢包 0");
    } else if (page == 2) {
        center(27, &lv_font_montserrat_28, "--"); center(58, &edge_font_14, "车辆候选 / 未分析");
        s_labels[1] = center(77, &edge_font_12, "当前仅采集V3统计"); rule(95);
        label(5, 99, 190, &edge_font_12, "品牌名称  --"); label(5, 115, 190, &edge_font_12, "厂商线索  --");
        label(5, 131, 190, &edge_font_12, "排除项    --"); label(5, 147, 190, &edge_font_12, "已解析    --");
        rule(163); s_labels[0] = label(5, 166, 190, &edge_font_14, "已保存 0 条");
    } else if (page == 3) {
        label(57, 29, 50, &lv_font_montserrat_28, "--");
        label(111, 35, 45, &edge_font_14, "分钟");
        center(60, &edge_font_14, "候梯估计未启用"); rule(81);
        for (unsigned i = 0; i < 3; i++) {
            s_labels[i] = label(5 + i * 65, 86, 60, &edge_font_16, "--");
            lv_obj_set_style_text_align(s_labels[i], LV_TEXT_ALIGN_CENTER, 0);
            lv_obj_t *o = label(5 + i * 65, 106, 60, &edge_font_12, (const char *[]) {"最弱","平均","最强"}[i]);
            lv_obj_set_style_text_align(o, LV_TEXT_ALIGN_CENTER, 0);
        }
        label(5, 122, 130, &edge_font_12, "近10窗RSSI/dBm");
        box(5, 138, 190, 28, false);
        rule(166);
        for (unsigned i = 0; i < 9; i++) {
            s_rssi_lines[i] = lv_line_create(s_screen);
            lv_obj_set_pos(s_rssi_lines[i], 8, 139);
            lv_obj_set_style_line_width(s_rssi_lines[i], 2, 0);
            lv_obj_set_style_line_color(s_rssi_lines[i], lv_color_black(), 0);
            lv_line_set_points(s_rssi_lines[i], s_points[i], 2);
        }
        s_labels[3] = label(5, 168, 100, &edge_font_12, "样本 0");
        s_labels[5] = label(108, 168, 87, &edge_font_12, "UTC未校准");
        s_labels[4] = label(150, 122, 45, &edge_font_12, "--");
    } else {
        s_labels[5] = center(31, &edge_font_16, "USB调试配置");
        s_labels[0] = center(62, &edge_font_12, "--");
        s_labels[1] = center(88, &edge_font_12, "--");
        s_labels[2] = center(112, &edge_font_12, "");
        s_labels[3] = center(138, &edge_font_12, "");
        s_labels[4] = center(163, &edge_font_12, "BAT --");
    }
}
void raw_ui_init(lv_display_t *display) {
    s_screen = lv_display_get_screen_active(display); s_page = 99;
    lv_obj_set_style_bg_color(s_screen, lv_color_white(), 0);
    lv_obj_set_style_bg_opa(s_screen, LV_OPA_COVER, 0);
    lv_obj_set_style_pad_all(s_screen, 0, 0); lv_obj_remove_flag(s_screen, LV_OBJ_FLAG_SCROLLABLE);
}
void raw_ui_update(const raw_display_snapshot_t *s) {
    edge_ui_metrics_t m; STATE_LOCK(); m = state; STATE_UNLOCK();
    unsigned pages = s->setup_available || s->setup_stopping || m.phase == EDGE_UI_WAIT_USB || s->page == 4 ? 5 : 4;
    unsigned page = s->page < 5 ? s->page : 0;
    if (page != s_page || pages != s_pages) {build(page, pages); lv_obj_update_layout(s_screen); s_page = page; s_pages = pages;}
    lv_label_set_text(s_status, phase_text(m.phase));
    char t[128], n[32], a[32], b[32];
    if (page == 0) {
        snprintf(t,sizeof t,"%s%s",m.transport_known?(m.mqtt_tls?"MQTT ":"HTTPS "):"",!s->wifi_enabled?"Wi-Fi 关闭":s->wifi_connected?"Wi-Fi 已连接":"Wi-Fi 未连接");
        fit(s_labels[0],t);
        snprintf(t, sizeof t, "SSID %.*s", (int)sizeof s->wifi_ssid, s->wifi_connected && s->wifi_ssid[0] ? s->wifi_ssid : "--"); fit(s_labels[1], t);
        if (s->wifi_connected && s->wifi_rssi_known) snprintf(t, sizeof t, "RSSI %d", s->wifi_rssi); else strcpy(t, "RSSI --"); fit(s_labels[2], t);
        snprintf(t, sizeof t, "IP %.*s", (int)sizeof s->ip, s->wifi_connected && s->ip[0] ? s->ip : "--"); fit(s_labels[3], t);
        if (s->clock_known) {
            time_t local = (time_t)(s->utc_epoch + 8u * 3600u); struct tm date;
            if (gmtime_r(&local, &date)) strftime(t, sizeof t, "%m-%d %H:%M:%S", &date); else strcpy(t, "时间 --");
        } else strcpy(t, "时间 --");
        fit(s_labels[12], t);
        uint32_t ram_used = s->internal_total > s->internal_free ? s->internal_total - s->internal_free : 0;
        uint32_t psram_used = s->psram_total > s->psram_free ? s->psram_total - s->psram_free : 0;
        percent(t, sizeof t, "RAM", ram_used, s->internal_total, s->memory_known); fit(s_labels[4], t);
        percent(t, sizeof t, "PSRAM", psram_used, s->psram_total, s->psram_known); fit(s_labels[5], t);
        set_usage(0, 92, ram_used, s->internal_total, s->memory_known); set_usage(1, 91, psram_used, s->psram_total, s->psram_known);
        uint64_t used = s->total_bytes > s->free_bytes ? s->total_bytes - s->free_bytes : 0;
        if (m.storage_fault) strcpy(t, "TF 存储错误");
        else if (!m.tf_mounted) strcpy(t, "TF 未挂载");
        else {
            if (s->free_known) bytes(n, sizeof n, s->free_bytes); else strcpy(n, "--");
            percent(a, sizeof a, "TF", used, s->total_bytes, s->free_known);
            snprintf(t, sizeof t, "%s / free %s", a, n);
        }
        fit(s_labels[6], t); set_usage(2, 190, used, s->total_bytes, m.tf_mounted && !m.storage_fault && s->free_known);
        bool queue = m.queue_known && s->buffer_capacity;
        if (queue) {
            unsigned percent_used = (unsigned)((uint64_t)(s->buffer_used > s->buffer_capacity ? s->buffer_capacity : s->buffer_used) * 100 / s->buffer_capacity);
            count(a, sizeof a, m.current_pending); count(b, sizeof b, m.historical_pending);
            snprintf(t, sizeof t, "队列 %u%% 当前%s/历史%s", percent_used, a, b);
        } else strcpy(t, "上传队列 --");
        fit(s_labels[7], t); set_usage(3, 190, s->buffer_used, s->buffer_capacity, queue);
        bool battery = s->battery_known && s->battery_mv >= 2600 && s->battery_mv <= 4500;
        if (battery) snprintf(t, sizeof t, "BAT %u.%03uV", s->battery_mv / 1000u, s->battery_mv % 1000u); else strcpy(t, "BAT --"); fit(s_labels[8], t);
        if (battery && s->battery_percent >= 0 && s->battery_percent <= 100) snprintf(t, sizeof t, "估计 %d%%", s->battery_percent); else strcpy(t, "估计 --"); fit(s_labels[9], t);
        fit(s_labels[10], "ETA -- 待标定");
        if (m.tf_mounted || m.raw_policy_enabled || m.storage_fault) count(n, sizeof n, s->storage_errors); else strcpy(n, "--");
        snprintf(t, sizeof t, "错误 %s", n); fit(s_labels[11], t);
    } else if (page == 1) {
        bool live = m.capture_known && m.rate_known && m.phase == EDGE_UI_COLLECTING;
        if (live) count(t, sizeof t, s->reports_per_second); else strcpy(t, "--"); fit(s_labels[0], t);
        if (m.last_window_known) count(t, sizeof t, m.last_window_reports); else strcpy(t, "--"); fit(s_labels[1], t);
        if (m.metrics_known) count(t, sizeof t, m.confirmed_windows); else strcpy(t, "--"); fit(s_labels[2], t);
        if (m.capture_known) count(n, sizeof n, s->dropped); else strcpy(n, "--");
        snprintf(t, sizeof t, "软件丢包 %s", n); fit(s_labels[3], t);
        uint32_t maximum = 1; for (unsigned i = 0; i < 10; ++i) if (s->report_bins[i] > maximum) maximum = s->report_bins[i];
        for (unsigned i = 0; i < 10; ++i) {
            unsigned height = (uint64_t)s->report_bins[i] * 30 / maximum;
            lv_obj_set_flag(s_bars[i], LV_OBJ_FLAG_HIDDEN, !live || !s->report_bins[i]);
            lv_obj_set_height(s_bars[i], height ? height : 1); lv_obj_set_y(s_bars[i], 110 - (height ? height : 1));
        }
    } else if (page == 2) {
        fit(s_labels[1], m.raw_policy_enabled ? "当前记录原始广播" : "当前仅采集V3统计");
        if (m.raw_policy_enabled) { count(n, sizeof n, s->synced); snprintf(t, sizeof t, "已保存 %s 条", n); }
        else strcpy(t, "本地原始记录已关闭");
        fit(s_labels[0], t);
    } else if (page == 3) {
        fit(s_labels[5], s->clock_known ? (s->clock_calibrated ? "UTC已校准" : "RTC时间") : "UTC未校准");
        const int values[] = {s->rssi_min, s->rssi_mean, s->rssi_max};
        for (unsigned i = 0; i < 3; ++i) { if (s->rssi_known) snprintf(t, sizeof t, "%d", values[i]); else strcpy(t, "--"); fit(s_labels[i], t); }
        if (s->rssi_known) count(n, sizeof n, s->rssi_samples); else strcpy(n, "--");
        snprintf(t, sizeof t, "样本 %s", n); fit(s_labels[3], t);
        bool any = false;
        for (unsigned i = 0; i < 9; ++i) {
            bool known = s->rssi_bin_known[i] && s->rssi_bin_known[i + 1]; any |= known;
            lv_obj_set_flag(s_rssi_lines[i], LV_OBJ_FLAG_HIDDEN, !known);
            for (unsigned j = 0; j < 2; ++j) {
                int value = s->rssi_bins[i + j]; if (value < -100) value = -100; if (value > -20) value = -20;
                s_points[i][j].x = (i + j) * 20; s_points[i][j].y = (-20 - value) * 25 / 80;
            }
            lv_line_set_points(s_rssi_lines[i], s_points[i], 2); lv_obj_invalidate(s_rssi_lines[i]);
        }
        fit(s_labels[4], any ? "" : "--");
    } else {
        const char *title, *help, *detail, *safety, *mode;
        switch (m.phase) {
        case EDGE_UI_WAIT_USB:
            title = "等待电脑配置"; help = "连接电脑USB调试口";
            detail = "每次开机配置网络和时间"; safety = "请使用V3调试工具"; mode = "配置完成后开始采集"; break;
        case EDGE_UI_STOPPING:
            title = "正在安全停止"; help = "正在排空队列并同步TF";
            detail = "请保持供电"; safety = "完成后才可关机或重启"; mode = "停止中不能重新配置"; break;
        case EDGE_UI_STOPPED_SAFE:
            title = "已安全停止"; help = "需重启后重新配置";
            detail = "停止后不自动恢复采集"; safety = "可安全关机"; mode = "重启后连接电脑USB"; break;
        case EDGE_UI_ERROR:
            title = "启动或运行错误";
            if (s->setup_available) {
                help = "已安全停止"; detail = "需重启后重新配置";
                safety = "可安全关机"; mode = "请连接电脑查看诊断";
            } else {
                help = "请连接电脑查看诊断"; detail = m.storage_fault ? "TF错误未清除" : "不能确认安全停止";
                safety = "请保持供电"; mode = "检查后再停止或重启";
            }
            break;
        default:
            title = m.phase == EDGE_UI_COLLECTING ? "正在采集上传" : m.phase == EDGE_UI_PAUSED ? "采集已暂停" : "正在启动";
            help = "长按BOOT 2s安全停止"; detail = "停止后需重启重新配置";
            safety = "USB不自动提供网络"; mode = "停止前请保持供电"; break;
        }
        fit(s_labels[5], title); fit(s_labels[0], help); fit(s_labels[1], detail); fit(s_labels[2], safety); fit(s_labels[3], mode);
        if (s->battery_known && s->battery_mv >= 2600 && s->battery_mv <= 4500) snprintf(t, sizeof t, "BAT %u.%03uV", s->battery_mv / 1000u, s->battery_mv % 1000u); else strcpy(t, "BAT --");
        fit(s_labels[4], t);
    }
}
