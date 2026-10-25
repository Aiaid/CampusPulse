// page_radar.c —— 实现见 page_radar.h。
//
// 渲染模型：每次 refresh 先由快照+交互状态算出一份"界面模型"（全部文字与
// 颜色），和上一帧逐区比较，只有变了的区域才重画。所以尽管扫描 400ms 一跳，
// 数字没变时 SPI 上是一个字节都不发的。
#include "page_radar.h"
#include "ui_mini.h"
#include "font_zh.h"           // FONT_ZH_CELL（布局静态断言用）

#include "scan_ble.h"
#include "veh_rules.h"          // EVID_LINK_SHORT
#include "bsp_battery.h"
#include "wifi_time.h"

#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"

#include <stdio.h>
#include <string.h>
#include <inttypes.h>

static const char *TAG = "radar";

#define REFRESH_MS      400
#define CONFIRM_MS      3000    // RESET 二次确认的超时
#define INPUT_QUEUE_LEN 16

// ---------------------------------------------------------------------------
// 布局（240x320，对应效果图 radar-ui-mock.html）
// 手机/电动车左右两列并排；正文 20px 粗体（小屏上 16px 细笔画会丢，见
// gen_font.ps1 头注释）。改这里不用心算总账：超高触发静态断言，编译报错。
// ---------------------------------------------------------------------------
#define L_BAR_H     30
#define L_LBL_Y     32    // 两列标签（与数字之间留 ~8px，贴着不好看）
#define L_NUM_Y     58    // 60px 大数字 → 底 118
#define L_SIDE_Y    126   // 状态小字行（居中）
#define L_DIV_Y     150
#define L_ROWS_Y    158
#define L_ROW_H     36
#define L_HINT_Y    282

// 两列中心（列宽 112，左右各留 8px 边距）
#define L_COL1_CX   64
#define L_COL2_CX   184

_Static_assert(L_NUM_Y + 60 <= L_SIDE_Y, "numbers overlap side line");
_Static_assert(L_SIDE_Y + FONT_ZH_CELL <= L_DIV_Y, "side line overlaps divider");
_Static_assert(L_ROWS_Y + 3 * L_ROW_H <= L_HINT_Y, "rows overlap hint");
_Static_assert(L_HINT_Y + FONT_ZH_CELL <= UI_H, "hint overflows screen");

#define REG_BAR  ((ui_rect_t){ 0, 0,       UI_W, L_BAR_H })
#define REG_NUMS ((ui_rect_t){ 0, L_BAR_H, UI_W, (L_DIV_Y - L_BAR_H) })
#define REG_ROWS ((ui_rect_t){ 0, L_DIV_Y, UI_W, (L_HINT_Y - L_DIV_Y) })
#define REG_HINT ((ui_rect_t){ 0, L_HINT_Y, UI_W, (UI_H - L_HINT_Y) })

// 焦点（与旧版一致：含 NONE 空位，"只是看看"不会手抖改掉判据）
#define FOCUS_ROWS   4
#define FOCUS_NONE   0
#define FOCUS_PHONE  1
#define FOCUS_EBIKE  2
#define FOCUS_RESET  3

// ---------------------------------------------------------------------------
// 界面模型
// ---------------------------------------------------------------------------
typedef struct {
    // 状态栏
    int  bat;                    // -1 = 电量计不可用
    int  err;                    // 0 = 扫描正常；否则是 last_error
    bool sniff;
    char time[6];                // "HH:MM"；未对时 "--:--"
    // 数字区
    char     phone[8];
    uint16_t phone_col;
    char     bike[8];
    uint16_t bike_col;
    char     side[24];
    uint16_t side_col;
    // 开关/动作行
    bool phone_on;
    bool bike_on;
    int  focus;
    bool confirm;
} radar_model_t;

static radar_model_t s_shown;
static bool s_first_frame = true;
static bool s_waiting_shown;

static TaskHandle_t s_task;
typedef struct {
    bsp_btn_t btn;
    bsp_btn_ev_t event;
    int64_t timestamp_us;
} radar_input_t;
static QueueHandle_t s_input_queue;
static portMUX_TYPE s_ingress_lock = portMUX_INITIALIZER_UNLOCKED;
static uint32_t s_input_drops;
static void process_input(const radar_input_t *input);

// The state below is owned exclusively by radar_ui after startup.
static int s_focus = FOCUS_NONE;
static bool s_confirm;
static int64_t s_confirm_deadline_us;

// ---------------------------------------------------------------------------
// 显示层平滑（中位数滤波，理由与旧版一致：数据保持真实，画之前取最近
// 5 帧中位数；判据切换/清零时必须 smooth_reset，否则新旧数字混出怪值）
// ---------------------------------------------------------------------------
#define SMOOTH_N 5
typedef struct { uint16_t v[SMOOTH_N]; uint8_t pos, n; } smooth_t;
static smooth_t s_ph_smooth, s_veh_smooth;

static unsigned smooth_add(smooth_t *s, unsigned x)
{
    if (x > 65535u) x = 65535u;
    s->v[s->pos] = (uint16_t)x;
    s->pos = (uint8_t)((s->pos + 1) % SMOOTH_N);
    if (s->n < SMOOTH_N) s->n++;
    uint16_t a[SMOOTH_N];
    for (uint8_t i = 0; i < s->n; i++) a[i] = s->v[i];
    for (uint8_t i = 1; i < s->n; i++) {
        uint16_t k = a[i];
        int8_t j = (int8_t)i - 1;
        while (j >= 0 && a[j] > k) { a[j + 1] = a[j]; j--; }
        a[j + 1] = k;
    }
    return a[s->n / 2];
}

static void smooth_reset(smooth_t *s) { s->pos = 0; s->n = 0; }

// 数量 → 颜色：<10 绿、10~19 橙、>=20 红（20 归红，改边界就改这里）。
// 附近人数和电动车同一套语义：颜色 = 拥挤度，不再用颜色区分人和车。
static uint16_t count_color(unsigned n)
{
    return n < 8 ? UI_COL_GREEN : (n < 14 ? UI_COL_ORANGE : UI_COL_RED);
}

// ---------------------------------------------------------------------------
// 各区域绘制（user = const radar_model_t*）
// ---------------------------------------------------------------------------

static void paint_bar(void *user)
{
    const radar_model_t *m = user;
    ui_clear(UI_COL_BG);

    ui_fill(12, 10, 9, 9, UI_COL_TEAL);          // 标题点
    if (m->err) {
        char buf[24];
        snprintf(buf, sizeof buf, "扫描停止 err %d", m->err);
        ui_text(27, 5, buf, UI_COL_RED);
    } else {
        ui_text(27, 5, "DIAG", UI_COL_FG);
        if (m->sniff) {
            ui_text(27 + ui_text_width("DIAG"), 5, " LOG", UI_COL_ORANGE);
        }
    }

    // 右侧从右往左排：电池图标 → 百分比 → 时间（未对时 "--:--" 暗灰）。
    const int bx = UI_W - 12 - 18, by = 10;
    ui_fill(bx, by, 16, 1, UI_COL_MUTED);
    ui_fill(bx, by + 7, 16, 1, UI_COL_MUTED);
    ui_fill(bx, by, 1, 8, UI_COL_MUTED);
    ui_fill(bx + 15, by, 1, 8, UI_COL_MUTED);
    ui_fill(bx + 16, by + 2, 2, 4, UI_COL_MUTED);   // 极耳
    int right_x = bx - 8;
    if (m->bat >= 0) {
        const int fw = (m->bat * 14) / 100;
        if (fw > 0) {
            ui_fill(bx + 1, by + 1, fw, 6, m->bat < 20 ? UI_COL_RED : UI_COL_TEAL);
        }
        char pct[8];
        snprintf(pct, sizeof pct, "%d%%", m->bat);
        right_x -= ui_text_width(pct);
        ui_text(right_x, by - 3, pct, UI_COL_MUTED);
        right_x -= 12;
    } else {
        right_x -= ui_text_width("--");
        ui_text(right_x, by - 3, "--", UI_COL_DIM);
        right_x -= 12;
    }
    const bool time_ok = (m->time[0] != '-');
    ui_text(right_x - ui_text_width(m->time), by - 3, m->time,
            time_ok ? UI_COL_FG : UI_COL_DIM);
}

static void paint_nums(void *user)
{
    const radar_model_t *m = user;
    ui_clear(UI_COL_BG);
    // 两列：标签居中在上，60px 大数字居中在下
    ui_text(L_COL1_CX - ui_text_width("附近人数") / 2, L_LBL_Y, "附近人数", UI_COL_MUTED);
    ui_digits(L_COL1_CX - ui_digits_width(m->phone) / 2, L_NUM_Y,
              m->phone, m->phone_col);
    ui_text(L_COL2_CX - ui_text_width("电动车") / 2, L_LBL_Y, "电动车", UI_COL_MUTED);
    ui_digits(L_COL2_CX - ui_digits_width(m->bike) / 2, L_NUM_Y,
              m->bike, m->bike_col);
    if (m->side[0]) {
        ui_text((UI_W - ui_text_width(m->side)) / 2, L_SIDE_Y, m->side, m->side_col);
    }
}

static void draw_checkbox(int x, int y, bool on)
{
    // 13x13：边框 1px；勾上时填黄、中心抠 5x5 底色的"反白"效果
    ui_fill(x, y, 13, 1, UI_COL_MUTED);
    ui_fill(x, y + 12, 13, 1, UI_COL_MUTED);
    ui_fill(x, y, 1, 13, UI_COL_MUTED);
    ui_fill(x + 12, y, 1, 13, UI_COL_MUTED);
    if (on) {
        ui_fill(x + 2, y + 2, 9, 9, UI_COL_YELLOW);
        ui_fill(x + 4, y + 4, 5, 5, UI_COL_BG);
    }
}

static void paint_rows(void *user)
{
    const radar_model_t *m = user;
    ui_clear(UI_COL_BG);
    ui_fill(12, L_DIV_Y, UI_W - 24, 1, UI_COL_LINE);

    for (int i = 0; i < 3; i++) {
        const int y = L_ROWS_Y + i * L_ROW_H;
        const bool focused = (m->focus == i + 1);
        const bool danger  = focused && i == 2 && m->confirm;
        if (focused) {
            ui_fill(0, y, UI_W, L_ROW_H - 1, danger ? UI_COL_DANGER : UI_COL_ROW_BG);
            ui_fill(0, y, 3, L_ROW_H - 1, danger ? UI_COL_RED : UI_COL_YELLOW);
        }
        if (i == 0) {
            draw_checkbox(16, y + 11, m->phone_on);
            ui_text(40, y + 8, "手机采样", m->phone_on ? UI_COL_SOFT : UI_COL_MUTED);
        } else if (i == 1) {
            draw_checkbox(16, y + 11, m->bike_on);
            ui_text(40, y + 8, "电动车采样", m->bike_on ? UI_COL_SOFT : UI_COL_MUTED);
        } else if (m->confirm) {
            ui_text(40, y + 8, "再按一次确认清零", UI_COL_RED);
        } else {
            ui_text(40, y + 8, "全部清零", UI_COL_MUTED);
        }
    }
}

static void paint_hint(void *user)
{
    const radar_model_t *m = user;
    ui_clear(UI_COL_BG);
    const char *s = m->confirm ? "▲▼ 取消  OK 确认"
                               : "▲▼ 选择  OK 切换";
    ui_text((UI_W - ui_text_width(s)) / 2, L_HINT_Y + 3, s, UI_COL_MUTED);
}

// ---------------------------------------------------------------------------
// 刷新
// ---------------------------------------------------------------------------

static void build_model(const scan_snapshot_t *snap, int bat, radar_model_t *m)
{
    memset(m, 0, sizeof *m);
    m->bat  = bat;
    m->err  = snap->running ? 0 : snap->last_error;
    m->sniff = snap->sniffing;
    {
        int hh, mm;
        if (wifi_time_now(&hh, &mm)) {
            snprintf(m->time, sizeof m->time, "%02d:%02d", hh, mm);
        } else {
            memcpy(m->time, "--:--", sizeof "--:--");
        }
    }

    // 手机：关掉显示 "--"（0 会被读成"一个人都没有"）
    if (snap->phone_on) {
        const unsigned pv = smooth_add(&s_ph_smooth, (unsigned)snap->phone_count);
        snprintf(m->phone, sizeof m->phone, "%u", pv);
        m->phone_col = count_color(pv);
    } else {
        memcpy(m->phone, "--", 3);
        m->phone_col = UI_COL_DIM;
    }

    // 车：观察期（判据刚改/刚启动）或判定关闭 = "还没有结论"，显示 "--"
    const bool settling = snap->vehicle_settle_left_ms > 0;
    const bool bike_on  = snap->evidence_mask != 0;
    if (settling || !bike_on) {
        smooth_reset(&s_veh_smooth);
        memcpy(m->bike, "--", 3);
        m->bike_col = UI_COL_DIM;
    } else {
        const unsigned vv = smooth_add(&s_veh_smooth, (unsigned)snap->vehicle_count);
        snprintf(m->bike, sizeof m->bike, "%u", vv);
        m->bike_col = count_color(vv);
    }

    // 右侧小字：优先解释"车数为什么不可信"
    if (!bike_on) {
        memcpy(m->side, "采样关闭", sizeof "采样关闭");
        m->side_col = UI_COL_MUTED;
    } else if (settling) {
        snprintf(m->side, sizeof m->side, "重新观察 %us",
                 (unsigned)((snap->vehicle_settle_left_ms + 999u) / 1000u));
        m->side_col = UI_COL_ORANGE;
    } else if (snap->vehicle_wait_ms > 0) {
        snprintf(m->side, sizeof m->side, "等待 %us",
                 (unsigned)((snap->vehicle_wait_ms + 999u) / 1000u));
        m->side_col = UI_COL_ORANGE;
    } else if (!snap->phone_on) {
        // 手机采样关着时数字是 "--"：明说一句，免得被读成"附近没人"
        memcpy(m->side, "手机采样已关闭", sizeof "手机采样已关闭");
        m->side_col = UI_COL_MUTED;
    }

    m->phone_on = snap->phone_on;
    m->bike_on  = bike_on;
    m->focus    = s_focus;
    m->confirm  = s_confirm;
}

static void render_dirty(const radar_model_t *m)
{
    const radar_model_t *o = &s_shown;
    if (s_first_frame) {
        ui_render(REG_BAR, paint_bar, (void *)m);
        ui_render(REG_NUMS, paint_nums, (void *)m);
        ui_render(REG_ROWS, paint_rows, (void *)m);
        ui_render(REG_HINT, paint_hint, (void *)m);
        s_first_frame = false;
        return;
    }
    if (m->bat != o->bat || m->err != o->err || m->sniff != o->sniff ||
        memcmp(m->time, o->time, sizeof m->time)) {
        ui_render(REG_BAR, paint_bar, (void *)m);
    }
    if (memcmp(m->phone, o->phone, sizeof m->phone) ||
        memcmp(m->bike, o->bike, sizeof m->bike) ||
        memcmp(m->side, o->side, sizeof m->side) ||
        m->phone_col != o->phone_col || m->bike_col != o->bike_col ||
        m->side_col != o->side_col) {
        ui_render(REG_NUMS, paint_nums, (void *)m);
    }
    if (m->phone_on != o->phone_on || m->bike_on != o->bike_on ||
        m->focus != o->focus || m->confirm != o->confirm) {
        ui_render(REG_ROWS, paint_rows, (void *)m);
    }
    if (m->confirm != o->confirm) {
        ui_render(REG_HINT, paint_hint, (void *)m);
    }
}

static void paint_unavailable(void *arg)
{
    (void)arg;
    ui_clear(UI_COL_BG);
    ui_text(12, 12, "DIAG", UI_COL_TEAL);
    ui_text(12, 60, "Snapshot unavailable", UI_COL_ORANGE);
    ui_text(12, 88, "Waiting for collector", UI_COL_MUTED);
}

static void refresh(void)
{
    // 确认超时：回到未确认态（UP/DOWN 也会取消，见按键处理）
    if (s_confirm && esp_timer_get_time() > s_confirm_deadline_us) {
        s_confirm = false;
    }

    scan_snapshot_t snap = {0};
    scan_ble_snapshot(&snap);

    if (!snap.snapshot_valid && s_first_frame) {
        if (!s_waiting_shown) {
            ui_render((ui_rect_t){0, 0, UI_W, UI_H}, paint_unavailable, NULL);
            s_waiting_shown = true;
        }
        return; // An unavailable projection must never render observed zeroes.
    }

    // 电量计不可用时 soc() 返回 -1；每次 tick 都问一次，恢复正常会自动显示
    const int bat = bsp_battery_soc();

    radar_model_t m;
    if (snap.snapshot_valid) {
        build_model(&snap, bat, &m);
    } else {
        // Preserve the last displayed sample, explicitly marking its availability.
        // Do not advance the smoothing filter with an invalid/zeroed snapshot.
        m = s_shown;
        m.bat = bat;
        memcpy(m.side, "Snapshot unavailable", sizeof "Snapshot unavailable");
        m.side_col = UI_COL_ORANGE;
        m.focus = s_focus;
        m.confirm = s_confirm;
    }
    render_dirty(&m);
    s_shown = m;
}

static void radar_task(void *arg)
{
    QueueHandle_t queue = arg;
    uint32_t reported_input_drops = 0;
    for (;;) {
        radar_input_t input;
        if (xQueueReceive(queue, &input, pdMS_TO_TICKS(REFRESH_MS)) == pdTRUE) {
            process_input(&input);
            // Bounded drain prevents sustained input from starving rendering.
            for (unsigned i = 1; i < INPUT_QUEUE_LEN; i++) {
                if (xQueueReceive(queue, &input, 0) != pdTRUE) break;
                process_input(&input);
            }
        }
        refresh();
        const uint32_t input_drops = radar_page_input_drops();
        if (input_drops != reported_input_drops) {
            ESP_LOGW(TAG, "UI input drops: total=%" PRIu32, input_drops);
            reported_input_drops = input_drops;
        }
    }
}

// ---------------------------------------------------------------------------
// 对外接口
// ---------------------------------------------------------------------------

esp_err_t radar_page_start(void)
{
    if (s_task) return ESP_OK;
    QueueHandle_t queue = xQueueCreate(INPUT_QUEUE_LEN, sizeof(radar_input_t));
    if (!queue) return ESP_ERR_NO_MEM;
    TaskHandle_t task = NULL;
    if (xTaskCreate(radar_task, "radar_ui", 4096, queue, 4, &task) != pdPASS) {
        vQueueDelete(queue);
        return ESP_ERR_NO_MEM;
    }
    // Publish only after success: the queue remains valid for the runtime's life.
    portENTER_CRITICAL(&s_ingress_lock);
    s_input_queue = queue;
    s_task = task;
    portEXIT_CRITICAL(&s_ingress_lock);
    return ESP_OK;
}

void radar_page_key(bsp_btn_t btn, bsp_btn_ev_t ev)
{
    radar_page_key_at(btn, ev, esp_timer_get_time());
}

void radar_page_key_at(bsp_btn_t btn, bsp_btn_ev_t ev, int64_t occurred_us)
{
    const radar_input_t input = {
        .btn = btn, .event = ev, .timestamp_us = occurred_us,
    };
    portENTER_CRITICAL(&s_ingress_lock);
    QueueHandle_t queue = s_input_queue;
    portEXIT_CRITICAL(&s_ingress_lock);
    if (occurred_us >= 0 && queue && xQueueSend(queue, &input, 0) == pdTRUE) return;
    portENTER_CRITICAL(&s_ingress_lock);
    if (s_input_drops < UINT32_MAX) s_input_drops++;
    portEXIT_CRITICAL(&s_ingress_lock);
}

uint32_t radar_page_input_drops(void)
{
    portENTER_CRITICAL(&s_ingress_lock);
    const uint32_t drops = s_input_drops;
    portEXIT_CRITICAL(&s_ingress_lock);
    return drops;
}

static void process_input(const radar_input_t *input)
{
    const bsp_btn_t btn = input->btn;
    const bsp_btn_ev_t ev = input->event;
    // Use physical ingress time, so a delayed queue cannot extend confirmation.
    if (s_confirm && input->timestamp_us > s_confirm_deadline_us) s_confirm = false;
    ESP_LOGI(TAG, "key btn=%d ev=%d focus=%d", (int)btn, (int)ev, s_focus);

    if (btn == BSP_BTN_OK && ev == BSP_BTN_DOUBLE) {
        scan_ble_set_sniff(!scan_ble_get_sniff());
        return;
    }
    // 长按 OK 不设功能：开关机是机身左侧的独立硬件电源键（见硬件指南），
    // 固件再占一个键做关机只是多一条手滑误触的路径。
    if (ev != BSP_BTN_CLICK) return;

    if (btn == BSP_BTN_UP || btn == BSP_BTN_DOWN) {
        s_confirm = false;              // 移动焦点 = 取消确认态
        s_focus = (btn == BSP_BTN_UP)
                ? (s_focus + FOCUS_ROWS - 1) % FOCUS_ROWS
                : (s_focus + 1) % FOCUS_ROWS;
        return;
    }

    if (btn == BSP_BTN_OK) {
        // 焦点在"无"时先落到 PHONE 行，不顺手改任何判据
        if (s_focus == FOCUS_NONE) {
            s_focus = FOCUS_PHONE;
            return;
        }
        if (s_focus == FOCUS_PHONE) {
            scan_ble_set_phone(!scan_ble_get_phone());
            smooth_reset(&s_ph_smooth); // 不然屏幕上留着关闭前的旧中位数
            return;
        }
        if (s_focus == FOCUS_EBIKE) {
            const uint8_t mask = (uint8_t)(scan_ble_get_evidence() ^ EVID_LINK_SHORT);
            // 生效会把所有设备的在场计时归零，界面随即进入"重新观察 Ns"
            if (!scan_ble_set_evidence(mask)) {
                ESP_LOGW(TAG, "判据切换未生效（扫描表忙），请重按");
            }
            smooth_reset(&s_veh_smooth);
            return;
        }
        // FOCUS_RESET：两段确认（理由见 page_radar.h）
        if (!s_confirm) {
            s_confirm = true;
            s_confirm_deadline_us = input->timestamp_us + (int64_t)CONFIRM_MS * 1000;
        } else {
            s_confirm = false;
            scan_ble_reset();
            // 平滑缓冲也要清，否则会先画出旧数字再"过渡"到 0，像没生效
            smooth_reset(&s_ph_smooth);
            smooth_reset(&s_veh_smooth);
            ESP_LOGI(TAG, "计数已清零");
        }
    }
}
