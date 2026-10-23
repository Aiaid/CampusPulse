// page_term.c —— 实现见 page_term.h。本文件为本基线新写。
#include "page_term.h"
#include "ui_mini.h"
#include "net_link.h"
#include "obs_api.h"
#include "obs_store.h"
#include "bsp_battery.h"
#include "esp_log.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include <stdio.h>
#include <string.h>

static const char *TAG = "page_term";

// ---------------------------------------------------------------------------
// 状态与数据
// ---------------------------------------------------------------------------

typedef enum {
    ST_PLACES = 0,   // 地点列表
    ST_PARK_MIN,     // 停车数量·最少
    ST_PARK_MAX,     // 停车数量·最多
    ST_ELEV_READY,   // 候梯计时·待开始
    ST_ELEV_RUN,     // 候梯计时·计时中
    ST_CONFIRM,      // 提交前确认
    ST_SUBMITTING,   // 提交中
    ST_RESULT,       // 结果
} st_t;

typedef enum {
    RS_NONE = 0,
    RS_SUBMITTED,      // 服务器确认（201/200）
    RS_QUEUED,         // 仅本地入队，待联网重试
    RS_NO_NET,         // 连不上网络，且入队失败/未入队
    RS_NO_TIME,        // 时间未同步，拒绝提交
    RS_REJECTED,       // 服务器拒绝（令牌错 / 数据不合法等）
} result_t;

// 拉取失败时的内置兜底（与 migrations/0001_initial.sql 种子一致）。
// 拉取成功会被服务器列表整体替换。
static const obs_place_t k_fallback_places[] = {
    { "library",            "图书馆",           "activity" },
    { "east-parking",       "东区停车观察点",   "parking"  },
    { "teaching-elevator",  "教学楼候梯观察点", "elevator" },
};

static st_t s_st = ST_PLACES;
static obs_place_t s_places[OBS_PLACE_MAX];
static int s_place_count;
static int s_focus;                 // 地点列表焦点
static int s_park_min, s_park_max;  // 停车范围
static int64_t s_elev_start_us;     // 候梯计时起点（esp_timer 单调时钟）
static int s_wait_seconds;          // 候梯结果
static result_t s_result;
static int s_result_http;           // 服务器拒绝时的状态码
static char s_pending_json[OBS_STORE_BLOB_MAX];  // 待提交/刚提交的记录
static bool s_dirty = true;         // 需要整体重画
static int s_bat_soc = -1;
static int64_t s_bat_next_us;

static QueueHandle_t s_key_queue;

typedef struct {
    bsp_btn_t btn;
    bsp_btn_ev_t ev;
} key_msg_t;

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

static const char *kind_label(const char *kind)
{
    if (strcmp(kind, "parking") == 0) return "停车";
    if (strcmp(kind, "elevator") == 0) return "候梯";
    return "活动";
}

static void uuid_v4(char out[37])
{
    uint8_t b[16];
    esp_fill_random(b, sizeof b);
    b[6] = (b[6] & 0x0F) | 0x40;   // version 4
    b[8] = (b[8] & 0x3F) | 0x80;   // variant 1
    snprintf(out, 37,
             "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
             b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7],
             b[8], b[9], b[10], b[11], b[12], b[13], b[14], b[15]);
}

static void load_fallback_places(void)
{
    s_place_count = (int)(sizeof k_fallback_places / sizeof k_fallback_places[0]);
    for (int i = 0; i < s_place_count; i++) s_places[i] = k_fallback_places[i];
    s_focus = 0;
}

// ---------------------------------------------------------------------------
// 绘制（全部在 ui_render 的 paint 回调里，全局坐标）
// ---------------------------------------------------------------------------

// 状态栏：时间 / 网络点 / 待提交数 / 电量
static void paint_status(void *user)
{
    (void)user;
    int hh, mm;
    char buf[24];
    if (net_link_time_hhmm(&hh, &mm)) {
        snprintf(buf, sizeof buf, "%02d:%02d", hh, mm);
        ui_text(4, 2, buf, UI_COL_SOFT);
    } else {
        ui_text(4, 2, "--:--", UI_COL_DIM);
    }

    const net_state_t ns = net_link_state();
    const uint16_t dot = ns == NET_ONLINE ? UI_COL_GREEN
                       : ns == NET_CONNECTING ? UI_COL_ORANGE : UI_COL_DIM;
    ui_fill(112, 6, 10, 10, dot);

    const int pending = obs_store_count();
    if (pending > 0) {
        snprintf(buf, sizeof buf, "待%d", pending);
        ui_text(128, 2, buf, UI_COL_ORANGE);
    }

    if (s_bat_soc >= 0) {
        snprintf(buf, sizeof buf, "%d%%", s_bat_soc);
        ui_text(UI_W - 4 - ui_text_width(buf), 2, buf, UI_COL_TEAL);
    } else {
        ui_text(UI_W - 4 - ui_text_width("--"), 2, "--", UI_COL_DIM);
    }
    ui_fill(0, 26, UI_W, 1, UI_COL_LINE);
}

static void paint_footer(const char *hint)
{
    ui_fill(0, UI_H - 24, UI_W, 1, UI_COL_LINE);
    ui_text(4, UI_H - 20, hint, UI_COL_MUTED);
}

static void paint_title(const char *text)
{
    ui_fill(8, 34, 6, 16, UI_COL_TEAL);
    ui_text(20, 32, text, UI_COL_FG);
}

typedef struct { int focus; } places_ctx_t;

static void paint_places(void *user)
{
    ui_clear(UI_COL_BG);
    paint_status(NULL);
    paint_title("选择地点");
    places_ctx_t *ctx = (places_ctx_t *)user;
    for (int i = 0; i < s_place_count; i++) {
        const int y = 60 + i * 28;
        const bool focus = (i == ctx->focus);
        if (focus) ui_fill(4, y - 4, UI_W - 8, 26, UI_COL_ROW_BG);
        ui_text(12, y, s_places[i].name, focus ? UI_COL_YELLOW : UI_COL_FG);
        const char *tag = kind_label(s_places[i].kind);
        ui_text(UI_W - 12 - ui_text_width(tag), y, tag, UI_COL_MUTED);
    }
    if (s_place_count == 0) {
        ui_text(12, 60, "无地点（长按OK刷新）", UI_COL_MUTED);
    }
    paint_footer("▲▼ 选择  OK 进入  长按OK刷新");
}

static void paint_park_min(void *user)
{
    (void)user;
    ui_clear(UI_COL_BG);
    paint_status(NULL);
    paint_title("停车数量·最少");
    char num[8];
    int v = s_park_min;
    if (v < 0) v = 0;
    if (v > 9999) v = 9999;
    snprintf(num, sizeof num, "%d", v);
    ui_digits((UI_W - ui_digits_width(num)) / 2, 110, num, UI_COL_YELLOW);
    paint_footer("▲▼ 调1  长按±10  OK 下一步");
}

static void paint_park_max(void *user)
{
    (void)user;
    ui_clear(UI_COL_BG);
    paint_status(NULL);
    paint_title("停车数量·最多");
    char num[8];
    int v = s_park_max;
    if (v < 0) v = 0;
    if (v > 9999) v = 9999;
    snprintf(num, sizeof num, "%d", v);
    ui_digits((UI_W - ui_digits_width(num)) / 2, 110, num, UI_COL_YELLOW);
    char lo[24];
    snprintf(lo, sizeof lo, "最少 %d", s_park_min);
    ui_text((UI_W - ui_text_width(lo)) / 2, 190, lo, UI_COL_MUTED);
    paint_footer("▲▼ 调1  长按±10  OK 确认");
}

static void paint_elev_ready(void *user)
{
    (void)user;
    ui_clear(UI_COL_BG);
    paint_status(NULL);
    paint_title("候梯计时");
    ui_text(12, 100, "按 OK 开始等待", UI_COL_SOFT);
    ui_text(12, 126, "电梯到达再按 OK", UI_COL_SOFT);
    paint_footer("OK 开始  ▲▼ 返回");
}

static void paint_elev_run(void *user)
{
    (void)user;
    ui_clear(UI_COL_BG);
    paint_status(NULL);
    paint_title("候梯计时");
    int secs = (int)((esp_timer_get_time() - s_elev_start_us) / 1000000);
    if (secs < 0) secs = 0;
    if (secs > 7200) secs = 7200;
    char num[8];
    snprintf(num, sizeof num, "%d", secs);
    ui_digits((UI_W - ui_digits_width(num)) / 2, 110, num, UI_COL_ORANGE);
    ui_text((UI_W - ui_text_width("秒")) / 2, 190, "秒", UI_COL_MUTED);
    paint_footer("OK 结束计时  ▲▼ 取消");
}

static void paint_confirm(void *user)
{
    (void)user;
    ui_clear(UI_COL_BG);
    paint_status(NULL);
    paint_title("确认提交");
    ui_text(12, 64, s_places[s_focus].name, UI_COL_FG);
    char line[40];
    if (strcmp(s_places[s_focus].kind, "parking") == 0) {
        snprintf(line, sizeof line, "停车 %d - %d 辆", s_park_min, s_park_max);
    } else {
        snprintf(line, sizeof line, "候梯 %d 秒", s_wait_seconds);
    }
    ui_text(12, 92, line, UI_COL_YELLOW);
    if (!net_link_time_synced()) {
        ui_text(12, 120, "时间未同步 无法提交", UI_COL_RED);
    }
    paint_footer("OK 提交  ▲▼ 返回修改");
}

static void paint_submitting(void *user)
{
    (void)user;
    ui_clear(UI_COL_BG);
    paint_status(NULL);
    paint_title("提交中");
    ui_text(12, 100, "正在连接并提交", UI_COL_SOFT);
    ui_text(12, 126, "最长约一分钟", UI_COL_MUTED);
}

static void paint_result(void *user)
{
    (void)user;
    ui_clear(UI_COL_BG);
    paint_status(NULL);
    paint_title("结果");
    const char *l1 = "";
    const char *l2 = "";
    uint16_t col = UI_COL_FG;
    static char http_line[24];
    switch (s_result) {
    case RS_SUBMITTED:
        l1 = "已提交（服务器确认）"; col = UI_COL_GREEN;
        break;
    case RS_QUEUED:
        l1 = "已入队待提交"; col = UI_COL_ORANGE;
        l2 = "联网后自动重试";
        break;
    case RS_NO_NET:
        l1 = "无网络 队列已满"; col = UI_COL_RED;
        l2 = "记录未保存 请重记";
        break;
    case RS_NO_TIME:
        l1 = "时间未同步"; col = UI_COL_RED;
        l2 = "联网对时后再提交";
        break;
    case RS_REJECTED:
        snprintf(http_line, sizeof http_line, "服务器拒绝 %d", s_result_http);
        l1 = http_line; col = UI_COL_RED;
        l2 = "检查令牌与契约";
        break;
    default: break;
    }
    ui_text(12, 92, l1, col);
    ui_text(12, 118, l2, UI_COL_SOFT);
    paint_footer("OK 返回地点列表");
}

static void redraw(void)
{
    ui_paint_fn paint = paint_places;
    places_ctx_t ctx = { .focus = s_focus };
    void *user = &ctx;
    switch (s_st) {
    case ST_PLACES:     paint = paint_places; break;
    case ST_PARK_MIN:   paint = paint_park_min;   user = NULL; break;
    case ST_PARK_MAX:   paint = paint_park_max;   user = NULL; break;
    case ST_ELEV_READY: paint = paint_elev_ready; user = NULL; break;
    case ST_ELEV_RUN:   paint = paint_elev_run;   user = NULL; break;
    case ST_CONFIRM:    paint = paint_confirm;    user = NULL; break;
    case ST_SUBMITTING: paint = paint_submitting; user = NULL; break;
    case ST_RESULT:     paint = paint_result;     user = NULL; break;
    }
    ui_render((ui_rect_t){ 0, 0, UI_W, UI_H }, paint, user);
}

// ---------------------------------------------------------------------------
// 提交（在页面任务里同步执行；提交期间按键被忽略）
// ---------------------------------------------------------------------------

static void build_pending_json(void)
{
    char id[37];
    char ts[32];
    uuid_v4(id);
    net_link_utc_now(ts, sizeof ts);   // 调用前已确认时间同步
    if (strcmp(s_places[s_focus].kind, "parking") == 0) {
        snprintf(s_pending_json, sizeof s_pending_json,
                 "{\"id\":\"%s\",\"place_id\":\"%s\",\"kind\":\"parking\","
                 "\"observed_at\":\"%s\",\"parking_min\":%d,\"parking_max\":%d}",
                 id, s_places[s_focus].id, ts, s_park_min, s_park_max);
    } else {
        snprintf(s_pending_json, sizeof s_pending_json,
                 "{\"id\":\"%s\",\"place_id\":\"%s\",\"kind\":\"elevator\","
                 "\"observed_at\":\"%s\",\"wait_seconds\":%d}",
                 id, s_places[s_focus].id, ts, s_wait_seconds);
    }
}

static void do_submit(void)
{
    if (!net_link_time_synced()) {
        // observed_at 必须是真实 UTC 观察时刻；时间不可信时拒绝编造。
        // 先尝试连网对时，仍不可信才拒绝。
        if (!net_link_ensure(30000) || !net_link_time_synced()) {
            net_link_release();
            s_result = RS_NO_TIME;
            return;
        }
    }
    build_pending_json();

    int http = 0;
    if (net_link_ensure(60000)) {
        http = obs_api_post_observation(s_pending_json);
        net_link_release();
    }
    if (http == 201 || http == 200) {
        s_result = RS_SUBMITTED;   // 200 = 同 ID 重试确认，也算服务器确认
    } else if (http >= 400) {
        // 4xx/5xx 是服务器明确答复：入队重试没有意义（409/校验错误不会自愈）。
        s_result = RS_REJECTED;
        s_result_http = http;
    } else {
        // 网络层失败：入队兜底。队列满则明确告知记录未保存。
        s_result = obs_store_put(s_pending_json) ? RS_QUEUED : RS_NO_NET;
    }
    ESP_LOGI(TAG, "提交结果=%d http=%d", (int)s_result, http);
}

// 后台重试：有待提交记录且网络可用时逐条重传。
// 服务器按 UUID 幂等去重（重复提交返回 200），重试不产生重复记录。
static void flush_outbox(void)
{
    if (obs_store_count() == 0) return;
    if (!net_link_ensure(30000)) {
        net_link_release();
        return;
    }
    static char blob[OBS_STORE_BLOB_MAX];
    for (int i = 0; i < obs_store_count(); i++) {
        if (!obs_store_get(i, blob, sizeof blob)) break;
        const int http = obs_api_post_observation(blob);
        if (http == 201 || http == 200 || (http >= 400 && http < 500)) {
            // 成功或明确拒绝都出队：拒绝的记录重试也不会成功，
            // 留着只会反复消耗电量。拒绝原因已打在日志里。
            char id[37] = {0};
            const char *p = strstr(blob, "\"id\":\"");
            if (p) {
                p += 6;
                if (strlen(p) >= 36) memcpy(id, p, 36);
            }
            if (id[0]) {
                obs_store_remove(id);
                i--;   // 槽位重排后重读同一序号
            }
            if (http >= 400) ESP_LOGW(TAG, "队列记录被服务器拒绝(%d)，已丢弃", http);
        } else {
            break;   // 网络层失败：下轮再来
        }
    }
    net_link_release();
}

// ---------------------------------------------------------------------------
// 按键处理（页面任务上下文）
// ---------------------------------------------------------------------------

static void adjust_value(int *v, bsp_btn_t btn, bsp_btn_ev_t ev, int lo, int hi)
{
    int step = 0;
    if (ev == BSP_BTN_CLICK) step = (btn == BSP_BTN_UP) ? 1 : -1;
    if (ev == BSP_BTN_LONG)  step = (btn == BSP_BTN_UP) ? 10 : -10;
    if (step == 0) return;
    *v += step;
    if (*v < lo) *v = lo;
    if (*v > hi) *v = hi;
    s_dirty = true;
}

static void refresh_places(void)
{
    if (!net_link_ensure(30000)) {
        net_link_release();
        ESP_LOGW(TAG, "刷新地点失败：无网络");
        return;
    }
    obs_place_t fresh[OBS_PLACE_MAX];
    const int n = obs_api_fetch_places(fresh, OBS_PLACE_MAX);
    net_link_release();
    if (n > 0) {
        memcpy(s_places, fresh, sizeof(obs_place_t) * n);
        s_place_count = n;
        if (s_focus >= s_place_count) s_focus = s_place_count - 1;
        ESP_LOGI(TAG, "地点列表已刷新：%d 个", n);
    }
    s_dirty = true;
}

static void on_key(bsp_btn_t btn, bsp_btn_ev_t ev)
{
    // 只响应单击与长按；按下/抬起/双击不驱动状态机。
    if (ev != BSP_BTN_CLICK && ev != BSP_BTN_LONG) return;
    if (s_st == ST_SUBMITTING) return;

    switch (s_st) {
    case ST_PLACES:
        if (btn == BSP_BTN_OK && ev == BSP_BTN_LONG) {
            refresh_places();
            break;
        }
        if (ev == BSP_BTN_CLICK && s_place_count > 0) {
            if (btn == BSP_BTN_UP) {
                s_focus = (s_focus - 1 + s_place_count) % s_place_count;
                s_dirty = true;
            } else if (btn == BSP_BTN_DOWN) {
                s_focus = (s_focus + 1) % s_place_count;
                s_dirty = true;
            } else if (btn == BSP_BTN_OK) {
                const char *kind = s_places[s_focus].kind;
                if (strcmp(kind, "parking") == 0) {
                    s_park_min = 0;
                    s_park_max = 0;
                    s_st = ST_PARK_MIN;
                } else if (strcmp(kind, "elevator") == 0) {
                    s_st = ST_ELEV_READY;
                }
                // activity 地点：仅传感器观测，无人工记录入口
                s_dirty = true;
            }
        }
        break;

    case ST_PARK_MIN:
        if (btn == BSP_BTN_OK && ev == BSP_BTN_CLICK) {
            s_park_max = s_park_min;
            s_st = ST_PARK_MAX;
            s_dirty = true;
        } else {
            adjust_value(&s_park_min, btn, ev, 0, 9999);
        }
        break;

    case ST_PARK_MAX:
        if (btn == BSP_BTN_OK && ev == BSP_BTN_CLICK) {
            s_st = ST_CONFIRM;
            s_dirty = true;
        } else {
            // 契约要求 min <= max：下限跟着已选的最少走
            adjust_value(&s_park_max, btn, ev, s_park_min, 10000);
        }
        break;

    case ST_ELEV_READY:
        if (btn == BSP_BTN_OK && ev == BSP_BTN_CLICK) {
            s_elev_start_us = esp_timer_get_time();
            s_st = ST_ELEV_RUN;
            s_dirty = true;
        } else if ((btn == BSP_BTN_UP || btn == BSP_BTN_DOWN) && ev == BSP_BTN_CLICK) {
            s_st = ST_PLACES;
            s_dirty = true;
        }
        break;

    case ST_ELEV_RUN:
        if (btn == BSP_BTN_OK && ev == BSP_BTN_CLICK) {
            const int64_t us = esp_timer_get_time() - s_elev_start_us;
            s_wait_seconds = (int)(us / 1000000);
            if (s_wait_seconds > 7200) s_wait_seconds = 7200;  // 契约上限
            s_st = ST_CONFIRM;
            s_dirty = true;
        } else if ((btn == BSP_BTN_UP || btn == BSP_BTN_DOWN) && ev == BSP_BTN_CLICK) {
            s_st = ST_ELEV_READY;
            s_dirty = true;
        }
        break;

    case ST_CONFIRM:
        if (btn == BSP_BTN_OK && ev == BSP_BTN_CLICK) {
            s_st = ST_SUBMITTING;
            redraw();   // 先画「提交中」再阻塞提交
            do_submit();
            s_st = ST_RESULT;
            s_dirty = true;
        } else if ((btn == BSP_BTN_UP || btn == BSP_BTN_DOWN) && ev == BSP_BTN_CLICK) {
            // 返回对应录入页修改
            s_st = strcmp(s_places[s_focus].kind, "parking") == 0
                 ? ST_PARK_MIN : ST_ELEV_READY;
            s_dirty = true;
        }
        break;

    case ST_RESULT:
        if (btn == BSP_BTN_OK && ev == BSP_BTN_CLICK) {
            s_st = ST_PLACES;
            s_dirty = true;
        }
        break;

    default:
        break;
    }
}

// ---------------------------------------------------------------------------
// 页面任务：按键队列 + 周期刷新（计时数字 / 状态栏时钟 / 电量 / 队列重试）
// ---------------------------------------------------------------------------

#define TICK_MS          250
#define BAT_REFRESH_US   (30LL * 1000 * 1000)
#define CLOCK_REFRESH_US (20LL * 1000 * 1000)
#define FLUSH_EVERY_US   (20LL * 1000 * 1000)

static void page_task(void *arg)
{
    (void)arg;
    key_msg_t msg;
    int last_secs = -1;
    int last_clock = -1;
    int64_t flush_next_us = esp_timer_get_time() + 10LL * 1000 * 1000;
    for (;;) {
        if (xQueueReceive(s_key_queue, &msg, pdMS_TO_TICKS(TICK_MS)) == pdTRUE) {
            on_key(msg.btn, msg.ev);
        }
        // 计时中每秒重画数字
        if (s_st == ST_ELEV_RUN) {
            const int secs = (int)((esp_timer_get_time() - s_elev_start_us) / 1000000);
            if (secs != last_secs) {
                last_secs = secs;
                s_dirty = true;
            }
        }
        // 状态栏时钟
        int hh, mm;
        if (net_link_time_hhmm(&hh, &mm)) {
            if (hh * 60 + mm != last_clock) {
                last_clock = hh * 60 + mm;
                s_dirty = true;
            }
        }
        // 电量
        if (esp_timer_get_time() >= s_bat_next_us) {
            s_bat_soc = bsp_battery_soc();
            s_bat_next_us = esp_timer_get_time() + BAT_REFRESH_US;
            s_dirty = true;
        }
        // 待提交队列重试
        if (esp_timer_get_time() >= flush_next_us) {
            flush_next_us = esp_timer_get_time() + FLUSH_EVERY_US;
            flush_outbox();
            s_dirty = true;   // 待提交计数可能变了
        }
        if (s_dirty) {
            s_dirty = false;
            redraw();
        }
    }
}

void page_term_start(void)
{
    static bool started;
    if (started) return;
    started = true;
    load_fallback_places();
    s_key_queue = xQueueCreate(8, sizeof(key_msg_t));
    xTaskCreate(page_task, "page_term", 4096, NULL, 5, NULL);
}

void page_term_key(bsp_btn_t btn, bsp_btn_ev_t ev)
{
    if (!s_key_queue) return;
    const key_msg_t msg = { .btn = btn, .ev = ev };
    (void)xQueueSend(s_key_queue, &msg, 0);
}
