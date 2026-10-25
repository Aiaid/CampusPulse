// main/scan_ble.c —— NimBLE Observer 扫描实现。
//
// 结构参考官方 demo_ble.c 的启停方式（自己建 host 任务、显式 deinit），
// 但角色换成 Observer：只监听广播，不发起连接。
//
// 线程模型：
//   NimBLE host 任务 → on_disc() 只做"提取身份键 + 写表"，不碰 LVGL。
//   maintenance 任务 → 独立时钟推进诊断表，发布有界快照。
//   LVGL 定时器      → scan_ble_snapshot() 只拷贝已发布数据。
// 默认路径使用短临界区；可选标定保存/日志可能延长持锁，丢包有独立计数。
#include "scan_ble.h"
#include "local_policy.h"

#include "dev_class.h"
#include "dev_diag.h"
#include "scan_stats.h"
#include "scan_maintenance.h"
#include "demo_radio.h"

#include "esp_log.h"
#include "esp_system.h"   // esp_get_free_heap_size / esp_get_minimum_free_heap_size
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "host/ble_gap.h"
#include "host/ble_hs.h"
#include "host/util/util.h"
#include "nimble/nimble_port.h"
#include "services/gap/ble_svc_gap.h"
#include "services/gatt/ble_svc_gatt.h"
#include <string.h>

static const char *TAG = "scan_ble";

// 扫描窗口 30ms / 间隔 30ms = 占空比 100%，持续监听不喘气。
// 代价是射频常开、耗电明显；如果要省电，把 interval 改大（如 60/30）。
#define SCAN_ITF_WINDOW_MS   30
#define SCAN_ITF_INTERVAL_MS 30

// 屏幕最多看 6 条，快照里别存更多。
#define SNAPSHOT_TOP_N 6
#define MAINTENANCE_MS 100
#define STATS_SAVE_MS 30000
#define VEHICLE_DUMP_MS 5000

// 同一设备两次写入表的间隔控制（见 on_disc 里的说明）。
//
// 【为什么要有两个门限】原来只有一个 2500ms 的按 MAC 门限，后果是：
// 一台设备 2.5 秒内的后续包**整包丢弃**，而 BLE 的名字通常放在 SCAN_RSP 里、
// 跟 ADV 是两个不同的包。如果先到的 ADV 不带名字，后面那个带名字的
// SCAN_RSP 就被门限吃掉了 —— 名字永远收不到。
//
// 车棚实测证实了这一点：3934 个包里 93%（3674 个）没有名字，
// 台铃用的 BandSpeed 模组（manu=0x0020）无名 350 包、有名只有 36 包。
//
// 现在拆成两层：
//   * 200ms 硬门限：同一 MAC 的包太密就丢，纯粹为了压住负载；
//   * 2500ms 软门限：**只有载荷指纹相同**才丢。不同的内容（ADV vs SCAN_RSP、
//     iOS 轮换的多种 Continuity 消息）一律放行。
//
// 代价是 host 侧包量上升（实测从 265 包/秒涨到 400~600），
// 换来的是名字能收全 —— 而"有没有名字"正是识别电动车的主要依据。
#define DUP_GATE_MS 2500
#define DUP_GATE_HARD_MS 200

static TaskHandle_t s_host_task;
static SemaphoreHandle_t s_host_stopped;
static TaskHandle_t s_maintenance_task;
static SemaphoreHandle_t s_maintenance_stopped;
static bool s_maintenance_stop;
static bool s_stopping;
// Protected by s_lock. Inherited counts/classifiers are diagnostic only.
static scan_snapshot_t s_published;
static uint32_t s_maintenance_ticks;
static uint32_t s_maintenance_lock_skips;
static SemaphoreHandle_t s_lock;   // 保护 s_table
static scan_table_t s_table;
static uint8_t s_own_addr_type;
static volatile bool s_running;
static volatile bool s_sniff;      // 串口标定日志开关

// PHONE 采样开关（见 scan_ble.h）。默认开。
static bool s_phone_on = true;
static volatile int s_last_error;
static bool s_initialized;
static bool s_stop_in_progress;
static bool s_host_done;
static volatile bool s_suspended;

// 连续监听起点。任何一次 stop 都会清 0，restart 时重新计时。
static volatile uint32_t s_run_start_ms;

// 电动车证据位（EVID_*）。0 = 关闭车判定。
// volatile：UI 任务写，扫描回调读，单字节访问在 RV32 上是原子的。
static volatile uint8_t s_evidence_mask;

// 是否已经初始化过证据位。只用于"首次启动给全开默认值"这一次判断。
static bool s_evidence_inited;

// 证据掩码最后一次被改动的时间。电动车结果要等到
// "改动时刻 + SCAN_VEHICLE_DWELL_MS" 之后才可信——因为所有设备的
// 计时都被重置了，最早也得等这么久才可能凑够 30 秒。
static volatile uint32_t s_evidence_set_ms;

// 上一次（换判据那一刻）算出的车数。改 mask 时顺手算一次并打日志，
// 让串口能直接回答"这条判据到底改变了几个数"。
static int s_last_evidence_count = -1;

// 收包统计。只为了在 UI 上告诉用户"数字可不可信"。
static volatile uint32_t s_pkt_count;
static volatile uint32_t s_pkt_per_sec;
static uint32_t s_rate_ref_ms; // Worker/reset only, protected by s_lock.
static uint32_t s_rate_ref_pkts;
// Count every observation lost because a reader/maintenance owns the mutex.
static uint32_t s_lock_drops;

static uint32_t now_ms(void)
{
    return (uint32_t)(esp_timer_get_time() / 1000);
}

// ---------------------------------------------------------------------------
// 广播数据解析（AD 结构：len, type, data...）
// ---------------------------------------------------------------------------
#define AD_TYPE_SHORT_NAME   0x08
#define AD_TYPE_FULL_NAME    0x09
#define AD_TYPE_MANU_DATA    0xFF
#define AD_TYPE_TX_POWER     0x0A

// 从广播载荷里抠出可读名。返回名字字节数（0 = 没有）。
// 只认 0x08/0x09，这是规范里唯一能直接当字符串用的类型。

// 取第一个 Manufacturer Data 的厂商 ID（小端 16 位）。返回 -1 表示没有。

// 扫一遍 AD 列表，算出"这一包含哪些 AD Type"和第一个 0x16 的 service UUID。
//
// 为什么要这个：实验室屏幕上数出的 4 台"电动车"全是打印机，
// 而 type/len/manu_len/name 这些字段跟真车**完全一样**——判据无论怎么调参数
// 都分不开。唯一有希望的是 AD 结构本身：
//   真车   ：0x09 完整名（车架号）+ 0xFF 厂商数据 + 可能 0x16
//   打印机 ：0x01 Flags + 0x09 名字（得力），或 Flags + 0x16 member service（HP）
// 但真车的 AD 结构我们**一次都没抓到过**（车棚那几趟只存了 [STAT] 汇总）。
// 所以先把画像记进累计表，下次带着设备走一趟就能直接对比。

// 本机地址打印用。NimBLE 的 val[] 是小端，倒序才是人看的顺序。
static void fmt_addr(const uint8_t v[6], char *out)
{
#if defined(__GNUC__)
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wformat-truncation"
#endif
    snprintf(out, 18, "%02X:%02X:%02X:%02X:%02X:%02X",
             v[5], v[4], v[3], v[2], v[1], v[0]);
#if defined(__GNUC__)
#pragma GCC diagnostic pop
#endif
}

// ---------------------------------------------------------------------------
// 扫描事件回调：运行在 NimBLE host 任务里。只允许极轻量的操作。
// ---------------------------------------------------------------------------
static int on_disc(struct ble_gap_event *event, void *arg)
{
    (void)arg;
    if (event->type != BLE_GAP_EVENT_DISC) return 0;

    const struct ble_gap_disc_desc *d = &event->disc;

    // Callback never waits for table/UI/storage work. Rate ages on the worker,
    // including intervals with no reports at all.
    const uint32_t packet = __atomic_add_fetch(&s_pkt_count, 1u, __ATOMIC_RELAXED);
    uint32_t t = now_ms();

    // 身份键：地址规范化成大端；匿名广播（全 0 地址）用合成键。
    uint8_t key[SCAN_KEY_LEN];
    bool is_anon = true;
    for (size_t i = 0; i < SCAN_KEY_LEN; i++) {
        if (d->addr.val[i] != 0) { is_anon = false; break; }
    }
    if (is_anon) {
        scan_table_make_anon_key(packet, d->event_type, key);
    } else {
        scan_table_make_key(d->addr.val, d->addr.type, key);
    }

    // ---- 解析一次，全流程复用 ----
    //
    // 以前这里有三个各自独立的 AD 遍历（extract_name / extract_manu_id /
    // extract_ad_profile）+ 判定前又一次 scan_class_parse，同一份载荷被走了四遍。
    // 现在只有 ad_parse() 一份，边界处理只写一次。
    //
    // 放在锁外面：parse 是纯计算，不碰共享状态，早一点做完少占着锁。
    scan_facts_t facts;
    ad_parse(d->data, d->length_data, &facts);
    const bool connectable = (d->event_type == BLE_HCI_ADV_RPT_EVTYPE_ADV_IND ||
                              d->event_type == BLE_HCI_ADV_RPT_EVTYPE_DIR_IND);
    facts.connectable = connectable;
    const char *name = facts.name;
    const uint8_t name_len = facts.name_len;
    bool cls_is_phone = false;

    // 指纹只对"短期载荷"有意义：太长的包多半带动态厂商数据，不稳定。
    uint16_t fp = is_anon ? 0 : scan_table_fingerprint(d->data, d->length_data);

    // 串口标定日志。放在取锁之前，避免和 UI 线程互相等待。
    if (CAMPUSPULSE_CALIBRATION_RAW_LOGS && s_sniff) {
        char mac[18];
        char why[96];
        fmt_addr(d->addr.val, mac);
        dev_diag_describe(&facts, why, sizeof(why));
        // sub= Apple Continuity 子类型；phone= 是**这一包单独**判出来的结果。
        //
        // phone= 和表里的 cls 不是一回事：表里的 cls 允许"后续包升级为手机"，
        // 这里看的是这一包自己够不够。手机数异常时靠它一眼分清两种情况：
        //   sub=0x0F/0x10 但 phone=0  -> 判定规则出了问题
        //   sub=0x05/0x0A     phone=0  -> 这包本来就不该算手机，包轮换没被收到
        // 候选车的原始 AD 字节。只在"可连接 + 厂商数据很短"时输出。
        //
        // 【为什么需要】实验室里屏幕上数出 4 台"电动车"，日志上
        // type/len/mlen/name 这些字段和真车完全一样，实际是一台得力标签打印机
        // 加 3 台 HP 设备。所有已记录的字段都无法区分它们，只能看 AD 结构：
        // 真车靠 0x09(完整名)/0xFF(厂商数据)/0x16(service data) 传车架号，
        // 打印机多半带 0x03/0x0A、128 位 UUID 或 nothing。
        //
        // 只在候选上打印，且每包都打（约 5 包/秒/台），日志量可控。
        char raw[110];
        raw[0] = '\0';
        if (connectable && facts.manu_len < SCAN_MANU_LONG_LEN) {
            int k = snprintf(raw, sizeof(raw), " ad=");
            const int n = d->length_data > 31 ? 31 : (int)d->length_data;
            for (int i = 0; i < n && k < (int)sizeof(raw) - 3; i++) {
                k += snprintf(raw + k, sizeof(raw) - (size_t)k, "%02X",
                              d->data[i]);
            }
        }

        ESP_LOGI(TAG, "%s rssi=%d type=0x%02X len=%d fp=%04X name=\"%.*s\" | %s sub=0x%02X phone=%d%s",
                 mac, d->rssi, d->event_type, d->length_data, fp,
                 (int)name_len, name ? name : "", why,
                 (unsigned)facts.apple_subtype, (int)dev_phone_is_phone(&facts), raw);
    }

    // The worker prunes slots: duplicate lookup must share its zero-wait lock.
    // 重复包门限。关掉控制器级去重后，一台设备每秒会送来好几包，
    // 全量写表没意义——表里的 last_seen 只要在窗口内有更新就行。
    // 2.5s 既远小于在场窗口，又能把 host 负载压下来。
    if (!is_anon) {
        if (xSemaphoreTake(s_lock, 0) != pdTRUE) {
            __atomic_add_fetch(&s_lock_drops, 1u, __ATOMIC_RELAXED);
            return 0;
        }
        int dup_slot = scan_table_find(&s_table, key);
        if (dup_slot >= 0) {
            const uint32_t age =
                (uint32_t)(t - s_table.entries[dup_slot].last_seen_ms);
            // 太密：无条件丢，纯粹压负载。
            //
            // **但 SCAN_RSP（event_type=0x04）必须放行**：它通常在收到
            // SCAN_REQ 后几十毫秒就返回，正好落在 200ms 硬门限里面。
            // 而设备名几乎只出现在 SCAN_RSP 里 —— 卡这一下，等于把名字全丢了。
            //
            // 实测代价：车棚横排往返一圈，199 台设备里只有 16 台拿到名字，
            // 一横排的车远不止这个数。根因就是这里。
            if (d->event_type != 0x04 && age < DUP_GATE_HARD_MS) {
                xSemaphoreGive(s_lock);
                return 0;
            }
            // 同一个 MAC 但内容完全相同：没带来新信息，丢掉
            if (age < DUP_GATE_MS && s_table.entries[dup_slot].fp == fp) {
                xSemaphoreGive(s_lock);
                return 0;
            }
            // 内容不同 -> 放行。SCAN_RSP 里的名字就是靠这一行才收得到。
        }
        xSemaphoreGive(s_lock);
    }

    // facts 已经在函数开头解析过了，这里直接复用（省一次遍历）。
    // ---- 采样开关 ----
    //
    // 每包解析里最贵的两段是"拿设备名做十几次大小写无关的子串比较"：
    //   dev_phone_is_phone()      （is_phone 内部 + 名字兜底）
    //   dev_phone_is_peripheral() （24 个关键词 × 子串匹配）
    // 两个开关就是用来砍这两段的。
    //
    // 【为什么 PHONE 关掉时 is_phone 还不能省】
    // 手机判定不只用于显示手机数——它同时是车判据的硬排除条件
    // （"是手机就不算车"）。如果 E-BIKE 还开着却跳过 is_phone，
    // 所有手机都会落进"非手机"桶，车数会立刻虚高。
    // 所以只有当**两个开关都关掉**时才真正省掉这一段。
    const bool ebike_on = (s_evidence_mask != 0);
    const bool need_phone = s_phone_on || ebike_on;

    cls_is_phone = need_phone ? dev_phone_is_phone(&facts) : false;
    uint8_t evidence = veh_rules_evidence(&facts);
    bool peripheral = ebike_on ? dev_phone_is_peripheral(&facts) : false;
    uint8_t advertiser = dev_phone_advertiser(&facts);

    if (xSemaphoreTake(s_lock, 0) != pdTRUE) {
        // The UI/maintenance/calibration may own the table: record every
        // contention loss and return immediately, never wait in the host.
        __atomic_add_fetch(&s_lock_drops, 1u, __ATOMIC_RELAXED);
        return 0;
    }
    scan_table_observe_classified(&s_table, key, is_anon, d->rssi, name, name_len,
                                  fp, facts.manu_id, facts.has_manu,
                                  cls_is_phone, connectable, evidence, peripheral,
                                  advertiser, t);

    // 离线标定用的累计表。它**不按时间过期**，所以"带着设备去车棚转一圈、
    // 回来插电脑看"这个用法才成立（扫描表 10 秒就滚掉了，撑不到回来）。
    // 放在锁内：它会被 UI 任务读，和 s_table 用同一把锁最省事。
    // 按 MAC 记账（v2）。key 就是规范化后的 6 字节地址，正好当主键。
    // AD 画像（ad_type_mask / svc16）由 ad_parse 顺手算好，这里直接用。
    scan_stats_note(key, facts.has_manu, facts.manu_id, name, name_len,
                    d->rssi, d->event_type, facts.manu_len,
                    facts.has_uuid128, evidence, cls_is_phone,
                    facts.ad_type_mask, facts.svc16);

    xSemaphoreGive(s_lock);
    return 0;
}

static void start_scan(void)
{
    if (__atomic_load_n(&s_stopping, __ATOMIC_ACQUIRE)) return;
    struct ble_gap_disc_params params = { 0 };
    params.itvl = SCAN_ITF_INTERVAL_MS * 1000 / 625;   // BLE 时间单位 0.625ms
    params.window = SCAN_ITF_WINDOW_MS * 1000 / 625;
    params.filter_duplicates = 0;   // 不过滤：让每包都上来，否则按地址去重后
                                    // 拿不到同一个设备后续包里的名字。代价由
                                    // DUP_GATE_MS 在 host 侧吸收。
    // 主动扫描：会发 SCAN_REQ 索要 SCAN_RSP。ANSI C 里没有混合模式，
    // 要么只被动、要么主动（主动也收得到普通广播）。选主动是因为：
    //   1) 大量设备的名字、部分厂商数据只在 SCAN_RSP 里；
    //   2) 被动扫描在真实环境里会系统性低估设备数。
    // 代价是每台设备多一次扫描请求，对周边干扰很小（功耗在对方身上）。
    params.passive = 0;
    params.limited = 0;

    int rc = ble_gap_disc(s_own_addr_type, BLE_HS_FOREVER, &params, on_disc, NULL);
    if (rc == 0) {
        // Stop may have begun while NimBLE accepted the discovery request.
        if (__atomic_load_n(&s_stopping, __ATOMIC_ACQUIRE)) {
            (void)ble_gap_disc_cancel();
            return;
        }
        s_running = true;
        s_suspended = false;
        s_run_start_ms = now_ms();
        ESP_LOGI(TAG, "扫描已启动 window=%d itvl=%d dup_gate=%dms passive=%d",
                 SCAN_ITF_WINDOW_MS, SCAN_ITF_INTERVAL_MS, DUP_GATE_MS, params.passive);
    } else {
        s_last_error = rc;
        ESP_LOGE(TAG, "ble_gap_disc 失败: %d", rc);
    }
}

static void on_reset(int reason)
{
    s_last_error = reason;
    s_running = false;
    ESP_LOGE(TAG, "NimBLE reset, reason=%d", reason);
}

static void on_sync(void)
{
    int rc = ble_hs_util_ensure_addr(0);
    if (rc == 0) rc = ble_hs_id_infer_auto(0, &s_own_addr_type);
    if (rc != 0) {
        s_last_error = rc;
        ESP_LOGE(TAG, "地址初始化失败: %d", rc);
        return;
    }
    start_scan();
}

static void host_task(void *arg)
{
    (void)arg;
    nimble_port_run();
    xSemaphoreGive(s_host_stopped);
    for (;;) vTaskSuspend(NULL);
}

// Called with s_lock held. Queries with inherited diagnostic hysteresis also
// run here; the UI reads a fixed-size projection instead of touching the table.
static void publish_table(uint32_t t)
{
    scan_snapshot_t next = {0};
    next.live_count = scan_table_count(&s_table, t);
    next.live_short = scan_table_count_window(&s_table, t, SCAN_SHORT_WINDOW_MS);
    next.live_wide = scan_table_count_window(&s_table, t, SCAN_ACTIVE_WINDOW_MS);
    next.phone_on = s_phone_on;
    // 关掉时不调用计数函数：省的是每帧 384 条遍历（很便宜，但没必要）。
    next.phone_count = s_phone_on ? scan_table_count_phone(&s_table, t) : 0;
    next.evidence_mask = s_evidence_mask;
    next.vehicle_count = scan_table_count_vehicle(&s_table, t, s_evidence_mask);
    // 只判车时才需要它；开关关着就别白遍历一遍 384 槽。
    next.vehicle_maybe = (s_evidence_mask != 0)
                             ? scan_table_count_vehicle_maybe(&s_table, t,
                                                              s_evidence_mask)
                             : 0;

    // "其中 M 台是 Apple/Google 广播的"——车数明显不对时的第一诊断线索。
    next.vehicle_apple = scan_table_count_vehicle_kind(&s_table, t, s_evidence_mask,
                                                       ADV_KIND_APPLE);
    next.vehicle_google = scan_table_count_vehicle_kind(&s_table, t, s_evidence_mask,
                                                        ADV_KIND_GOOGLE);
    next.vehicle_samsung = scan_table_count_vehicle_kind(&s_table, t, s_evidence_mask,
                                                         ADV_KIND_SAMSUNG);
    next.vehicle_ms = scan_table_count_vehicle_kind(&s_table, t, s_evidence_mask,
                                                    ADV_KIND_MICROSOFT);

    next.total_seen = scan_table_total(&s_table);
    next.top_len = scan_table_top(&s_table, t, next.top, SNAPSHOT_TOP_N);

    // 还要等多久才可能有车数结果。
    //
    // 以前这里写死"改动时刻 + 30 秒"，那是错的——现场设备早就在场几百秒，
    // 换判据不该让全体重新观察。现在直接问表：最接近达标的候选还差多久。
    // 没有任何候选 = 现在就是 0，不用假装在加载。
    next.vehicle_wait_ms = scan_table_next_vehicle_wait_ms(&s_table, t,
                                                           s_evidence_mask);
    next.snapshot_valid = true;
    s_published = next;
}

static void maintenance_task(void *arg)
{
    (void)arg;
    uint32_t last_save = now_ms();
    uint32_t last_dump = last_save;
    while (!__atomic_load_n(&s_maintenance_stop, __ATOMIC_ACQUIRE)) {
        if (xSemaphoreTake(s_lock, 0) == pdTRUE) {
            // Sample only after locking: a preempting host may have written a
            // newer last_seen before this task obtained the mutex. An older
            // clock would wrap unsigned age and immediately prune fresh data.
            const uint32_t t = scan_maintenance_run_locked(&s_table, now_ms);
            const uint32_t dt = (uint32_t)(t - s_rate_ref_ms);
            if (dt >= 1000) {
                const uint32_t packets = __atomic_load_n(&s_pkt_count, __ATOMIC_RELAXED);
                s_pkt_per_sec = (uint32_t)(((uint64_t)(packets - s_rate_ref_pkts) * 1000u) / dt);
                s_rate_ref_pkts = packets;
                s_rate_ref_ms = t;
            }
            publish_table(t);
            __atomic_add_fetch(&s_maintenance_ticks, 1u, __ATOMIC_RELAXED);
            xSemaphoreGive(s_lock);
        } else {
            __atomic_add_fetch(&s_maintenance_lock_skips, 1u, __ATOMIC_RELAXED);
        }
        const uint32_t t = now_ms(); // Periodic I/O schedule, not table aging.
        if (CAMPUSPULSE_CALIBRATION_PERSISTENCE &&
            (uint32_t)(t - last_save) >= STATS_SAVE_MS) {
            last_save = t;
            scan_ble_save_stats();
        }
        if (CAMPUSPULSE_CALIBRATION_RAW_LOGS && s_sniff &&
            (uint32_t)(t - last_dump) >= VEHICLE_DUMP_MS) {
            last_dump = t;
            (void)scan_ble_dump_vehicles();
        }
        // Never delete a task while it holds the mutex or performs flash I/O.
        ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(MAINTENANCE_MS));
    }
    xSemaphoreGive(s_maintenance_stopped);
    for (;;) vTaskSuspend(NULL);
}

static esp_err_t stop_maintenance(void)
{
    if (!s_maintenance_task) return ESP_OK;
    __atomic_store_n(&s_maintenance_stop, true, __ATOMIC_RELEASE);
    xTaskNotifyGive(s_maintenance_task);
    if (!s_maintenance_stopped ||
        xSemaphoreTake(s_maintenance_stopped, pdMS_TO_TICKS(2000)) != pdTRUE) {
        s_last_error = ESP_ERR_TIMEOUT;
        ESP_LOGE(TAG, "等待扫描维护任务停止超时");
        return ESP_ERR_TIMEOUT;
    }
    vTaskDelete(s_maintenance_task);
    s_maintenance_task = NULL;
    return ESP_OK;
}

esp_err_t scan_ble_start(void)
{
    if (__atomic_load_n(&s_stopping, __ATOMIC_ACQUIRE)) return ESP_ERR_INVALID_STATE;
    if (s_initialized) {
        // 已经初始化过：可能只是被 suspend 了，直接恢复。
        if (s_suspended) return scan_ble_resume() ? ESP_OK : ESP_FAIL;
        return ESP_ERR_INVALID_STATE;
    }

    if (!s_lock) {
        s_lock = xSemaphoreCreateMutex();
        if (!s_lock) return ESP_ERR_NO_MEM;
    }

    // ---- 离线标定的取数入口 ----
    //
    // 放在这里而不是 UI 的 demo_scan_enter() 里，是因为执行顺序：
    // main.c 先调 enter 再调 start，而 s_lock 就在上面几行才创建。
    // 放在 enter 里的话，本机上电后第一次进页面时 s_lock 还是 NULL，
    // scan_ble_dump_stats() 会静默返回 0，串口一行都不打。
    // 实测踩过：看到 "从 NVS 恢复累计表: 10 组"，但紧接着什么都没有。
    //
    // 此刻扫描尚未启动，on_disc 不可能在写表，所以直接调 scan_stats_dump()
    // 而不需要再拿一次锁。
    if (CAMPUSPULSE_CALIBRATION_PERSISTENCE &&
        scan_stats_load(false) == ESP_OK && scan_stats_count() > 0) {
        ESP_LOGI(TAG, "导出累计的设备签名表（NVS 里的上一趟 + 本次会话）...");
        scan_stats_dump();
    }

    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) != pdTRUE) return ESP_ERR_TIMEOUT;
    scan_table_reset(&s_table);
    memset(&s_published, 0, sizeof(s_published));
    __atomic_store_n(&s_maintenance_ticks, 0u, __ATOMIC_RELAXED);
    __atomic_store_n(&s_maintenance_lock_skips, 0u, __ATOMIC_RELAXED);
    xSemaphoreGive(s_lock);
    __atomic_store_n(&s_lock_drops, 0u, __ATOMIC_RELAXED);

    // 一次性资源体检。容量从 128 提到 384 之后，这张表会长期占 26KB，
    // 而 C3 没有 PSRAM、堆本来就紧（BLE + LVGL + WiFi 都在抢），
    // 所以启动时把三个数字打出来，出问题时能立刻判断是不是被表吃掉了：
    //   entry  = 单条大小（有过注释写错成 24 字节的先例）
    //   table  = 整张表的静态占用
    //   free   = 当下剩余堆；min free 是所有时刻的最低水位
    ESP_LOGI(TAG, "表: entry=%uB x %u = %uB, heap free=%u min=%u",
             (unsigned)sizeof(scan_entry_t), (unsigned)SCAN_TABLE_CAPACITY,
             (unsigned)(sizeof(scan_entry_t) * SCAN_TABLE_CAPACITY),
             (unsigned)esp_get_free_heap_size(),
             (unsigned)esp_get_minimum_free_heap_size());
    s_last_error = 0;
    __atomic_store_n(&s_pkt_count, 0u, __ATOMIC_RELAXED);
    s_pkt_per_sec = 0;
    // 首次启动默认三条证据全开：用户要的是"能判出车"，不是"什么都判不出"。
    // 用独立标志判断"是否初始化过"，而不是判断 mask==0——
    // 否则用户主动取消全部勾选后，下次启动又会被强行改回全开。
    if (!s_evidence_inited) {
        // 默认只勾 D（可连接 + 短厂商数据）。A/B/C 全部实测无效：
        //   A 128 位 UUID —— 车棚 0 命中（128 位 UUID 主要在连接后的 GATT 里）
        //   B manu>=8     —— 车是 0~6 字节，永远命中不了；而室内设备全中
        //   C Appearance  —— 242 台里 0 命中
        s_evidence_mask = EVID_LINK_SHORT;
        s_evidence_inited = true;
    }
    s_evidence_set_ms = now_ms();

    esp_err_t err = demo_radio_nvs_prepare();
    if (err != ESP_OK) goto failed;

    err = nimble_port_init();
    if (err != ESP_OK) goto failed;
    s_initialized = true;

    s_host_stopped = xSemaphoreCreateBinary();
    s_maintenance_stopped = xSemaphoreCreateBinary();
    if (!s_host_stopped || !s_maintenance_stopped) {
        err = ESP_ERR_NO_MEM;
        goto failed;
    }

    ble_svc_gap_init();
    ble_svc_gatt_init();
    ble_svc_gap_device_name_set("AI Passport Scan");

    ble_hs_cfg.reset_cb = on_reset;
    ble_hs_cfg.sync_cb = on_sync;

    __atomic_store_n(&s_maintenance_stop, false, __ATOMIC_RELEASE);
    s_rate_ref_ms = now_ms();
    s_rate_ref_pkts = 0;
    if (xTaskCreate(maintenance_task, "scan_maint", 4096, NULL, 3,
                    &s_maintenance_task) != pdPASS) {
        err = ESP_ERR_NO_MEM;
        goto failed;
    }

    // C3 是单核，不用 pinned；栈给 4KB，扫描回调本身几乎不吃栈。
    if (xTaskCreate(host_task, "nimble_host", 4096, NULL, configMAX_PRIORITIES - 4,
                    &s_host_task) != pdPASS) {
        err = ESP_ERR_NO_MEM;
        goto failed;
    }
    return ESP_OK;

failed:
    // Failed cleanup remains retryable; never free resources under a live task.
    if (s_initialized) (void)scan_ble_stop();
    s_last_error = err;
    ESP_LOGE(TAG, "启动失败: %s", esp_err_to_name(err));
    return err;
}

// 内部停止：停扫描但不 deinit 协议栈。
static void stop_scan_only(void)
{
    if (!s_running) return;
    (void)ble_gap_disc_cancel();
    s_running = false;
    s_run_start_ms = 0;
}

esp_err_t scan_ble_stop(void)
{
    __atomic_store_n(&s_stopping, true, __ATOMIC_RELEASE);
    s_running = false;
    s_run_start_ms = 0;
    if (!s_initialized) {
        __atomic_store_n(&s_stopping, false, __ATOMIC_RELEASE);
        return ESP_OK;
    }

    esp_err_t maintenance_err = stop_maintenance();
    if (maintenance_err != ESP_OK) return maintenance_err;

    if (s_host_task && !s_stop_in_progress) {
        (void)ble_gap_disc_cancel();
        int rc = nimble_port_stop();
        if (rc != 0) {
            s_last_error = rc;
            ESP_LOGE(TAG, "nimble_port_stop 失败: %d", rc);
            return ESP_FAIL;
        }
        s_stop_in_progress = true;
    }

    if (s_host_task && !s_host_done) {
        if (!s_host_stopped ||
            xSemaphoreTake(s_host_stopped, pdMS_TO_TICKS(2000)) != pdTRUE) {
            s_last_error = ESP_ERR_TIMEOUT;
            ESP_LOGE(TAG, "等待 NimBLE host 停止超时");
            return ESP_ERR_TIMEOUT;
        }
        s_host_done = true;
    }

    if (s_host_task) {
        vTaskDelete(s_host_task);
        s_host_task = NULL;
    }

    esp_err_t err = nimble_port_deinit();
    if (err != ESP_OK) {
        s_last_error = err;
        ESP_LOGE(TAG, "nimble_port_deinit 失败: %s", esp_err_to_name(err));
        return err;
    }
    s_initialized = false;
    s_running = false;
    s_run_start_ms = 0;
    s_stop_in_progress = false;
    s_host_done = false;
    s_suspended = false;
    if (s_host_stopped) {
        vSemaphoreDelete(s_host_stopped);
        s_host_stopped = NULL;
    }
    if (s_maintenance_stopped) {
        vSemaphoreDelete(s_maintenance_stopped);
        s_maintenance_stopped = NULL;
    }
    // s_lock 和 s_table 保留：挂起/恢复要跨生命周期保留计数。

    // 把累计签名表落盘。**这一步决定离线标定成不成立**：
    // 退出页面之后用户要拔掉 USB 带走，而拔线就是断电，RAM 里的累计表
    // 会跟着消失（实测过一次：回来插线时 uptime 只有 98 秒，数据全没了）。
    //
    // Both tasks are joined. Use the same lock as explicit reset/export calls
    // so final calibration persistence cannot race another public table API.
    if (CAMPUSPULSE_CALIBRATION_PERSISTENCE) scan_ble_save_stats();
    __atomic_store_n(&s_stopping, false, __ATOMIC_RELEASE);
    return ESP_OK;
}

// 挂起：只取消扫描，host 任务留着。射频随之关闭。
// 这比 deinit/deinit 来回切快得多（毫秒级），适合"低功耗但还要计数"的循环。
void scan_ble_suspend(void)
{
    if (!s_initialized || !s_running) {
        s_suspended = true;
        return;
    }
    stop_scan_only();
    s_suspended = true;
    ESP_LOGI(TAG, "扫描已挂起（射频关）");
}

bool scan_ble_resume(void)
{
    if (!s_initialized || __atomic_load_n(&s_stopping, __ATOMIC_ACQUIRE)) return false;
    if (s_running) {
        s_suspended = false;
        return true;
    }
    // 直接重新发起发现流程，不需要重走 sync。
    start_scan();
    return s_running;
}

void scan_ble_reset(void)
{
    if (!s_lock) return;
    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(50)) != pdTRUE) return;
    scan_table_reset(&s_table);
    memset(&s_published, 0, sizeof(s_published));
    // 累计签名表一起清：用户的语义是"从现在开始重新统计"，
    // 留着上一轮的累计会让下次进页面看到的数字对不上。
    // NVS 里那份也要清——否则下次进页面又会把"上一趟"的数据打出来，
    // 用户会以为 RESET 没起作用。
    scan_stats_reset();
    if (CAMPUSPULSE_CALIBRATION_PERSISTENCE) {
        esp_err_t err = scan_stats_clear_nvs();
        if (err != ESP_OK) s_last_error = err;
    }
    __atomic_store_n(&s_lock_drops, 0u, __ATOMIC_RELAXED);
    __atomic_store_n(&s_pkt_count, 0u, __ATOMIC_RELAXED);
    s_pkt_per_sec = 0;
    s_rate_ref_pkts = 0;
    s_rate_ref_ms = now_ms();
    xSemaphoreGive(s_lock);
    // 表清空了，电动车自然要从零开始观察。不重置这个时间戳会让 UI 以为
    // 结果已经就绪，短暂地把 0 当成"真的没有车"。
    s_evidence_set_ms = now_ms();
}

int scan_ble_dump_stats(void)
{
    if (!CAMPUSPULSE_CALIBRATION_RAW_LOGS) return 0;
    if (!s_lock) return 0;
    // 200ms 的等待上限：正常情况 UI 任务不会长时间占着表锁，
    // 拿不到就说明刚好撞上快照，宁可这次不导，也别让界面卡在那里。
    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(200)) != pdTRUE) {
        ESP_LOGW(TAG, "累计表忙，本次导出跳过，再进一次页面即可");
        return -1;
    }
    // 注意：打印发生在锁内。48 组约 4KB，115200 下约 350ms，
    // 这期间 host 任务会被挡住、丢掉一些广播包。
    // 这是刻意的取舍——导出是用户主动触发的一次性动作，
    // 为了它把接口做成"先拷贝再解锁打印"会多一份 1.5KB 的静态缓冲，
    // 不值得。丢的那点包对已经累计完的结果没有影响。
    int n = scan_stats_dump();
    xSemaphoreGive(s_lock);
    return n;
}

void scan_ble_save_stats(void)
{
    if (!CAMPUSPULSE_CALIBRATION_PERSISTENCE) return;
    if (!s_lock) return;
    // Worker task only for periodic use. Explicit calls also remain bounded.
    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) != pdTRUE) {
        s_last_error = ESP_ERR_TIMEOUT;
        return;
    }
    // 写 flash 发生在锁内：on_disc 这期间拿不到锁会丢掉一些广播包。
    // Losses during this optional calibration operation are included in dropped_lock.
    // 换来的好处是不需要为"拷贝快照"再准备一份 1.5KB 的缓冲。
    esp_err_t err = scan_stats_save();
    if (err != ESP_OK) s_last_error = err;
    xSemaphoreGive(s_lock);
}

void scan_ble_get_counts(size_t *live, uint32_t *total)
{
    if (live) *live = 0;
    if (total) *total = 0;
    if (!s_lock) return;
    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(10)) != pdTRUE) return;
    if (live) *live = s_published.live_count;
    if (total) *total = s_published.total_seen;
    xSemaphoreGive(s_lock);
}

void scan_ble_mark_armed(void)
{
    // 外部（唤醒协议）已经确认"刚刚真的有人操作"，
    // 这段证据不需要扫描层再自己攒。
    uint32_t now = now_ms();
    if (now - s_run_start_ms > SCAN_STABLE_AFTER_MS) return;
    s_run_start_ms = now - SCAN_STABLE_AFTER_MS;
}

int scan_ble_dump_vehicles(void)
{
    if (!CAMPUSPULSE_CALIBRATION_RAW_LOGS) return 0;
    if (!s_lock) return -1;
    if (xSemaphoreTake(s_lock, 0) != pdTRUE) return -1;
    int n = scan_table_dump_vehicles(&s_table, now_ms(), s_evidence_mask);
    xSemaphoreGive(s_lock);
    return n;
}

bool scan_ble_get_phone(void)
{
    return s_phone_on;
}

void scan_ble_set_phone(bool on)
{
    if (on == s_phone_on) return;
    s_phone_on = on;
    ESP_LOGI(TAG, "PHONE 采样 %s（关掉时跳过 is_phone，最贵的一段）",
             on ? "打开" : "关闭");
}

bool scan_ble_set_evidence(uint8_t mask)
{
    mask &= EVID_ALL;

    if (!s_lock) {
        s_evidence_mask = mask;
        s_evidence_set_ms = now_ms();
        return true;
    }

    // 改 mask 和"重置在场计时"必须在同一个临界区里完成。
    //
    // 只改 mask 不重置计时（v8 那版的做法），上一判据下已经攒够 30 秒的设备
    // 会被新判据直接继承：车数在一帧之内跳变，也没有任何等待提示。
    // 用户看到的是"数字没动" —— 分不清是判据改了但结论一样，还是按键没吃进去。
    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(200)) != pdTRUE) {
        ESP_LOGW(TAG, "证据切换拿不到表锁，本次改动未生效");
        return false;
    }

    const uint32_t t = now_ms(); // Timer mutation uses the locked table clock.
    const uint8_t old = s_evidence_mask;
    // 先写全局位再重置计时：反过来会让扫描回调在新 mask 下读到旧 dwell，
    // 闪出一个错数。
    s_evidence_mask = mask;
    s_evidence_set_ms = t;

    if (mask != old) {
        // 判据变了 = 旧结论作废。所有在场设备的"在场时长"从 0 重算，
        // 于是车数立刻归 0，界面进入 LOADING 30 秒。
        //
        // 只重置计时，不碰 evidence / cls / peripheral：那些是设备的固有属性，
        // 换判据不需要重新观察；唯独"在场多久"是观察结论，必须重来。
        scan_table_restart_vehicle_timer(&s_table, t);
        s_published.snapshot_valid = false;
    }
    s_last_evidence_count = (int)scan_table_count_vehicle(&s_table, t, mask);
    xSemaphoreGive(s_lock);

    ESP_LOGI(TAG, "证据 mask=0x%02X（原 0x%02X），在场计时已重启 -> 车数 %d，%ums 后出结果",
             mask, old, s_last_evidence_count, (unsigned)SCAN_VEHICLE_DWELL_MS);
    return true;
}

uint8_t scan_ble_get_evidence(void)
{
    return s_evidence_mask;
}

void scan_ble_snapshot(scan_snapshot_t *out)
{
    if (!out) return;
    memset(out, 0, sizeof(*out));
    // Bounded copy only: no table mutation, parsing, driver or logging calls.
    // Busy/initial data is explicitly invalid rather than an observed zero.
    if (s_lock && xSemaphoreTake(s_lock, pdMS_TO_TICKS(20)) == pdTRUE) {
        *out = s_published;
        xSemaphoreGive(s_lock);
    }
    out->running = s_running;
    out->sniffing = s_sniff;
    out->last_error = s_last_error;
    out->packets = __atomic_load_n(&s_pkt_count, __ATOMIC_RELAXED);
    out->per_sec = s_pkt_per_sec;
    out->dropped_lock = __atomic_load_n(&s_lock_drops, __ATOMIC_RELAXED);
    out->maintenance_ticks = __atomic_load_n(&s_maintenance_ticks, __ATOMIC_RELAXED);
    out->maintenance_lock_skips = __atomic_load_n(&s_maintenance_lock_skips, __ATOMIC_RELAXED);
    // Read the origins before sampling now; a host preemption must not make
    // the copied run origin newer than the clock used for elapsed duration.
    const uint32_t start = s_run_start_ms;
    const uint32_t evidence_set = s_evidence_set_ms;
    const uint8_t mask = s_evidence_mask;
    const uint32_t t = now_ms();
    const uint32_t since = (uint32_t)(t - evidence_set);
    if (mask != 0 && since < SCAN_VEHICLE_DWELL_MS) {
        out->vehicle_settle_left_ms = SCAN_VEHICLE_DWELL_MS - since;
    }
    if (out->running && start) {
        out->listened_ms = t - start;
        out->armed = out->listened_ms >= SCAN_STABLE_AFTER_MS;
    }
}

void scan_ble_set_sniff(bool on)
{
    s_sniff = CAMPUSPULSE_CALIBRATION_RAW_LOGS && on;
    ESP_LOGI(TAG, "sniffer %s", s_sniff ? "ON" : "OFF");
}

bool scan_ble_get_sniff(void)
{
    return s_sniff;
}
