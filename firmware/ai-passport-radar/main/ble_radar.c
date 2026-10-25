// main/ble_radar.c —— 见 ble_radar.h。
//
// 设计上刻意极薄：这个文件不含任何扫描逻辑，只是把 scan_ble 的快照翻译成
// 上层能直接用的读数，并在数量变化时通知订阅者。
//
// 为什么要单独一层：
//   1) 上层功能（灯效、语音、上报……）不该 include NimBLE 头文件，否则换个扫描
//      实现就得改一片代码；
//   2) "数量"这个数有可信度问题（见 scan_ble.h），把 armed 一起交出去，
//      上层自己决定是"立刻反应"还是"等等再看"。
#include "ble_radar.h"

#include "scan_ble.h"

#include <string.h>

static ble_radar_cb_t s_cb;
static ble_radar_reading_t s_last;
static bool s_have_last;

bool ble_radar_available(void)
{
    return true;
}

ble_radar_reading_t ble_radar_get(void)
{
    ble_radar_reading_t r;
    scan_snapshot_t s;
    scan_ble_snapshot(&s);

    r.phone = (uint16_t)(s.phone_count > 0xFFFF ? 0xFFFF : s.phone_count);
    r.vehicle = (uint16_t)(s.vehicle_count > 0xFFFF ? 0xFFFF : s.vehicle_count);
    r.evidence_mask = s.evidence_mask;
    r.vehicle_wait_ms = s.vehicle_wait_ms;
    r.live = (uint16_t)(s.live_count > 0xFFFF ? 0xFFFF : s.live_count);
    r.live_short = (uint16_t)(s.live_short > 0xFFFF ? 0xFFFF : s.live_short);
    r.live_wide = (uint16_t)(s.live_wide > 0xFFFF ? 0xFFFF : s.live_wide);
    r.total = s.total_seen;
    r.listened_ms = s.listened_ms;
    r.armed = s.armed;
    r.running = s.running;

    if (s_cb) {
        const char *why = NULL;
        if (s.running != s_last.running) {
            why = s.running ? "armed" : "lost";
        } else if (r.armed && !s_last.armed) {
            why = "armed";
        } else if (s_have_last && (r.phone != s_last.phone ||
                                   r.vehicle != s_last.vehicle)) {
            // 分类数字变了才算"count"——live 里混着耳机和未知设备，
            // 它的抖动比分类数字频繁得多，用它当触发条件会让回调响个不停。
            why = "count";
        }
        s_last = r;
        s_have_last = true;
        if (why) s_cb(&r, why);
    } else {
        s_last = r;
        s_have_last = true;
    }
    return r;
}

void ble_radar_set_callback(ble_radar_cb_t cb)
{
    s_cb = cb;
}

void ble_radar_notify(void)
{
    // 目前主动通知只在轮询点触发（get()）。保留这个口子是为了将来做
    // 中断驱动的推送时不改上层签名。
}
