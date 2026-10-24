// 扫描去重表 + 唤醒判定的 host 测试：不依赖 SDK，直接验证纯逻辑。
//
// 编译（本机 gcc）：
//   gcc -std=c11 -I main tests/test_scan_table.c main/scan_table.c
//       main/scan_gate.c -o test_scan_table
#include <assert.h>
#include <stdio.h>
#include <string.h>

#include "scan_class.h"
#include "scan_gate.h"
#include "scan_table.h"

static void key_of(uint8_t k[SCAN_KEY_LEN], uint8_t id)
{
    memset(k, 0, SCAN_KEY_LEN);
    k[SCAN_KEY_LEN - 1] = id;
}

// NimBLE 的 addr.val 是小端：把 "AA:BB:CC:DD:EE:01" 写成 val[]
static void val_of(uint8_t v[6], uint8_t a, uint8_t b, uint8_t c,
                   uint8_t d, uint8_t e, uint8_t f)
{
    v[0] = f; v[1] = e; v[2] = d; v[3] = c; v[4] = b; v[5] = a;
}


// 测试专用包装：observe 之后把该条目直接标成"已计入"。
//
// 真实固件里"进入计数"是 scan_table_tick_confirm() 按 1 秒节拍跑 5 秒窗口
// 攒出来的（命中够数 + RSSI 中位数达标）。测试没有那个循环，
// 所以这里一次性置位，否则所有计数都会是 0，断言看起来全错，
// 其实只是缺了时间推进。状态机本身另有用例 test_gate_* 单独验证。
static int test_confirm_slot(scan_table_t *t, const uint8_t k[SCAN_KEY_LEN])
{
    int slot = scan_table_find(t, k);
    if (slot >= 0) t->entries[slot].counted = true;
    return slot;
}

static bool ob(scan_table_t *t, const uint8_t k[SCAN_KEY_LEN], bool anon, int8_t rssi,
               const char *name, uint8_t nlen, uint16_t fp, uint16_t manu, bool hm,
               uint32_t now)
{
    bool r = scan_table_observe(t, k, anon, rssi, name, nlen, fp, manu, hm, now);
    test_confirm_slot(t, k);
    return r;
}

static bool obc(scan_table_t *t, const uint8_t k[SCAN_KEY_LEN], bool anon, int8_t rssi,
                const char *name, uint8_t nlen, uint16_t fp, uint16_t manu, bool hm,
                bool phone, bool conn, uint8_t ev, bool periph, uint8_t adv,
                uint32_t now)
{
    bool r = scan_table_observe_classified(t, k, anon, rssi, name, nlen, fp, manu, hm,
                                           phone, conn, ev, periph, adv, now);
    test_confirm_slot(t, k);
    return r;
}

static void test_basic(void)
{
    scan_table_t t;
    uint8_t k[SCAN_KEY_LEN];

    scan_table_reset(&t);
    key_of(k, 1);
    assert(ob(&t, k, false, -60, NULL, 0, 0, 0, false, 1000));
    assert(!ob(&t, k, false, -55, NULL, 0, 0, 0, false, 1200));
    assert(!ob(&t, k, false, -70, NULL, 0, 0, 0, false, 1400));
    assert(scan_table_count(&t, 1500) == 1);
    assert(scan_table_total(&t) == 1);

    key_of(k, 2);
    ob(&t, k, false, -80, NULL, 0, 0, 0, false, 1500);
    key_of(k, 3);
    ob(&t, k, false, -50, NULL, 0, 0, 0, false, 1600);
    assert(scan_table_count(&t, 1700) == 3);

    // 5 秒离场判定：设备 1 最后一次出现在 1200（不是 1000，中间还更新过一次），
    // 差 5000ms 时还在场，差 5001ms 时判定离开。
    assert(scan_table_count(&t, 1200 + SCAN_LIVE_WINDOW_MS) == 3);
    assert(scan_table_count(&t, 1200 + SCAN_LIVE_WINDOW_MS + 1) == 2);
    // 1600+5001 之后全部出局。
    assert(scan_table_count(&t, 1600 + SCAN_LIVE_WINDOW_MS + 1) == 0);
    assert(scan_table_total(&t) == 3);

    // 宽窗口（15s）此时还能看到它们——这是给唤醒判定用的口径。
    assert(scan_table_count_window(&t, 1600 + SCAN_LIVE_WINDOW_MS + 1,
                                   SCAN_ACTIVE_WINDOW_MS) == 3);

    // 过期后重新出现：累计 +1。
    key_of(k, 1);
    assert(ob(&t, k, false, -60, NULL, 0, 0, 0, false,
                              1600 + SCAN_LIVE_WINDOW_MS + 500));
    assert(scan_table_total(&t) == 4);
}

// 5 秒离场判定的专项测试：这台设备走出去、再走回来。
static void test_leave_and_return(void)
{
    scan_table_t t;
    uint8_t k[SCAN_KEY_LEN];
    scan_table_reset(&t);
    key_of(k, 0x77);

    ob(&t, k, false, -55, "EV-Scooter", 10, 0, 0, false, 10000);
    assert(scan_table_count(&t, 10000) == 1);

    // 走到 3 秒：还在。
    assert(scan_table_count(&t, 13000) == 1);
    // 4.9 秒：还在。
    assert(scan_table_count(&t, 14900) == 1);
    // 5.001 秒：判定离开。
    assert(scan_table_count(&t, 15001) == 0);
    // 但宽窗口还留着（唤醒判定需要它）。
    assert(scan_table_count_window(&t, 15001, SCAN_ACTIVE_WINDOW_MS) == 1);

    // 8 秒后走回来：算新的一次，此时只有 1 台（不会变成 2 台）。
    assert(ob(&t, k, false, -58, "EV-Scooter", 10, 0, 0, false, 18000));
    assert(scan_table_count(&t, 18000) == 1);
    assert(scan_table_total(&t) == 2);   // 但累计数记成两段

    // 短窗口更严格：2 秒前没出现的就不算。
    assert(scan_table_count_window(&t, 18000, SCAN_SHORT_WINDOW_MS) == 1);
    assert(scan_table_count_window(&t, 20001, SCAN_SHORT_WINDOW_MS) == 0);
    assert(scan_table_count(&t, 20001) == 0);
}

static void test_capacity_and_wrap(void)
{
    scan_table_t t;
    uint8_t k[SCAN_KEY_LEN];
    scan_table_reset(&t);

    for (int i = 0; i < SCAN_TABLE_CAPACITY; i++) {
        key_of(k, (uint8_t)i);
        ob(&t, k, false, -60, NULL, 0, 0, 0, false, 3000 + (uint32_t)i);
    }
    assert(scan_table_count(&t, 3000 + SCAN_TABLE_CAPACITY) == SCAN_TABLE_CAPACITY);

    uint8_t fresh_key[SCAN_KEY_LEN];
    key_of(fresh_key, 200);
    assert(ob(&t, fresh_key, false, -50, NULL, 0, 0, 0, false,
                              3000 + SCAN_TABLE_CAPACITY));
    assert(scan_table_count(&t, 3001 + SCAN_TABLE_CAPACITY) == SCAN_TABLE_CAPACITY);

    // 时钟回绕：单调时钟跑满 32 位后不能崩。
    scan_table_reset(&t);
    key_of(k, 1);
    ob(&t, k, false, -55, NULL, 0, 0, 0, false, 0xFFFFFF00u);
    assert(scan_table_count(&t, 0x00000010u) == 1);
}

static void test_name(void)
{
    scan_table_t t;
    uint8_t k[SCAN_KEY_LEN];
    scan_table_reset(&t);
    key_of(k, 1);

    ob(&t, k, false, -60, "NIU Link 4A2F", 13, 0, 0, false, 5000);
    scan_view_t buf[2];
    assert(scan_table_top(&t, 5100, buf, 2) == 1);
    assert(buf[0].name_len == 13);
    assert(memcmp(buf[0].name, "NIU Link 4A2F", 13) == 0);

    // 后续包没名字：保留旧名。
    ob(&t, k, false, -58, NULL, 0, 0, 0, false, 5200);
    assert(scan_table_top(&t, 5300, buf, 2) == 1);
    assert(buf[0].name_len == 13);

    // 超长名字截断。
    ob(&t, k, false, -58, "ABCDEFGHIJKLMNOPQRSTUVWXYZ", 26,
                       0, 0, false, 5400);
    assert(scan_table_top(&t, 5500, buf, 2) == 1);
    assert(buf[0].name_len == SCAN_NAME_MAX);

    // age_ms 随时间增长。
    assert(buf[0].age_ms == 100);
}

static void test_make_key(void)
{
    // NimBLE 的 val 是小端，转出来的键必须是大端，否则日志里的 MAC 是反的。
    uint8_t v[6], k[SCAN_KEY_LEN];
    val_of(v, 0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0x01);   // AA:BB:CC:DD:EE:01
    scan_table_make_key(v, 0, k);
    static const uint8_t want[6] = { 0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0x01 };
    assert(memcmp(k, want, 6) == 0);
}

static void test_address_rotation_merge(void)
{
    scan_table_t t;
    uint8_t k1[SCAN_KEY_LEN], k2[SCAN_KEY_LEN];
    scan_table_reset(&t);

    const char payload[] = "\x02\x01\x06\x0d\x09MiBand 7";
    uint16_t fp = scan_table_fingerprint((const uint8_t *)payload,
                                         sizeof(payload) - 1);
    assert(fp != 0);

    key_of(k1, 0x11);
    ob(&t, k1, false, -62, "MiBand 7", 9, fp, 0x0157, true, 1000);
    assert(scan_table_count(&t, 1100) == 1);

    // 同一台设备换了随机地址，载荷与 RSSI 几乎不变 → 必须合并成一台。
    key_of(k2, 0x22);
    assert(!ob(&t, k2, false, -63, "MiBand 7", 9, fp, 0x0157,
                               true, 1500));
    assert(scan_table_count(&t, 1600) == 1);
    assert(scan_table_total(&t) == 1);   // 不能多算一段

    // 合并后新键生效，旧键不再命中。
    assert(scan_table_find(&t, k2) >= 0);
    assert(scan_table_find(&t, k1) < 0);

    // 关键边界：设备离开超过 5 秒，指纹不再合并，回来的算新设备。
    {
        scan_table_t t2;
        uint8_t a[SCAN_KEY_LEN], b[SCAN_KEY_LEN];
        key_of(a, 0x55);
        key_of(b, 0x56);
        scan_table_reset(&t2);
        ob(&t2, a, false, -60, "X", 1, fp, 0, false, 1000);
        // 3 秒后换地址回来 → 合并。
        assert(!ob(&t2, b, false, -61, "X", 1, fp, 0, false, 4000));
        assert(scan_table_count(&t2, 4000) == 1);
    }
    {
        scan_table_t t2;
        uint8_t a[SCAN_KEY_LEN], b[SCAN_KEY_LEN];
        key_of(a, 0x55);
        key_of(b, 0x57);
        scan_table_reset(&t2);
        ob(&t2, a, false, -60, "X", 1, fp, 0, false, 1000);
        // 6 秒后（已经离开）才出现 → 不合并，是新的一个。
        assert(ob(&t2, b, false, -61, "X", 1, fp, 0, false, 7000));
        // 用宽窗口看：老条目在 5 秒窗口里已经过期，5 秒口径只数得到 1，
        // 所以这里必须用 15 秒口径才能看出"确实是两个独立身份"。
        assert(scan_table_count_window(&t2, 7000, SCAN_ACTIVE_WINDOW_MS) == 2);
        assert(scan_table_count(&t2, 7000) == 1);
    }

    // 反例：同载荷但 RSSI 差很多 → 是两台不同的设备，不能合并。
    uint8_t k3[SCAN_KEY_LEN];
    key_of(k3, 0x33);
    assert(ob(&t, k3, false, -30, "MiBand 7", 9, fp, 0x0157,
                              true, 1700));
    assert(scan_table_count(&t, 1800) == 2);

    // 反例：RSSI 接近但载荷不同 → 两台。
    uint8_t k4[SCAN_KEY_LEN];
    key_of(k4, 0x44);
    ob(&t, k4, false, -62, "Other", 5, 0xBEEF, 0, false, 1900);
    assert(scan_table_count(&t, 2000) == 3);

    // 匿名条目不参与合并。
    uint8_t a1[SCAN_KEY_LEN], a2[SCAN_KEY_LEN];
    scan_table_make_anon_key(1, 0, a1);
    scan_table_make_anon_key(2, 0, a2);
    scan_table_reset(&t);
    ob(&t, a1, true, -55, NULL, 0, fp, 0, false, 3000);
    ob(&t, a2, true, -55, NULL, 0, fp, 0, false, 3100);
    assert(scan_table_count(&t, 3200) == 2);
}

static void test_fingerprint(void)
{
    static const uint8_t p[] = "\x02\x01\x06\x03\x03\xaa\xfe";
    assert(scan_table_fingerprint(p, sizeof(p) - 1) != 0);
    // 同一份载荷必须得到同一个值。
    assert(scan_table_fingerprint(p, sizeof(p) - 1) ==
           scan_table_fingerprint(p, sizeof(p) - 1));
    // 不同载荷必须得到不同的值（至少这一对不能撞）。
    static const uint8_t q[] = "\x02\x01\x06\x03\x03\xaa\xff";
    assert(scan_table_fingerprint(p, sizeof(p) - 1) !=
           scan_table_fingerprint(q, sizeof(q) - 1));
    // 超长/空载荷不算指纹。
    static const uint8_t big[64];
    assert(scan_table_fingerprint(big, sizeof(big)) == 0);
    assert(scan_table_fingerprint(big, 0) == 0);
    assert(scan_table_fingerprint(NULL, 5) == 0);
}

static void test_top(void)
{
    scan_table_t t;
    uint8_t k[SCAN_KEY_LEN];
    scan_table_reset(&t);
    key_of(k, 10);
    ob(&t, k, false, -85, NULL, 0, 0, 0, false, 2000);
    key_of(k, 11);
    ob(&t, k, false, -45, NULL, 0, 0, 0, false, 2000);
    key_of(k, 12);
    ob(&t, k, false, -65, NULL, 0, 0, 0, false, 2000);

    scan_view_t buf[4];
    size_t n = scan_table_top(&t, 2100, buf, 4);
    assert(n == 3);
    assert(buf[0].rssi == -45);
    assert(buf[1].rssi == -65);
    assert(buf[2].rssi == -85);

    // 截断到 2 条：只留最强的两个。
    n = scan_table_top(&t, 2100, buf, 2);
    assert(n == 2);
    assert(buf[0].rssi == -45);
    assert(buf[1].rssi == -65);
}

// 改判据 → 车数归零 → LOADING 30 秒 → 重新出数。
//
// 这个用例守的是 v9 报的那个 bug：改勾选后车数不归零、也没有 loading。
// 根因是 scan_ble_set_evidence() 里漏了 scan_table_restart_vehicle_timer()，
// 于是旧判据下攒够的 30 秒被新判据直接继承，数字在一帧内跳变、还进不了等待态。
static void test_evidence_switch_restarts_dwell(void)
{
    scan_table_t t;
    uint8_t car[SCAN_KEY_LEN], phone[SCAN_KEY_LEN];
    scan_table_reset(&t);
    key_of(car, 0xC1);
    key_of(phone, 0xC2);

    // 一台不可连接、带厂商数据（证据 B）的设备，外加一台手机。
    // 每 1 秒观测一次，模拟"一直在场"。
    const uint32_t t0 = 1000;
    for (uint32_t now = t0; now <= t0 + 40000; now += 1000) {
        obc(&t, car, false, -72, NULL, 0, 0, 0x004C, true,
                                      false, false, EVID_MANU_LONG, false,
                                      ADV_KIND_APPLE, now);
        obc(&t, phone, false, -55, "iPhone", 6, 0, 0x004C,
                                      true, true, true, 0, false,
                                      ADV_KIND_APPLE, now);
        scan_table_tick_dwell(&t, now);
    }

    const uint32_t t_ready = t0 + 40000;
    assert(scan_table_count_vehicle(&t, t_ready, EVID_MANU_LONG) == 1);
    assert(scan_table_count_vehicle(&t, t_ready, EVID_ALL) == 1);
    assert(scan_table_next_vehicle_wait_ms(&t, t_ready, EVID_MANU_LONG) == 0);
    assert(scan_table_count_phone(&t, t_ready) == 1);

    // 用户改判据。旧结论必须作废。
    scan_table_restart_vehicle_timer(&t, t_ready);

    assert(scan_table_count_vehicle(&t, t_ready, EVID_ALL) == 0);
    // 报告"还要等满 30 秒"，界面据此进入 LOADING。
    assert(scan_table_next_vehicle_wait_ms(&t, t_ready, EVID_ALL) ==
           SCAN_VEHICLE_DWELL_MS);
    // 手机计时不受影响（手机判定跟证据无关）。
    assert(scan_table_count_phone(&t, t_ready) == 1);

    // 10 秒后：倒计时按真实进度递减，不是一直卡在 30。
    for (uint32_t now = t_ready + 1000; now <= t_ready + 10000; now += 1000) {
        obc(&t, car, false, -72, NULL, 0, 0, 0x004C, true,
                                      false, false, EVID_MANU_LONG, false,
                                      ADV_KIND_APPLE, now);
        scan_table_tick_dwell(&t, now);
    }
    assert(scan_table_count_vehicle(&t, t_ready + 10000, EVID_ALL) == 0);
    assert(scan_table_next_vehicle_wait_ms(&t, t_ready + 10000, EVID_ALL) == 20000);

    // 攒满 30 秒后重新出数。
    for (uint32_t now = t_ready + 11000; now <= t_ready + 30000; now += 1000) {
        obc(&t, car, false, -72, NULL, 0, 0, 0x004C, true,
                                      false, false, EVID_MANU_LONG, false,
                                      ADV_KIND_APPLE, now);
        scan_table_tick_dwell(&t, now);
    }
    assert(scan_table_count_vehicle(&t, t_ready + 30000, EVID_ALL) == 1);
    assert(scan_table_next_vehicle_wait_ms(&t, t_ready + 30000, EVID_ALL) == 0);

    // 判据全关：不是"等待"，是"关闭"。
    assert(scan_table_count_vehicle(&t, t_ready + 30000, EVID_NONE) == 0);
    assert(scan_table_next_vehicle_wait_ms(&t, t_ready + 30000, EVID_NONE) == 0);
}

// --- 唤醒判定 ---------------------------------------------------------------

static void test_gate_quiet_room(void)
{
    // 静止环境：设备数在小范围抖动，绝不该触发。
    scan_gate_t g;
    scan_gate_reset(&g, 0);
    static const uint16_t seq[] = { 3, 3, 4, 3, 3, 4, 3, 3, 4, 3, 3, 3, 4, 3 };
    for (size_t i = 0; i < sizeof(seq) / sizeof(seq[0]); i++) {
        assert(!scan_gate_feed(&g, seq[i], (uint32_t)(i * GATE_SAMPLE_MS)));
    }
}

static void test_gate_crowded_but_static(void)
{
    // 咖啡厅：基数大但稳定，同样不该触发。这正是固定阈值方案会误报的场景。
    scan_gate_t g;
    scan_gate_reset(&g, 0);
    for (int i = 0; i < 20; i++) {
        assert(!scan_gate_feed(&g, (uint16_t)(40 + (i % 2)), (uint32_t)(i * GATE_SAMPLE_MS)));
    }
}

static void test_gate_person_arrives(void)
{
    // 空房间 3 台 → 有人进来，数跳到 9 并维持。应该触发一次。
    scan_gate_t g;
    scan_gate_reset(&g, 0);
    uint32_t t = 0;
    static const uint16_t quiet[] = { 3, 3, 3, 4, 3, 3 };
    for (size_t i = 0; i < sizeof(quiet) / sizeof(quiet[0]); i++) {
        assert(!scan_gate_feed(&g, quiet[i], t));
        t += GATE_SAMPLE_MS;
    }
    bool fired = false;
    static const uint16_t busy[] = { 9, 10, 9, 9, 10, 9 };
    for (size_t i = 0; i < sizeof(busy) / sizeof(busy[0]); i++) {
        if (scan_gate_feed(&g, busy[i], t)) fired = true;
        t += GATE_SAMPLE_MS;
    }
    assert(fired);

    // 冷却期内不再触发。
    for (int i = 0; i < 3; i++) {
        assert(!scan_gate_feed(&g, 12, t));
        t += GATE_SAMPLE_MS;
    }
    assert(scan_gate_mean(&g) > 0);
}

int main(void)
{
    test_basic();
    test_leave_and_return();
    test_capacity_and_wrap();
    test_name();
    test_make_key();
    test_address_rotation_merge();
    test_fingerprint();
    test_top();
    test_evidence_switch_restarts_dwell();
    test_gate_quiet_room();
    test_gate_crowded_but_static();
    test_gate_person_arrives();
    printf("test_scan_table: all assertions passed\n");
    return 0;
}
