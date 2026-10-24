// main/ble_radar.h —— 给"其他功能"用的 BLE 设备计数接口。
//
// 这一层是给上层功能消费的稳定边界：上层只关心"现在周围有多少台 BLE 设备"，
// 不需要知道 NimBLE、去重表、指纹合并这些东西。
//
// 两种用法：
//   A. 轮询（推荐，最省事）：其他模块自己起个定时器，调 ble_radar_get()。
//   B. 事件（想要"变化了才动作"）：注册一个回调，数量或可信状态变化时被调用。
//
// 线程模型：所有接口都可以从任意任务调用。回调在 **调用 get() 的那个任务**里
// 同步触发，所以回调里不要做耗时操作，也不要再调 ble_radar_get()（会重入）。
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef struct {
    uint16_t phone;         // 手机数量（在场 + 判定为手机）。人流密度的主指标。
    uint16_t vehicle;       // 电动车数量（命中用户勾选的证据 + 在场 30 秒 + 不可连接）
    uint8_t evidence_mask;  // 当前生效的证据位（EVID_*）
    uint32_t vehicle_wait_ms; // 距电动车结果可用还剩多久（0 = 已出结果）
    uint16_t live;          // 当前在场的 BLE 设备总数（5 秒口径，含未分类的）
    uint16_t live_short;    // 2 秒短窗口：更灵敏，适合做瞬时变化检测
    uint16_t live_wide;     // 15 秒宽窗口：适合唤醒判定，抗待机扫描抖动
    uint32_t total;         // 累计发现的设备段数
    uint32_t listened_ms;   // 连续已听时长
    bool armed;             // 听够时间了，数字可信
    bool running;           // 扫描是否在跑
} ble_radar_reading_t;

// 扫描是否可用。不可用时 get() 返回全 0 且 running=false。
bool ble_radar_available(void);

// 取一次读数。开销极小（一次表扫描，128 项）。
ble_radar_reading_t ble_radar_get(void);

// 事件回调。why: "count" = 数量变了；"armed" = 刚开始可信；"lost" = 扫描停了。
typedef void (*ble_radar_cb_t)(const ble_radar_reading_t *r, const char *why);
void ble_radar_set_callback(ble_radar_cb_t cb);

// 由下层驱动调用（scan_ble 每次写表后调一次），外部不用管。
void ble_radar_notify(void);
