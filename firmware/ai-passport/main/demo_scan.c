// main/demo_scan.c —— "DEV SEEN"页面：手机数 / 电动车数 + 电动车判据勾选。
//
// 这一页回答两个问题：
//   1. 附近有多少人（手机数）——人流密度主指标
//   2. 附近停了多少辆电动车（电动车数）
//
// 界面（240x320 竖屏，标题栏占 8~41，草地从 286 开始）：
//
//       [ DEV SEEN ]
//   PHONE      12        <- 标签 14 号灰，数字 36 号黄
//
//   E-BIKE      3        <- 标签 14 号灰，数字 36 号红
//   LOADING 24s          <- 判据刚改过：旧结论作废，车数显示 "--"，重新观察 30s
//   WAIT 6s              <- 有新进场的候选还没攒够 30 秒；0 时换成 TOTAL/pkt
//   APPLE 19 GOOGLE 5    <- 诊断行：车数里有多少是苹果/谷歌广播的
//
//   >> [x] PHONE        <- 采样开关：关掉就跳过手机判定（省 CPU）
//      [x] E-BIKE        <- 采样开关：关掉就跳过车判据
//      RESET ALL         <- 动作行（不是勾选）：按 OK 清空所有计数，重新开始
//
// 按键与套件原有逻辑一致（UP/DOWN 移动、OK 确认、长按退出）：
//   UP         焦点上移一行：PHONE → 无 → RESET → E-BIKE → PHONE
//   DOWN       焦点下移一行：无 → PHONE → E-BIKE → RESET → 无
//              方向键**只移动，永远不改判据**
//   OK 短按    切换当前焦点行的开关；焦点在 RESET 上则清空计数
//              焦点在"无"时先落到 PHONE 行，不顺手改
//   OK 双击    切换串口标定日志（sniffer）
//   OK 长按    由 main.c 统一拦截，返回菜单（本页不参与，任何页都能退出）
//
// 为什么焦点要包含 NONE：如果焦点永远停在开关行上，用户就没办法"什么都不改
// 只是看看"——手一抖就把车数关了。留一个空位给这个用途。
//
// 【v25：三条证据勾选合并成一个开关】
// 原来是 A.UUID128 / B.MANU>=8 / C.LINK-SHT 三个勾选框，实测后只剩第三个有用：
//   A 128 位 UUID：车棚 0 命中（128 位 UUID 主要在连接后的 GATT 表里）
//   B manu>=8    ：真车 0 命中（车是 0~6 字节），室内却误判 37 台
// 留着它们只会让用户去勾一个只会添乱的选项，所以删掉。
// 证据位机制本身保留（EVID_LINK_SHORT 仍在计数函数里参与判定），
// 只是界面上变成"开/关"两态。
#include "demo.h"
#include "bsp_display.h"    // bsp_lvgl_lock / bsp_lvgl_unlock（非 LVGL 任务里改界面必须加锁）
#include "scan_ble.h"
#include "dev_class.h"     // EVID_* / SCAN_VEHICLE_DWELL_MS
#include "scan_table.h"
#include "scan_stats.h"   // scan_stats_count（决定要不要导出）
#include "ui_pixel.h"

#include "esp_log.h"
#include "lvgl.h"
#include <stdio.h>
#include <string.h>

#define REFRESH_MS 400

// 焦点行数 = 1 个空行 + 2 个开关 + 1 个动作行（RESET）。
#define FOCUS_ROWS   4
#define FOCUS_NONE   0     // 空行：UP/DOWN 不做任何事
#define FOCUS_PHONE  1     // 手机判定开关（关掉时 on_disc 跳过 is_phone）
#define FOCUS_EBIKE  2     // 电动车判定开关（= EVID_LINK_SHORT 这一位）
#define FOCUS_RESET  3     // 动作行：不是勾选项，按 OK 直接执行

static lv_obj_t *s_scr;
static lv_obj_t *s_phone_label;
static lv_obj_t *s_vehicle_label;
static lv_obj_t *s_sub_label;
static lv_obj_t *s_sub2_label;   // 诊断行：车数里有多少是 Apple/Google
// A/B/C 三行共用一个红底块，而不是每行各来一块。原因：LVGL 里同级的兄弟对象
// 后创建的盖在上面，三块色块会把三行文字全遮住（文字是比色块早创建的）。
// 一块色块 + 按焦点行挪 y，既能保证它永远在文字下面，也省两次样式刷新。
static lv_obj_t *s_ev_hl;
static lv_obj_t *s_ev_rows[3];   // PHONE / E-BIKE 两个开关行 + RESET 动作行
static lv_timer_t *s_timer;
static scan_snapshot_t s_snap;
static int s_focus;

// 两行（E-BIKE 开关 + RESET）的行距与首行基线。
//
// 纵向预算（屏高 320，草地从 286 开始，可用 0~285）：
//   数字行 54~110、120~176；状态行 174；诊断行 190；
//   三行（PHONE / E-BIKE / RESET）从 212 起，行距 26 → 212 / 238 / 264，
//   最后一行字底 278，离草地还有 8px。
//
// 【v28】加了 PHONE 开关回到三行，行距从 30 收到 26（字体高 14，还剩 12px 间隙）。
#define EV_ROW_Y0  212
#define EV_ROW_H   26
#define SUB_ROW_Y   174   // 状态行（LOADING / WAIT / TOTAL）
#define SUB2_ROW_Y  190   // 诊断行（APPLE/GOOGLE 或 LIVE/RAW）

// 焦点行 → 证据位。
static const uint8_t FOCUS_TO_EVID[FOCUS_ROWS] = {
    0,                  // FOCUS_NONE
    0,                  // FOCUS_PHONE：手机判定不走证据位，单独一个开关
    EVID_LINK_SHORT,    // E-BIKE：可连接 + 厂商数据 <8 字节（唯一有效的判据）
    0,                  // RESET：不是判据，没有证据位
};

// ---------------------------------------------------------------------------
// 显示层平滑
// ---------------------------------------------------------------------------
//
// 为什么要在显示这一层做，而不是改数据层：
//
// 数据层的抖动是可以解释的——10 秒窗口内有约 190 台设备，每台广播间隔
// P50=2s、P90=4s，任何时刻总有一批设备正好落在窗口边缘，进进出出是
// **统计口径的必然结果**，不是 bug。把窗口越拉越长只会让数字变得迟钝
// 而且虚高（15 秒比 5 秒多出 20 台，那是"刚才在过"的人）。
//
// 而用户要的是"现在大概多少人"，不是"这一帧精确到个位"。
// 所以数据保持真实，只在画到屏幕上之前取最近 5 帧的中位数：
//
//   UI 每 400ms 刷一帧 -> 5 帧 = 2 秒窗口
//   中位数而不是平均：单帧异常（某人刚走过、地址刚轮换）会被直接忽略，
//   而平均值会被它拉偏一整段。
//
// 代价：数字对真实变化有约 1 秒的滞后。人流变化的尺度是几十秒，
// 这个代价可以忽略。LOG ON 的串口日志仍然是逐包的原始数据，不受影响。
#define SMOOTH_N 5

typedef struct {
    uint16_t v[SMOOTH_N];
    uint8_t pos;
    uint8_t n;
} smooth_t;

static smooth_t s_ph_smooth;      // PHONE 显示值
static smooth_t s_veh_smooth;     // 车数显示值
static smooth_t s_live_smooth;    // 诊断行的 LIVE

// 推入一帧并返回中位数。n <= 5，直接插入排序，比调用 qsort 省得多。
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
        while (j >= 0 && a[j] > k) {
            a[j + 1] = a[j];
            j--;
        }
        a[j + 1] = k;
    }
    return a[s->n / 2];
}

// 清空历史。判据切换、重新开始扫描时必须调用——否则会把上一轮的
// 旧数字和新一轮混在一起取中位数，屏幕上出现一个既不旧也不新的怪数字。
static void smooth_reset(smooth_t *s)
{
    s->pos = 0;
    s->n = 0;
}

static void refresh(void)
{
    // ---- 所有 LVGL 调用都必须在 lvgl_port 的递归锁内 ----
    //
    // 本页 refresh() 有两条调用路径：
    //   1) lv_timer 回调 tick()    —— 跑在 LVGL 任务里，锁本来就在手上；
    //   2) demo_scan_key()         —— 跑在 demo_input 任务里，锁**不在**手上。
    //
    // 第 2 条以前是裸调的（这一页是唯一没加锁的页面，其他 demo 都加了）。
    // 后果是撞上 LVGL 渲染的瞬间，lv_inv_area() 里这条断言直接命中：
    //   LV_ASSERT_MSG(!disp->rendering_in_progress,
    //                 "Invalidate area is not allowed during rendering.");
    // 默认的 assert handler 是 while(1)，于是 demo_input 死在 lv_inv_area 里，
    // IDLE 喂不到看门狗 → task_wdt 报 "CPU 0: demo_input"。
    // 用户看到的就是"随便按两下就卡死、动不了"。
    //
    // esp_lvgl_port 的锁是递归的，所以路径 1 再取一次不会自锁。
    //
    // 快照也放在锁内：s_snap 是两条路径共用的静态缓冲，放锁外照样是竞态
    // （不会崩，但会把两个时刻的数据混进同一帧）。等扫描表锁最长 20ms，
    // 对 240x320 的一帧渲染可以忽略。
    if (!bsp_lvgl_lock(250)) return;

    scan_ble_snapshot(&s_snap);

    // 平滑后的显示值（中位数，见 SMOOTH_N 的说明）。
    if (s_snap.phone_on) {
        lv_label_set_text_fmt(s_phone_label, "%u",
                              smooth_add(&s_ph_smooth,
                                         (unsigned)s_snap.phone_count));
        lv_obj_set_style_text_color(s_phone_label, lv_color_hex(UI_YELLOW), 0);
    } else {
        // 关掉时显示 "--" 而不是 0：0 会被读成"一个人都没有"。
        lv_label_set_text(s_phone_label, "--");
        lv_obj_set_style_text_color(s_phone_label, lv_color_hex(UI_MUTED), 0);
    }

    // ---- 车数 ----
    //
    // 观察期内（判据刚被改过，或本机刚启动）所有设备的在场计时都被归零重算，
    // 车数既不是 0、也不是某个旧值，而是"还没有结论"。这时候显示 0 会被
    // 读成"真的没有车"，所以显示 "--"，和下面的 LOADING 倒计时配套。
    const bool settling = s_snap.vehicle_settle_left_ms > 0;
    if (settling) {
        // 观察期内不显示数字，同时把平滑历史丢掉：观察期结束后的第一帧
        // 必须是新判据下的真实值，不能掺进上一轮的残留。
        smooth_reset(&s_veh_smooth);
        lv_label_set_text(s_vehicle_label, "--");
    } else {
        lv_label_set_text_fmt(s_vehicle_label, "%u",
                              smooth_add(&s_veh_smooth, (unsigned)s_snap.vehicle_count));
    }

    // ---- 状态行：优先显示"为什么车数不可信" ----
    if (!s_snap.running) {
        lv_label_set_text_fmt(s_sub_label, "SCAN STOPPED  err %d", s_snap.last_error);
        lv_obj_set_style_text_color(s_sub_label, lv_color_hex(UI_RED), 0);
    } else if (s_snap.evidence_mask == 0) {
        // 一条证据都没勾：车数没意义，明说。
        lv_label_set_text(s_sub_label, "E-BIKE OFF");
        lv_obj_set_style_text_color(s_sub_label, lv_color_hex(UI_MUTED), 0);
    } else if (settling) {
        // 判据刚改过：旧结论作废，重新观察 30 秒。倒计时是真实剩余时间。
        unsigned left = (s_snap.vehicle_settle_left_ms + 999u) / 1000u;
        lv_label_set_text_fmt(s_sub_label, "LOADING %us", left);
        lv_obj_set_style_text_color(s_sub_label, lv_color_hex(UI_ORANGE), 0);
    } else if (s_snap.vehicle_wait_ms > 0) {
        // 结论已经成立，但还有新进场的候选没攒够 30 秒。
        // 这里的秒数是**真实进度**，不是写死的 30——已经站在场 25 秒的设备只差 5 秒。
        unsigned left = (s_snap.vehicle_wait_ms + 999u) / 1000u;
        lv_label_set_text_fmt(s_sub_label, "WAIT %us", left);
        lv_obj_set_style_text_color(s_sub_label, lv_color_hex(UI_ORANGE), 0);
    } else if (s_snap.sniffing) {
        lv_label_set_text_fmt(s_sub_label, "TOTAL %lu  LOG ON",
                              (unsigned long)s_snap.total_seen);
        lv_obj_set_style_text_color(s_sub_label, lv_color_hex(UI_ORANGE), 0);
    } else {
        lv_label_set_text_fmt(s_sub_label, "TOTAL %lu  %lu pkt/s",
                              (unsigned long)s_snap.total_seen,
                              (unsigned long)s_snap.per_sec);
        lv_obj_set_style_text_color(s_sub_label, lv_color_hex(UI_GRASS_DARK), 0);
    }

    // ---- 诊断行：车数的构成 ----
    //
    // 这行回答"这 N 台到底是什么"。10 楼数出 27 辆时，这里会直接写着
    // "APPLE 19 GOOGLE 5"——一眼看出全是楼里的手机，不是楼下的车。
    // 没有 Apple/Google 污染时退回显示总在场设备数，不多占地方。
    {
        const unsigned ap = (unsigned)(s_snap.vehicle_apple +
                                       s_snap.vehicle_google +
                                       s_snap.vehicle_samsung +
                                       s_snap.vehicle_ms);
        if (ap > 0) {
            lv_label_set_text_fmt(s_sub2_label, "APPLE %u  GOOGLE %u",
                                  (unsigned)s_snap.vehicle_apple,
                                  (unsigned)s_snap.vehicle_google);
            lv_obj_set_style_text_color(s_sub2_label, lv_color_hex(UI_ORANGE), 0);
        } else {
            // `?N` = 像车但没有正面证据的台数。**不并进上面的数字**：
            // 车数现在是"下限"（默认不计，有证据才算），这个 `?N` 是
            // "如果只看广播形状、不看身份，还会有几台"。
            if (s_snap.vehicle_maybe > 0) {
                lv_label_set_text_fmt(s_sub2_label, "LIVE %u  ?%u  RAW %lu",
                                      smooth_add(&s_live_smooth,
                                                 (unsigned)s_snap.live_count),
                                      (unsigned)s_snap.vehicle_maybe,
                                      (unsigned long)s_snap.total_seen);
            } else {
                lv_label_set_text_fmt(s_sub2_label, "LIVE %u  RAW %lu",
                                      smooth_add(&s_live_smooth,
                                                 (unsigned)s_snap.live_count),
                                      (unsigned long)s_snap.total_seen);
            }
            lv_obj_set_style_text_color(s_sub2_label, lv_color_hex(UI_MUTED), 0);
        }
    }

    // ---- 开关行 ----
    //
    // 两个维度必须分开表达，否则用户分不清"我在哪一行"和"这行开没开"：
    //   焦点（我在哪）：红色条。焦点行左侧 6px 一条竖杠 + 整行淡淡压暗，
    //                  不动文字颜色，所以勾选状态照样一眼可见。
    //   勾选（有没有）：[x] / [ ] 字符本身 + 文字颜色（黄=勾上，灰=没勾）。
    // 之前只有 ">" 前缀 + 颜色跟勾选走，按 OK 换焦点时屏幕几乎没变化，
    // 用户没法确认按键有没有吃到。
    const bool phone_on = s_snap.phone_on;
    lv_label_set_text_fmt(s_ev_rows[0], "%s[%c] PHONE",
                          s_focus == FOCUS_PHONE ? "> " : "  ",
                          phone_on ? 'x' : ' ');
    lv_obj_set_style_text_color(s_ev_rows[0],
                                lv_color_hex(phone_on ? UI_YELLOW : UI_MUTED), 0);

    const bool ebike_on = (s_snap.evidence_mask & EVID_LINK_SHORT) != 0;
    lv_label_set_text_fmt(s_ev_rows[1], "%s[%c] E-BIKE",
                          s_focus == FOCUS_EBIKE ? "> " : "  ",
                          ebike_on ? 'x' : ' ');
    lv_obj_set_style_text_color(s_ev_rows[1],
                                lv_color_hex(ebike_on ? UI_YELLOW : UI_MUTED), 0);

    // ---- RESET 动作行 ----
    //
    // 故意不带 [ ]：它不是一个"状态"，而是一次动作。写成 [ ] 会让用户
    // 以为按一下是勾上、再按一下是取消，实际上按了就立刻清空。
    // 颜色固定橙色（和 LOADING / WAIT 同一个语义色），提示这一行会改变数字。
    lv_label_set_text_fmt(s_ev_rows[2], "%sRESET ALL",
                          s_focus == FOCUS_RESET ? "> " : "  ");
    lv_obj_set_style_text_color(s_ev_rows[2], lv_color_hex(UI_ORANGE), 0);

    // 焦点红条：和那一行文字同高同宽，专门用来"指示我在这儿"。
    lv_obj_set_style_bg_opa(s_ev_hl, s_focus == FOCUS_NONE ? LV_OPA_TRANSP
                                                           : LV_OPA_COVER, 0);
    if (s_focus != FOCUS_NONE) {
        lv_obj_set_y(s_ev_hl, EV_ROW_Y0 + (s_focus - 1) * EV_ROW_H - 2);
    }

    bsp_lvgl_unlock();
}

// 兜底落盘间隔。退出页面时会保存一次，但如果用户**直接拔线**（很多人不会
// 先退出），那次保存就来不及。每 30 秒存一次，最坏情况丢 30 秒的数据，
// 而一趟车棚通常 2 分钟，丢 1/4 也还能看出结论。
//
// 为什么是 30 秒而不是更短：每次保存要写 1.5KB 并 commit，耗时几十毫秒，
// 这期间 host 任务拿不到表锁会丢一些广播包。30 秒一次是可接受的取舍。
#define STATS_SAVE_MS 30000

static uint32_t s_last_save_ms;
static uint32_t s_last_bike_ms;   // [BIKE] 逐台标定日志的节拍

static void tick(lv_timer_t *t)
{
    (void)t;
    refresh();

    // 用 lv_tick 而不是 esp_timer：这个定时器本来就是 UI 的节拍源，
    // 而且页面退出后它就不跑了，自然不需要再考虑生命周期。
    const uint32_t now = lv_tick_get();
    if ((uint32_t)(now - s_last_save_ms) >= STATS_SAVE_MS) {
        s_last_save_ms = now;
        scan_ble_save_stats();
    }

    // 标定日志：LOG ON 开着时每 5 秒把"当前被计入车的每一台"逐条打出来。
    //
    // 为什么必须由固件说：离线回放拿不到真实的 dwell（dwell 从设备第一次出现
    // 开始累计，而抓包通常晚于页面启动），所以回放结果会比屏幕少几台。
    // 只有固件自己知道"这台到底算不算"。
    if (scan_ble_get_sniff() && (uint32_t)(now - s_last_bike_ms) >= 5000u) {
        s_last_bike_ms = now;
        (void)scan_ble_dump_vehicles();
    }
}

static lv_obj_t *make_big_row(lv_obj_t *parent, const char *tag, int y,
                              lv_color_t color)
{
    lv_obj_t *label = lv_label_create(parent);
    lv_obj_set_style_text_font(label, &lv_font_montserrat_14, 0);
    lv_obj_set_style_text_color(label, lv_color_hex(UI_MUTED), 0);
    lv_label_set_text(label, tag);
    lv_obj_align(label, LV_ALIGN_TOP_LEFT, 26, y + 22);

    lv_obj_t *num = lv_label_create(parent);
    lv_obj_set_style_text_font(num, &lv_font_montserrat_36, 0);
    lv_obj_set_style_text_color(num, color, 0);
    lv_label_set_text(num, "0");
    lv_obj_align(num, LV_ALIGN_TOP_LEFT, 104, y);
    return num;
}

void demo_scan_enter(void)
{
    s_scr = ui_pixel_screen_create("DEV SEEN");

    s_phone_label = make_big_row(s_scr, "PHONE", 54, lv_color_hex(UI_YELLOW));
    s_vehicle_label = make_big_row(s_scr, "E-BIKE", 120, lv_color_hex(UI_RED));

    s_sub_label = lv_label_create(s_scr);
    lv_obj_set_style_text_font(s_sub_label, &lv_font_montserrat_14, 0);
    lv_obj_set_style_text_color(s_sub_label, lv_color_hex(UI_MUTED), 0);
    lv_label_set_text(s_sub_label, "WARMUP");
    lv_obj_align(s_sub_label, LV_ALIGN_TOP_MID, 0, SUB_ROW_Y);

    // 诊断行（车数构成 / LIVE-RAW）。
    s_sub2_label = lv_label_create(s_scr);
    lv_obj_set_style_text_font(s_sub2_label, &lv_font_montserrat_14, 0);
    lv_obj_set_style_text_color(s_sub2_label, lv_color_hex(UI_MUTED), 0);
    lv_label_set_text(s_sub2_label, "");
    lv_obj_align(s_sub2_label, LV_ALIGN_TOP_MID, 0, SUB2_ROW_Y);

    // 焦点红条。**必须比文字先创建**：LVGL 同级对象是后创建的盖在上面，
    // 先创建色块再创建文字，文字才不会被色块吃掉。
    s_ev_hl = lv_obj_create(s_scr);
    lv_obj_remove_flag(s_ev_hl, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_set_pos(s_ev_hl, 16, EV_ROW_Y0 - 2);
    lv_obj_set_size(s_ev_hl, 208, EV_ROW_H - 2);
    lv_obj_set_style_radius(s_ev_hl, 0, 0);
    lv_obj_set_style_border_width(s_ev_hl, 0, 0);
    lv_obj_set_style_pad_all(s_ev_hl, 0, 0);
    lv_obj_set_style_bg_color(s_ev_hl, lv_color_hex(UI_INK), 0);
    lv_obj_set_style_bg_opa(s_ev_hl, LV_OPA_TRANSP, 0);

    // 3 行 = PHONE / E-BIKE 两个开关 + RESET 动作行
    for (int i = 0; i < 3; i++) {
        s_ev_rows[i] = lv_label_create(s_scr);
        lv_obj_set_style_text_font(s_ev_rows[i], &lv_font_montserrat_14, 0);
        lv_obj_set_style_text_color(s_ev_rows[i], lv_color_hex(UI_MUTED), 0);
        lv_label_set_text(s_ev_rows[i], "");
        lv_obj_align(s_ev_rows[i], LV_ALIGN_TOP_LEFT, 22, EV_ROW_Y0 + i * EV_ROW_H);
    }

    s_focus = FOCUS_NONE;
    memset(&s_snap, 0, sizeof(s_snap));
    // 进页面时清空平滑历史：上一轮的数字不能带进来。
    smooth_reset(&s_ph_smooth);
    smooth_reset(&s_veh_smooth);
    smooth_reset(&s_live_smooth);
    // 注：累计签名表的导出**不在这里**，而是放在 scan_ble_start() 里。
    // 原因是执行顺序：main.c 先调 enter 再调 start，而 s_lock 是在
    // scan_ble_start() 里创建的。放在 enter 里，第一次进页面时 s_lock
    // 还是 NULL，dump 会静默返回 0 —— 实测踩过一次，串口一行都没有。

    s_last_save_ms = lv_tick_get();
    s_timer = lv_timer_create(tick, REFRESH_MS, NULL);
    refresh();
    lv_screen_load(s_scr);
}

void demo_scan_exit(void)
{
    if (s_timer) {
        lv_timer_delete(s_timer);
        s_timer = NULL;
    }
    if (s_scr) {
        lv_obj_delete(s_scr);
        s_scr = NULL;
        s_phone_label = NULL;
        s_vehicle_label = NULL;
        s_sub_label = NULL;
        s_sub2_label = NULL;
        s_ev_hl = NULL;
        for (int i = 0; i < 3; i++) s_ev_rows[i] = NULL;
    }
}

esp_err_t demo_scan_start(void)
{
    return scan_ble_start();
}

esp_err_t demo_scan_stop(void)
{
    return scan_ble_stop();
}

void demo_scan_key(bsp_btn_t btn, bsp_btn_ev_t ev)
{
    // 诊断日志：确认按键事件到底有没有送到这一页。
    // 万一"按什么都没反应"复现，从串口就能分清是【按键没进来】还是【界面没刷新】。
    ESP_LOGI("demo_scan", "key btn=%d ev=%d focus=%d", (int)btn, (int)ev, s_focus);

    // 双击 OK 切换串口标定日志（长按被 main.c 的导航层吃掉用于回菜单，
    // 所以这里只能用双击）。
    if (btn == BSP_BTN_OK && ev == BSP_BTN_DOUBLE) {
        scan_ble_set_sniff(!scan_ble_get_sniff());
        refresh();
        return;
    }
    if (ev != BSP_BTN_CLICK) return;

    // -----------------------------------------------------------------------
    // 键位与套件原有导航保持一致
    // -----------------------------------------------------------------------
    //
    // 套件（以及 main.c 的菜单页）的约定是一条「上下移动、确认进入」的纵向列表：
    //
    //     UP    -> 选项上移
    //     DOWN  -> 选项下移
    //     OK    -> 确认 / 进入
    //     长按  -> 退出（由 main.c 的导航层处理，页面收不到）
    //
    // 我前面几版擅自改成了「OK/UP 移动焦点、DOWN 改勾选」——这是少数派操作习惯，
    // 和同一个设备上的菜单页不一致，换个页面就要重新学一遍。现在改回套件习惯。
    //
    // 那"确认"放在哪？原有逻辑里 OK 是"进入下一层"，在这里正好对应
    // **下探一层**：OK 在三条证据之间移动焦点（等同于列表平移），
    // 而焦点停在证据行上时，**再按一次 OK 就切换这一行的勾选**。
    //
    // 更简单地说：
    //     UP/DOWN  = 换行（永远只移动，不改判据）
    //     OK       = 勾选 / 取消当前行（焦点在 NONE 时先落到 A 行，不直接改）
    //
    // 这样"移动"仍然只由方向键负责，"确认"由 OK 负责——和菜单页一致。
    // 长按 OK 退出仍然走 main.c，没有改动，任何页面都能退出。
    // -----------------------------------------------------------------------

    if (btn == BSP_BTN_UP) {
        // (focus - 1 + ROWS) % ROWS，从 NONE(0) 往上就是 RESET(2)。
        s_focus = (s_focus + FOCUS_ROWS - 1) % FOCUS_ROWS;
        refresh();
        return;
    }

    if (btn == BSP_BTN_DOWN) {
        s_focus = (s_focus + 1) % FOCUS_ROWS;
        refresh();
        return;
    }

    if (btn == BSP_BTN_OK) {
        // 焦点停在"无"时，先落到第一行（PHONE），不顺手改掉任何判据——
        // 这样误按 OK 的代价只是"焦点跑到了第一行"，而不是"悄悄换了一条判据"。
        //
        // 【v31 修正】v28 加 PHONE 行时漏改这里，还写着 FOCUS_EBIKE，
        // 于是按 OK 会跳过 PHONE 直接停在 E-BIKE 上——和注释、和使用说明都不一致。
        if (s_focus == FOCUS_NONE) {
            s_focus = FOCUS_PHONE;
            refresh();
            return;
        }

        // RESET 行：按一下直接清空，不需要二次确认。
        //
        // 不做二次确认的理由：这一页只有三个键（上/下/OK），做"再按一次确认"
        // 会把焦点锁在一行里，用户不知道该怎么退出这个确认态。而代价很小——
        // 清空只是重新数，"手机数"1~2 秒就会因为设备还在广播而自己涨回来。
        //
        // 清空之后的预期表现（这两个数字的行为完全不同，先说清楚）：
        //   PHONE  归 0 后很快涨回：设备仍在广播，重新观测到就计入，不需要等待。
        //   E-BIKE 保持 "--" + LOADING 10s：车要求累计在场 10 秒，
        //          而清表把所有设备的 dwell 一起清了（scan_ble_reset 里
        //          同时更新了判据观察期的时间戳），所以必须重新观察。
        // PHONE 开关：关掉之后 on_disc 直接跳过 dev_phone_is_phone()。
        if (s_focus == FOCUS_PHONE) {
            scan_ble_set_phone(!scan_ble_get_phone());
            // 平滑缓冲要清：否则屏幕上还留着关闭前的旧中位数，像没生效。
            smooth_reset(&s_ph_smooth);
            refresh();
            return;
        }

        if (s_focus == FOCUS_RESET) {
            scan_ble_reset();
            // 平滑缓冲也要清：否则屏幕上会先把旧数字的中位数画出来，
            // 再"慢慢过渡"到 0，看起来像重置没生效。
            smooth_reset(&s_ph_smooth);
            smooth_reset(&s_veh_smooth);
            smooth_reset(&s_live_smooth);
            ESP_LOGI("demo_scan", "计数已按 RESET 清零");
            refresh();
            return;
        }

        const uint8_t bit = FOCUS_TO_EVID[s_focus];
        const uint8_t mask = (uint8_t)(scan_ble_get_evidence() ^ bit);
        // 生效时会把所有设备的在场计时归零，界面随即进入 LOADING 10s
        // （车数显示 "--"）。拿不到表锁时保持原样，用户再按一次即可。
        if (!scan_ble_set_evidence(mask)) {
            ESP_LOGW("demo_scan", "判据切换未生效（扫描表忙），请重按");
        }
        refresh();
    }
}
