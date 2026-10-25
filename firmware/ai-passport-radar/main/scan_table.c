// main/scan_table.c —— 见 scan_table.h。零动态分配，可在 PC 上单元测试。
#include "scan_table.h"
#include "local_policy.h"

#include "dev_class.h"   // SCAN_VEHICLE_DWELL_MS / SCAN_DWELL_GAP_MS

#include <stdio.h>
#include <string.h>

#include "esp_log.h"

// prune 限流：不必每个事件都全表扫一遍。
#define PRUNE_INTERVAL_MS 200

// 在场判定：最后一次出现距现在**不足** window_ms 才算在场。
//
// 严格用 < 而不是 <=：边界（恰好等于 window_ms）必须算"已离开"。
// 原因有两条：
//   1) 5 秒是用户定的判据"连续 5 秒消失即离开"，第 5000ms 就是"消失满 5 秒"；
//   2) 指纹合并用的是同一个 fresh()，如果用 <=，一台离开整 5 秒后换地址回来
//      会被当成"同一台没走"，它的 last_seen 就被续上了——离场判定形同虚设。
static bool fresh(const scan_entry_t *e, uint32_t now_ms, uint32_t window_ms)
{
    return e->used && (uint32_t)(now_ms - e->last_seen_ms) < window_ms;
}

// "计入在场"：由进入/退出状态机决定，不看瞬时值。
//
// 所有**对外计数**的入口都用它，而不是 fresh()。理由见 scan_table.h 的 SCAN_GATE_*：
// 只看"最后一次出现"，一台弱信号设备漏出一包就算进来、下一包没赶上又掉出去，
// 屏幕数字就会大幅抖动。
//
// 边界：窗口比"状态机攒够一轮"还短时（比如 2 秒短窗），状态机根本跑不完，
// 此时退化为"最近出现过"——短窗本来就是给"刚刚还很活跃"这种瞬态判断用的。
static bool confirmed(const scan_entry_t *e, uint32_t now_ms, uint32_t window_ms)
{
    if (!e->used) return false;
#if !SCAN_GATE_ENABLE
    // 状态机关闭（默认）：退回"5 秒窗口内出现过就算在场"的老行为。
    // 见 scan_table.h 里的实测教训——门槛参数在真实数据面前挡掉了 51% 的设备。
    return fresh(e, now_ms, window_ms);
#else
    if (window_ms < (uint32_t)SCAN_GATE_WINDOW_S * SCAN_GATE_SAMPLE_MS) {
        return fresh(e, now_ms, window_ms);
    }
    return e->counted;
#endif
}

// ---- 自适应在场窗口（[historical session] 用户实验）----
//
// 窗口的意义是"别把正常漏包误判成离场"。设备多的时候，任何时刻总有一批
// 设备落在窗口边缘，进进出出会让数字明显抖动（教室实测 ±10），所以要长；
// 设备只有个位数时，边缘设备少、波动天然小，缩短窗口换来的是出场检测
// 从 ~9 秒降到 ~4 秒——"人走了"立刻能看到。
//
// 滞回防抖：<=9 台进 3 秒，>=15 台回 8 秒，10~14 保持当前——窗口本身
// 影响计数，没滞回的话 9↔10 一台之差就会让窗口来回跳。
// 规模估计固定用最长窗口做口径，避免"窗口定义自己"的自举。
//
// 只作用于【计数/显示】路径（confirmed 检查）；prune 与 dwell 重置仍用
// SCAN_LIVE_WINDOW_MS（最长档），短窗口不会销毁任何在场记录。
// 跨任务读写 s_live_win_short 不加锁：最差不过某一帧用了另一档窗口。
#define LIVE_WIN_SHORT_MS 3000
#define LIVE_WIN_DOWN_N   9     // 少于等于它 → 短窗
#define LIVE_WIN_UP_N     15    // 多于等于它 → 长窗

static bool s_live_win_short;

static uint32_t live_window_ms(const scan_table_t *t, uint32_t now_ms)
{
    size_t n = 0;
    for (size_t i = 0; i < SCAN_TABLE_CAPACITY; i++) {
        if (confirmed(&t->entries[i], now_ms, SCAN_LIVE_WINDOW_MS)) n++;
    }
    if (!s_live_win_short && n <= LIVE_WIN_DOWN_N) s_live_win_short = true;
    else if (s_live_win_short && n >= LIVE_WIN_UP_N) s_live_win_short = false;
    return s_live_win_short ? LIVE_WIN_SHORT_MS : SCAN_LIVE_WINDOW_MS;
}

// ⚠ 车辆计数/导出**不用**上面的自适应短窗，一律固定 SCAN_LIVE_WINDOW_MS。
// 原因：车广播周期实测 P90 ≈4 秒，3 秒短窗会让车周期性"掉出在场"，
// 车数在 0 和 N 之间闪（[historical session] 停车场实测车数恒 0 的共犯之一）。
// 停在原地的车也不需要"人走了立刻 -1"——离开车棚 ~9 秒后归零是可接受的。
// 手机路径不受此限，仍用 live_window_ms()。
#define VEHICLE_WINDOW_MS SCAN_LIVE_WINDOW_MS

static int find_slot(const scan_table_t *t, const uint8_t key[SCAN_KEY_LEN])
{
    for (size_t i = 0; i < SCAN_TABLE_CAPACITY; i++) {
        if (t->entries[i].used &&
            memcmp(t->entries[i].key, key, SCAN_KEY_LEN) == 0) {
            return (int)i;
        }
    }
    return -1;
}

static int first_free_slot(const scan_table_t *t)
{
    for (size_t i = 0; i < SCAN_TABLE_CAPACITY; i++) {
        if (!t->entries[i].used) return (int)i;
    }
    return -1;
}

// 淘汰最久未更新的条目。容量满时用它给新设备腾位置。
static int oldest_slot(const scan_table_t *t)
{
    int victim = 0;
    uint32_t oldest = t->entries[0].last_seen_ms;
    for (size_t i = 1; i < SCAN_TABLE_CAPACITY; i++) {
        // 单调时钟回绕安全：用有符号差值比较。
        if ((int32_t)(t->entries[i].last_seen_ms - oldest) < 0) {
            oldest = t->entries[i].last_seen_ms;
            victim = (int)i;
        }
    }
    return victim;
}

// ---------------------------------------------------------------------------
// 身份键
// ---------------------------------------------------------------------------

void scan_table_make_key(const uint8_t addr_val_le[6], uint8_t addr_type,
                         uint8_t out[SCAN_KEY_LEN])
{
    // NimBLE 的 val[] 是小端（val[0] 是最低字节 = 打印地址的最后一组），
    // 倒序成大端，和手机/电脑上看到的 MAC 一致。
    for (size_t i = 0; i < SCAN_KEY_LEN; i++) {
        out[i] = addr_val_le[SCAN_KEY_LEN - 1 - i];
    }
    // 地址类型不塞进键里：同一个物理地址换个地址类型不该变成两台设备。
    // 需要区分时上层用 scan_view_t 之外的信息。这里保留参数是为了将来扩展。
    (void)addr_type;
}

void scan_table_make_anon_key(uint32_t seed, uint8_t event_type,
                              uint8_t out[SCAN_KEY_LEN])
{
    // 匿名广播没有稳定身份，只能用"这一刻的载荷 + 类型"拼一个临时身份。
    // 它天生会随时间变，所以绝不能参与指纹合并。
    out[0] = SCAN_KEY_ANON_TAG;
    out[1] = (uint8_t)(seed >> 24);
    out[2] = (uint8_t)(seed >> 16);
    out[3] = (uint8_t)(seed >> 8);
    out[4] = (uint8_t)seed;
    out[5] = event_type;
}

uint16_t scan_table_fingerprint(const uint8_t *data, uint8_t len)
{
    if (!data || len == 0 || len > SCAN_FP_MAX_LEN) return 0;
    // FNV-1a 16 位。够用就好：我们只拿它跟"另一份不同 MAC 的载荷"比对，
    // 不要求抗攻击，只要求同一份载荷稳定得到同一个值。
    uint16_t h = 0x811C;
    for (uint8_t i = 0; i < len; i++) {
        h ^= data[i];
        h = (uint16_t)(h * 0x0101u);
        h ^= (uint16_t)(h >> 7);
    }
    if (h == 0) h = 1;   // 0 留作"无指纹"
    return h;
}

// ---------------------------------------------------------------------------
// 表操作
// ---------------------------------------------------------------------------

void scan_table_reset(scan_table_t *t)
{
    memset(t, 0, sizeof(*t));
}

// ---------------------------------------------------------------------------
// RSSI 中位数
// ---------------------------------------------------------------------------
//
// 为什么用中位数而不是平均值或瞬时值：
//   * 瞬时值：一包被遮挡就掉 20dB，状态机会跟着抖；
//   * 平均值：一包 -20dB 的异常能把 5 包的平均拉偏 4dB；
//   * 中位数：单包异常完全不影响结果，正好用来做滞回判据。
static void push_rssi(scan_entry_t *e, int8_t rssi)
{
    e->rssi_hist[e->rssi_hist_pos] = rssi;
    e->rssi_hist_pos = (uint8_t)((e->rssi_hist_pos + 1) % SCAN_RSSI_HIST_LEN);
    if (e->rssi_hist_len < SCAN_RSSI_HIST_LEN) e->rssi_hist_len++;
}

static int8_t rssi_median(const scan_entry_t *e)
{
    const uint8_t n = e->rssi_hist_len;
    if (n == 0) return e->rssi;

    int8_t buf[SCAN_RSSI_HIST_LEN];
    memcpy(buf, e->rssi_hist, n);
    // 插入排序。n <= 5，比调用 qsort 便宜得多（而且不带堆栈开销）。
    for (uint8_t i = 1; i < n; i++) {
        const int8_t v = buf[i];
        int8_t j = (int8_t)(i - 1);
        while (j >= 0 && buf[j] > v) {
            buf[j + 1] = buf[j];
            j--;
        }
        buf[j + 1] = v;
    }
    return buf[n / 2];
}

// 抗抖动峰值：最近 N 包里第二高的那一个。
//
// 为什么车辆的半径门槛用它而不是中位数（[historical session] 停车场实测）：
// 中位数的语义是"最近一直待在 ~10m 内"，只适合**站着不动**观察；
// 走着采集时，一台你从旁边经过的车，最近 5 包里混着靠近段和远离段的
// 信号，中位数会被拉到门槛之下——实测一趟 7 台雅迪（最强 -64）全部被
// 这道闸拦死，车数恒 0。走路场景的诚实语义是"**曾进入** 10m"，即峰值。
// 但裸峰值会被单包多径尖刺骗到，所以取第二高：单包异常不影响，
// 两个广播周期内真的靠近过才算数。
static int8_t rssi_peak2(const scan_entry_t *e)
{
    const uint8_t n = e->rssi_hist_len;
    if (n == 0) return e->rssi;

    int8_t buf[SCAN_RSSI_HIST_LEN];
    memcpy(buf, e->rssi_hist, n);
    for (uint8_t i = 1; i < n; i++) {
        const int8_t v = buf[i];
        int8_t j = (int8_t)(i - 1);
        while (j >= 0 && buf[j] > v) {
            buf[j + 1] = buf[j];
            j--;
        }
        buf[j + 1] = v;
    }
    return buf[n >= 2 ? n - 2 : 0];   // 升序后排倒数第二；样本不足取最强
}

// 8 位 popcount。RV32 没有硬件指令，用"清最低位"法，最多循环 8 次。
static uint8_t popcount8(uint8_t v)
{
    uint8_t n = 0;
    while (v) {
        v &= (uint8_t)(v - 1);
        n++;
    }
    return n;
}

static void set_name(scan_entry_t *e, const char *name, uint8_t name_len)
{
    if (!name || name_len == 0) return;   // 这一包没带名字，保留旧的
    if (name_len > SCAN_NAME_MAX) name_len = SCAN_NAME_MAX;
    memcpy(e->name, name, name_len);
    e->name_len = name_len;
    e->has_name = true;
}

static uint8_t rssi_mag(int8_t rssi)
{
    return (uint8_t)(rssi < 0 ? -rssi : rssi);
}

int scan_table_find_fp_match(const scan_table_t *t, uint16_t fp,
                             const uint8_t key[SCAN_KEY_LEN], int8_t rssi,
                             uint32_t now_ms, uint32_t window_ms)
{
    if (fp == 0) return -1;
    if (window_ms == 0) window_ms = SCAN_LIVE_WINDOW_MS;

    int best = -1;
    int best_dr = 256;
    for (size_t i = 0; i < SCAN_TABLE_CAPACITY; i++) {
        const scan_entry_t *e = &t->entries[i];
        if (!fresh(e, now_ms, window_ms)) continue;
        if (e->fp != fp) continue;
        if (memcmp(e->key, key, SCAN_KEY_LEN) == 0) continue;   // 同一个键，走常规路径
        if (e->key_is_anon) continue;                           // 匿名条目不参与合并

        int dr = (int)rssi_mag(e->rssi) - (int)rssi_mag(rssi);
        if (dr < 0) dr = -dr;
        if (dr > SCAN_FP_MERGE_RSSI_DB) continue;

        if (dr < best_dr) {
            best_dr = dr;
            best = (int)i;
        }
    }
    return best;
}

// 把一次观测写进指定槽位。`is_new_segment` 为 true 时重置本段统计。
static void fill_entry(scan_entry_t *e, const uint8_t key[SCAN_KEY_LEN],
                       bool key_is_anon, int8_t rssi, const char *name,
                       uint8_t name_len, uint16_t fp, uint16_t manu_id,
                       bool has_manu, uint32_t now_ms)
{
    memcpy(e->key, key, SCAN_KEY_LEN);
    e->key_is_anon = key_is_anon;
    e->rssi = rssi;
    e->rssi_peak = rssi_mag(rssi);
    e->used = true;
    e->has_name = false;
    e->name_len = 0;
    e->fp = fp;
    if (has_manu) {
        e->manu_id[0] = (uint8_t)(manu_id & 0xFF);
        e->manu_id[1] = (uint8_t)(manu_id >> 8);
    } else {
        e->manu_id[0] = 0;
        e->manu_id[1] = 0;
    }
    e->last_seen_ms = now_ms;
    e->first_seen_ms = now_ms;
    // 新段落：分类清零，等这次观测重新判定。
    e->cls = 0;
    e->cls_decided = false;
    e->connectable = false;
    e->dwell_ms = 0;
    e->dwell_base_ms = now_ms;

    // 状态机从零开始：这一包只是第一格，要再攒够几格才会被计入。
    e->gate_bits = 0;
    e->gate_last_ms = now_ms;
    e->counted = false;
    e->rssi_hist_len = 0;
    e->rssi_hist_pos = 0;
    push_rssi(e, rssi);
    e->evidence = 0;
    e->peripheral = false;
    set_name(e, name, name_len);
}

// 分类判定与 dwell 续期。被 observe / merge 两条路径共用。
//
// 判定只在**首次**做（cls_decided 之后不再改）：
//   * 某些设备的广播包里只有部分字段（比如第一包带厂商数据，后续包不带），
//     每包重判会让类别来回翻转，屏幕上数字跟着跳；
//   * 分类本质是"这台设备是什么"，一旦确定就不该变。
static void apply_class(scan_entry_t *e, bool cls_is_phone, bool connectable,
                        uint8_t evidence, bool peripheral, uint8_t advertiser,
                        bool was_fresh, uint32_t now_ms)
{
    if (!e->cls_decided) {
        e->cls_decided = true;
        e->connectable = connectable;
        // 这里只记"是不是手机"。电动车要等 dwell 够了才可能成立，
        // 由 scan_table_count_vehicle 现场算，不缓存——因为它会随时间成立。
        e->cls = cls_is_phone ? 1 : 0;
    } else {
        // 后续包若带更明确的证据（之前没认出来、现在认出来了），允许升级为手机。
        // 反向不成立：已经认成手机的不会再退回未知。
        if (cls_is_phone && e->cls != 1) {
            e->cls = 1;
        }
        // connectable 只认"曾经可连接过"：电动车的判据是不可连接，
        // 若某台设备出现过可连接广播，说明它有连接能力，不该算车。
        if (connectable) e->connectable = true;
    }

    // 证据位是累积的：一台设备可能 ADV 包带 UUID128、SCAN_RSP 带厂商数据，
    // 分两包才凑齐。按位或累积，不覆盖。
    e->evidence |= evidence;
    // 外设标记同样是累积的：认出来一次就永久排除。
    if (peripheral) e->peripheral = true;
    // 身份猜测取"最高信息量"的那一个：认出来过 Apple 就别再退回 Unknown。
    if (advertiser > e->advertiser) e->advertiser = advertiser;

    // dwell：跨断档累计。
    // 断档超过 SCAN_DWELL_GAP_MS 就从这次重新算起点。
    // 注意这个阈值必须比"WiFi 对时造成的 BLE 断粮"长：3 分钟一次的对时
    // 里阻塞式 diag_scan + 连接握手会让 BLE 饿死 ~3-5s，叠加车自身
    // ~4s 的广播周期，断档轻易超过 10s——用 SCAN_LIVE_WINDOW_MS(10s) 当
    // 阈值时，每次对时都把车的 dwell 清零，界面上"等待 10s"无限循环
    // （[historical session] 用户实测）。20s 给足余量；离开的车由 confirmed()
    // 的 10s 窗口负责剔除，dwell 只决定"回来后接着算还是重新算"。
    if (!was_fresh) {
        e->dwell_base_ms = now_ms;
        e->dwell_ms = 0;
    } else {
        e->dwell_ms = (uint32_t)(now_ms - e->dwell_base_ms);
    }
}

static bool scan_table_observe_inner(scan_table_t *t,
                                     const uint8_t key[SCAN_KEY_LEN],
                                     bool key_is_anon, int8_t rssi,
                                     const char *name, uint8_t name_len,
                                     uint16_t fp, uint16_t manu_id, bool has_manu,
                                     bool cls_is_phone, bool connectable,
                                     uint8_t evidence, bool peripheral,
                                     uint8_t advertiser,
                                     uint32_t now_ms)
{
    int slot = find_slot(t, key);
    if (slot >= 0) {
        scan_entry_t *e = &t->entries[slot];
        // dwell 断档判定用 SCAN_DWELL_GAP_MS（20s），不是在场窗口：
        // 理由见 scan_table.h 该常量的注释（WiFi 对时断粮问题）。
        bool was_fresh = (uint32_t)(now_ms - e->last_seen_ms) < SCAN_DWELL_GAP_MS;
        e->last_seen_ms = now_ms;
        e->rssi = rssi;
        // rssi 是负数，绝对值越小信号越强，所以峰值取较小者。
        uint8_t mag = rssi_mag(rssi);
        if (mag < e->rssi_peak) e->rssi_peak = mag;
        push_rssi(e, rssi);
        if (fp) e->fp = fp;
        if (has_manu) {
            e->manu_id[0] = (uint8_t)(manu_id & 0xFF);
            e->manu_id[1] = (uint8_t)(manu_id >> 8);
        }
        set_name(e, name, name_len);
        if (!was_fresh) {
            // 离开过又回来，算一段新的观测。
            e->first_seen_ms = now_ms;
            t->total_seen++;
            // 段落重置 = dwell 从零开始。cls_decided 保留：
            // 同一台设备换了时间段回来，身份没变，不必重判。
        }
        apply_class(e, cls_is_phone, connectable, evidence, peripheral, advertiser,
                    was_fresh, now_ms);
        return !was_fresh;
    }

    // 地址轮换：同载荷、RSSI 接近的另一台"设备"其实是它换了地址。
    // 这一步必须在建新槽位之前做，否则会多算一台。
    //
    // 窗口用 SCAN_FP_MERGE_WINDOW_MS 而不是 SCAN_LIVE_WINDOW_MS：
    // 在场窗口放宽到 10 秒之后，若这里也跟着放宽，两台同型号设备
    // （fp 相同）在 10 秒内先后出现就会被误合并成一台。合并真正要对付的
    // 是"刚换地址"这种几秒内的事，5 秒足够，也更安全。
    int merge = scan_table_find_fp_match(t, fp, key, rssi, now_ms, SCAN_FP_MERGE_WINDOW_MS);
    if (merge >= 0) {
        scan_entry_t *e = &t->entries[merge];
        // 换键但不新起一段：这是同一台设备的延续。
        memcpy(e->key, key, SCAN_KEY_LEN);
        e->key_is_anon = key_is_anon;
        e->last_seen_ms = now_ms;
        e->rssi = rssi;
        uint8_t mag = rssi_mag(rssi);
        if (mag < e->rssi_peak) e->rssi_peak = mag;
        push_rssi(e, rssi);
        set_name(e, name, name_len);
        // 合并是一条"在场"的证据：dwell 继续累计，不重置。
        apply_class(e, cls_is_phone, connectable, evidence, peripheral, advertiser,
                    true, now_ms);
        return false;
    }

    slot = first_free_slot(t);
    if (slot < 0) slot = oldest_slot(t);

    fill_entry(&t->entries[slot], key, key_is_anon, rssi, name, name_len,
               fp, manu_id, has_manu, now_ms);
    apply_class(&t->entries[slot], cls_is_phone, connectable, evidence, peripheral,
                advertiser, false, now_ms);
    t->total_seen++;
    return true;
}

bool scan_table_observe(scan_table_t *t, const uint8_t key[SCAN_KEY_LEN],
                        bool key_is_anon, int8_t rssi,
                        const char *name, uint8_t name_len,
                        uint16_t fp, uint16_t manu_id, bool has_manu,
                        uint32_t now_ms)
{
    // 老入口：不带分类信息。默认按"未知设备、可连接"处理——
    // 这样它永远不会被算成电动车（电动车的判据含"不可连接"），
    // 保持旧行为不变，避免测试代码被迫改写。
    return scan_table_observe_inner(t, key, key_is_anon, rssi, name, name_len,
                                    fp, manu_id, has_manu,
                                    false, true, 0, false, ADV_KIND_UNKNOWN, now_ms);
}

bool scan_table_observe_classified(scan_table_t *t,
                                   const uint8_t key[SCAN_KEY_LEN],
                                   bool key_is_anon, int8_t rssi,
                                   const char *name, uint8_t name_len,
                                   uint16_t fp, uint16_t manu_id, bool has_manu,
                                   bool cls_is_phone, bool connectable,
                                   uint8_t evidence, bool peripheral,
                                   uint8_t advertiser,
                                   uint32_t now_ms)
{
    return scan_table_observe_inner(t, key, key_is_anon, rssi, name, name_len,
                                    fp, manu_id, has_manu,
                                    cls_is_phone, connectable, evidence,
                                    peripheral, advertiser, now_ms);
}

void scan_table_prune(scan_table_t *t, uint32_t now_ms, uint32_t window_ms)
{
    if (window_ms == 0) window_ms = SCAN_LIVE_WINDOW_MS;
    if ((uint32_t)(now_ms - t->last_prune_ms) < PRUNE_INTERVAL_MS) return;
    t->last_prune_ms = now_ms;
    for (size_t i = 0; i < SCAN_TABLE_CAPACITY; i++) {
        if (!fresh(&t->entries[i], now_ms, window_ms)) t->entries[i].used = false;
    }
}

// 计数直接按时间过滤，不依赖 prune 是否刚跑过——否则 200ms 限流窗口内
// 会短暂把已离场的设备算进去，屏幕数字就会抖。
//
// 这里用 confirmed() 而不是 fresh()：达到"连续 N 次观测"才算在场。
// 这是界面数字稳定性的第一道闸门，所有上层计数都走这条路。
size_t scan_table_count_window(const scan_table_t *t, uint32_t now_ms,
                               uint32_t window_ms)
{
    if (window_ms == 0) window_ms = SCAN_LIVE_WINDOW_MS;
    size_t n = 0;
    for (size_t i = 0; i < SCAN_TABLE_CAPACITY; i++) {
        if (confirmed(&t->entries[i], now_ms, window_ms)) n++;
    }
    return n;
}

size_t scan_table_count(const scan_table_t *t, uint32_t now_ms)
{
    return scan_table_count_window(t, now_ms, SCAN_LIVE_WINDOW_MS);
}

uint32_t scan_table_total(const scan_table_t *t)
{
    return t->total_seen;
}

// ---------------------------------------------------------------------------
// 分类统计
// ---------------------------------------------------------------------------

size_t scan_table_count_phone(const scan_table_t *t, uint32_t now_ms)
{
    const uint32_t win = live_window_ms(t, now_ms);   // 手机用自适应窗口，车才固定长窗
    size_t n = 0;
    for (size_t i = 0; i < SCAN_TABLE_CAPACITY; i++) {
        const scan_entry_t *e = &t->entries[i];
        if (!confirmed(e, now_ms, win)) continue;
        // 只数"身边"的手机：见 SCAN_PHONE_RSSI_MAX 的说明。
        // 用 e->rssi（最近一次）而不是 rssi_peak（最强一次）——
        // 后者会把"曾经走近过的设备"一直算在里面，语义是错的。
        if (e->rssi < SCAN_PHONE_RSSI_MAX) continue;
        if (e->cls == 1) n++;
    }
    return n;
}

// 车的"硬条件"（不含证据位、不含在场时长）。
//
// 为什么要抽成一个函数：这套条件原来在三个计数函数里各抄了一遍，
// 每次改判据都得同步三处，漏一处就会出现"总数对不上其中几台是苹果"
// 这种自相矛盾的显示。现在只有一个定义。
//
// 【关键】"可连接"不再是排除理由。
// 原来的三处都写着 `if (connectable) continue;`，理由是"有连接能力就不是
// PEPS 车机"。车棚实测把它彻底推翻了：29 台车全部是可连接广播（ADV_IND），
// 因为靠近解锁本来就要求手机能连上车。
// 真正分开车和手机的是厂商数据长度：车 0~6 字节，手机电脑 20~27。
// EVID_MANU_LONG 这一位恰好表示 mlen >= 8，直接复用它，不必给 entry 加字段。
// 车辆硬条件的**薄包装**：把条目字段摊成基本类型，交给 veh_rules_hard_ok()。
//
// 为什么不在这个文件里直接写判定：这一层是"在场表"，不该知道电动车的判据。
// 判据全部在 veh_rules.c 里，那里可以脱离扫描表单独测试。
static bool vehicle_hard_ok(const scan_entry_t *e)
{
    // 注意：这里没有 RSSI 半径闸。[historical session] 停车场标定证明车的 Beacon
    // 发射功率太低（2~3 米才 -78~-96），RSSI 圈不出稳定半径，详见
    // scan_table.h 里"已废弃"注释。车辆过滤全靠 veh_rules_hard_ok() +
    // 白名单（EVID_POSITIVE）。rssi_peak2() 仍保留，给 [MISS] 诊断用。
    const uint16_t manu = (uint16_t)(e->manu_id[0] | (e->manu_id[1] << 8));
    return veh_rules_hard_ok(e->cls == 1, e->peripheral, e->connectable,
                             e->evidence, manu);
}

int scan_table_dump_vehicles(const scan_table_t *t, uint32_t now_ms,
                             uint8_t evidence_mask)
{
    if (!CAMPUSPULSE_CALIBRATION_RAW_LOGS) return 0;
    static const char *TAG = "scan_table";
    if (evidence_mask == 0) return 0;
    const uint32_t win = VEHICLE_WINDOW_MS;   // 车固定长窗，见 VEHICLE_WINDOW_MS 定义处注释

    int n = 0;
    for (size_t i = 0; i < SCAN_TABLE_CAPACITY; i++) {
        const scan_entry_t *e = &t->entries[i];
        if (!confirmed(e, now_ms, win)) continue;
        if (!vehicle_hard_ok(e)) continue;
        if (e->dwell_ms < SCAN_VEHICLE_DWELL_MS) continue;
        // 打印口径比计数口径宽：勾选的证据位**或**正面证据，命中任一就展示。
        // 只按 evidence_mask 卡的话，报了品牌名但没有 LINK_SHORT 的车
        // （雅迪/爱玛，见 count_vehicle 的注释）在日志里就隐身了。
        if ((e->evidence & (evidence_mask | EVID_POSITIVE)) == 0) continue;

        // MAC 打成可读形式。key 是大端的 6 字节。
        char mac[18];
        snprintf(mac, sizeof(mac), "%02X:%02X:%02X:%02X:%02X:%02X",
                 e->key[0], e->key[1], e->key[2],
                 e->key[3], e->key[4], e->key[5]);

        const uint16_t manu = (uint16_t)(e->manu_id[0] | (e->manu_id[1] << 8));
        // 名字只打前 16 字节（表里就存这么多），并补 '\0'
        char name[SCAN_NAME_MAX + 1];
        memcpy(name, e->name, e->name_len);
        name[e->name_len] = '\0';

        // 有正面证据打 [BIKE]，否则打 [BIKE?]——后者不进车数，但必须让人看见，
        // 否则"确认 0 台"会被误读成"附近什么都没有"。
        const char *tag = (e->evidence & EVID_POSITIVE) ? "[BIKE]" : "[BIKE?]";
        ESP_LOGI(TAG, "%s %s rssi=%d dwell=%.1fs ev=0x%02X manu=0x%04X "
                      "conn=%d cls=%u name=\"%s\"",
                 tag, mac, (int)e->rssi, e->dwell_ms / 1000.0, e->evidence,
                 manu, (int)e->connectable, (unsigned)e->cls, name);
        n++;
    }
    ESP_LOGI(TAG, "[BIKE] ---- 共 %d 台 ----", n);

    // 第二遍：报了车厂名（EVID_POSITIVE）但没算进车数的"差点算上"，
    // 逐台打印它死在哪道闸。[historical session] 停车场的教训：车明明都在、
    // 名字也全对，被 RSSI 中位数闸和 3 秒短窗拦死，屏幕上只有 0，
    // 日志里连"它们存在过"都看不到。这一坨就是防这种黑盒的。
    for (size_t i = 0; i < SCAN_TABLE_CAPACITY; i++) {
        const scan_entry_t *e = &t->entries[i];
        if (!e->used || !(e->evidence & EVID_POSITIVE)) continue;
        const bool c = confirmed(e, now_ms, win);
        const bool h = vehicle_hard_ok(e);
        const bool d = e->dwell_ms >= SCAN_VEHICLE_DWELL_MS;
        if (c && h && d) continue;              // 已在正式数里
        if (!fresh(e, now_ms, SCAN_LIVE_WINDOW_MS)) continue;  // 早走远了，不算"差点"
        char mac[18];
        snprintf(mac, sizeof(mac), "%02X:%02X:%02X:%02X:%02X:%02X",
                 e->key[0], e->key[1], e->key[2],
                 e->key[3], e->key[4], e->key[5]);
        char name[SCAN_NAME_MAX + 1];
        memcpy(name, e->name, e->name_len);
        name[e->name_len] = '\0';
        ESP_LOGI(TAG, "[MISS] %s 在场=%d 硬条件=%d 时长够=%d "
                      "rssi中位=%d 峰值=%d dwell=%.1fs name=\"%s\"",
                 mac, (int)c, (int)h, (int)d,
                 (int)rssi_median(e), (int)rssi_peak2(e),
                 e->dwell_ms / 1000.0, name);
    }
    return n;
}

size_t scan_table_count_vehicle(const scan_table_t *t, uint32_t now_ms,
                                uint8_t evidence_mask)
{
    // 一条证据都没勾 = 不判车。这不是"没有设备满足"，而是"这项功能关着"。
    if (evidence_mask == 0) return 0;
    const uint32_t win = VEHICLE_WINDOW_MS;   // 车固定长窗，见 VEHICLE_WINDOW_MS 定义处注释

    size_t n = 0;
    for (size_t i = 0; i < SCAN_TABLE_CAPACITY; i++) {
        const scan_entry_t *e = &t->entries[i];
        if (!confirmed(e, now_ms, win)) continue;

        // 硬条件：非手机、非外设、不是"可连接 + 长厂商数据"。
        if (!vehicle_hard_ok(e)) continue;

        // 在场够久 + 报了车厂品牌名。判据反转（v34）后的唯一正面判据就是
        // EVID_POSITIVE；evidence_mask 只负责功能开关（=0 关），它里面的
        // LINK_SHORT 等位**不是**准入门栏——雅迪/爱玛实测是可连接 +
        // 23/24 字节厂商数据，根本没有 LINK_SHORT（[historical session] 车棚）。
        if (e->dwell_ms < SCAN_VEHICLE_DWELL_MS) continue;
        if ((e->evidence & EVID_POSITIVE) == 0) continue;

        n++;
    }
    return n;
}

size_t scan_table_count_vehicle_maybe(const scan_table_t *t, uint32_t now_ms,
                                      uint8_t evidence_mask)
{
    if (evidence_mask == 0) return 0;
    const uint32_t win = VEHICLE_WINDOW_MS;   // 车固定长窗，见 VEHICLE_WINDOW_MS 定义处注释

    size_t n = 0;
    for (size_t i = 0; i < SCAN_TABLE_CAPACITY; i++) {
        const scan_entry_t *e = &t->entries[i];
        if (!confirmed(e, now_ms, win)) continue;
        if (!vehicle_hard_ok(e)) continue;
        if (e->dwell_ms < SCAN_VEHICLE_DWELL_MS) continue;
        if ((e->evidence & evidence_mask) == 0) continue;
        if (e->evidence & EVID_POSITIVE) continue;   // 有正面证据的已经算进正式数
        n++;
    }
    return n;
}

uint32_t scan_table_next_vehicle_wait_ms(const scan_table_t *t, uint32_t now_ms,
                                         uint8_t evidence_mask)
{
    if (evidence_mask == 0) return 0;   // 不是"等待"，是"关闭"
    const uint32_t win = VEHICLE_WINDOW_MS;   // 车固定长窗，见 VEHICLE_WINDOW_MS 定义处注释

    uint32_t min_need = 0;
    bool have_candidate = false;

    for (size_t i = 0; i < SCAN_TABLE_CAPACITY; i++) {
        const scan_entry_t *e = &t->entries[i];
        if (!confirmed(e, now_ms, win)) continue;
        if (!vehicle_hard_ok(e)) continue;
        // 和 count_vehicle 同一口径：等待的是"有品牌名、还在攒在场时长"的候选。
        if ((e->evidence & EVID_POSITIVE) == 0) continue;

        // 已经达标的候选：不用再等。
        if (e->dwell_ms >= SCAN_VEHICLE_DWELL_MS) return 0;

        const uint32_t need = SCAN_VEHICLE_DWELL_MS - e->dwell_ms;
        if (!have_candidate || need < min_need) {
            min_need = need;
            have_candidate = true;
        }
    }

    return have_candidate ? min_need : 0;
}

size_t scan_table_count_vehicle_kind(const scan_table_t *t, uint32_t now_ms,
                                     uint8_t evidence_mask, uint8_t kind)
{
    if (evidence_mask == 0) return 0;
    const uint32_t win = VEHICLE_WINDOW_MS;   // 车固定长窗，见 VEHICLE_WINDOW_MS 定义处注释

    size_t n = 0;
    for (size_t i = 0; i < SCAN_TABLE_CAPACITY; i++) {
        const scan_entry_t *e = &t->entries[i];
        if (!confirmed(e, now_ms, win)) continue;
        if (e->advertiser != kind) continue;
        // 其余条件必须和 scan_table_count_vehicle 一字不差，
        // 否则"其中 M 台是苹果"会和总数对不上，反而更让人困惑。
        if (!vehicle_hard_ok(e)) continue;
        if (e->dwell_ms < SCAN_VEHICLE_DWELL_MS) continue;
        if ((e->evidence & EVID_POSITIVE) == 0) continue;
        n++;
    }
    return n;
}

void scan_table_restart_vehicle_timer(scan_table_t *t, uint32_t now_ms)
{
    for (size_t i = 0; i < SCAN_TABLE_CAPACITY; i++) {
        scan_entry_t *e = &t->entries[i];
        if (!e->used) continue;
        if (!fresh(e, now_ms, SCAN_LIVE_WINDOW_MS)) continue;
        // 只重置计时起点，不碰 evidence / cls / peripheral：
        // 那些是设备的固有属性，换判据不需要重新观察；
        // 唯独"在场多久"是观察结论，必须重新观察。
        e->dwell_base_ms = now_ms;
        e->dwell_ms = 0;
    }
}

void scan_table_tick_dwell(scan_table_t *t, uint32_t now_ms)
{
    for (size_t i = 0; i < SCAN_TABLE_CAPACITY; i++) {
        scan_entry_t *e = &t->entries[i];
        if (!e->used) continue;
        if (!fresh(e, now_ms, SCAN_LIVE_WINDOW_MS)) {
            // 已经离场：dwell 停在离场那一刻，不再增长。
            // 不在这里清零——重新进场时 apply_class 会重置。
            continue;
        }
        e->dwell_ms = (uint32_t)(now_ms - e->dwell_base_ms);
    }
}

// 进入 / 退出 状态机（见 scan_table.h 的 SCAN_GATE_*）。
//
// 位图 gate_bits：bit0 = 本秒收到，bit1 = 上一秒……最多记 8 秒。
// 于是两个条件都不用额外计数器：
//   窗口内命中几次  = popcount(bits & ((1<<WINDOW)-1))
//   连续 N 秒没收到 = (bits & ((1<<N)-1)) == 0
void scan_table_tick_confirm(scan_table_t *t, uint32_t now_ms)
{
    const uint8_t win_mask  = (uint8_t)((1u << SCAN_GATE_WINDOW_S) - 1u);
    const uint8_t miss_mask = (uint8_t)((1u << SCAN_GATE_EXIT_MISS_S) - 1u);
    // "这一秒收到过"的容差：采样周期 + 半格。留半格是因为位图按整秒推进，
    // 而 last_seen 可能落在格子的任意位置。
    const uint32_t seen_tol = SCAN_GATE_SAMPLE_MS + SCAN_GATE_SAMPLE_MS / 2;

    for (size_t i = 0; i < SCAN_TABLE_CAPACITY; i++) {
        scan_entry_t *e = &t->entries[i];
        if (!e->used) continue;

        // TTL 兜底：无论状态机怎么说，超过这个时间完全没更新就判死。
        // 它挡的是"状态机漏了某条路径"这种意外，正常流程里 prune 会先清掉。
        if ((uint32_t)(now_ms - e->last_seen_ms) > SCAN_TTL_MS) {
            e->used = false;
            e->counted = false;
            continue;
        }

        // 只在跨过整秒时才推进。这个函数被每个广播包调用一次（几百次/秒），
        // 不加这个早退，全表 128 条 × 每秒几百次就成了主要开销。
        const uint32_t steps = (uint32_t)(now_ms - e->gate_last_ms) / SCAN_GATE_SAMPLE_MS;
        if (steps == 0) continue;

        if (steps >= 8) {
            e->gate_bits = 0;                       // 空白期太长，历史全丢
        } else {
            e->gate_bits = (uint8_t)(e->gate_bits << steps);
        }
        e->gate_last_ms += steps * SCAN_GATE_SAMPLE_MS;

        // 刚过去的这一格有没有收到。steps > 1 时只补记一格，属于可接受的近似：
        // 那种情况说明主循环被长时间占住了，采样本来就已经失真。
        if ((uint32_t)(now_ms - e->last_seen_ms) < seen_tol) {
            e->gate_bits |= 0x01;
        }

        const int8_t med = rssi_median(e);

        if (!e->counted) {
            // ---- 进入 ----
            // 双条件：窗口内命中够数，且信号中位数达标。
            if (popcount8((uint8_t)(e->gate_bits & win_mask)) >= SCAN_GATE_ENTER_HITS &&
                med >= SCAN_GATE_RSSI_ENTER) {
                e->counted = true;
            }
        } else {
            // ---- 退出 ----
            // 双条件任一成立：连续若干秒没收到，或中位数跌破退出阈值。
            // 退出阈值比进入低 5dB（滞回），所以在 -87 左右徘徊的设备不会来回翻。
            if ((e->gate_bits & miss_mask) == 0 || med < SCAN_GATE_RSSI_EXIT) {
                e->counted = false;
                e->gate_bits = 0;     // 重新进入必须重新攒，不继承旧命中
            }
        }
    }
}

int scan_table_find(const scan_table_t *t, const uint8_t key[SCAN_KEY_LEN])
{
    return find_slot(t, key);
}

// 取前 N 强：N 很小（屏幕上最多显示 6 条），全表扫一遍 + 有序插入，
// 代价 O(容量 × N)，对 128 项可以忽略。
size_t scan_table_top(const scan_table_t *t, uint32_t now_ms,
                      scan_view_t *buf, size_t max)
{
    size_t n = 0;
    for (size_t i = 0; i < SCAN_TABLE_CAPACITY; i++) {
        const scan_entry_t *e = &t->entries[i];
        if (!fresh(e, now_ms, SCAN_LIVE_WINDOW_MS)) continue;

        // 在已排序结果里找插入位置（buf 按 rssi 降序：0 最强，末尾最弱）。
        size_t pos = n;
        while (pos > 0 && buf[pos - 1].rssi < e->rssi) pos--;

        if (pos >= max) continue;   // 比现有最差的还弱，且已经满了

        size_t end = (n < max) ? n : max - 1;
        for (size_t j = end; j > pos; j--) buf[j] = buf[j - 1];
        buf[pos].rssi = e->rssi;
        memcpy(buf[pos].key, e->key, SCAN_KEY_LEN);
        buf[pos].key_is_anon = e->key_is_anon;
        buf[pos].name_len = e->name_len;
        if (e->name_len) memcpy(buf[pos].name, e->name, e->name_len);
        buf[pos].fp = e->fp;
        buf[pos].manu_id[0] = e->manu_id[0];
        buf[pos].manu_id[1] = e->manu_id[1];
        buf[pos].age_ms = (uint32_t)(now_ms - e->last_seen_ms);
        if (n < max) n++;
    }
    return n;
}
