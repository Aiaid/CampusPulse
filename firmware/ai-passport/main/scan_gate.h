// main/scan_gate.h —— 用"周围蓝牙设备的连续性变化"当唤醒信号。
//
// 完整场景（待办）：
//   低功耗待机时屏幕不刷、收音机周期性短开（例如每 2 秒听 200ms）。
//   人走过来时，周围 BLE 设备数会明显增多且**持续**变化；静止环境里这个数
//   是平的。用这个差量做唤醒，比单纯"有广播就唤醒"可靠得多。
//
// 这里只实现**纯判定逻辑**，不碰硬件、不碰 NimBLE，所以能在 PC 上单测。
// 待机扫描的调度（开多久、停多久、怎么省电）属于另一层，等真机波形出来再写。
#pragma once

#include <stdbool.h>
#include <stdint.h>

// 采样周期：与待机时收音机的开启周期一致。
#define GATE_SAMPLE_MS 2000

// 判定窗口：最近多少个采样点参与计算。6 × 2s = 12 秒。
#define GATE_WINDOW 6

// 触发条件（同时满足才算"有人来了"）：
//   1. 窗口内设备数的波动幅度 >= GATE_ACTIVITY_DELTA；
//   2. 最近一次采样比窗口均值高至少 GATE_RISE_COUNT。
// 为什么用"波动"而不是"超过阈值"：不同环境的基线差很多（空房间 3 台、
// 咖啡厅 40 台），固定阈值在两种场景下必有一种失效。波动幅值与环境无关。
#define GATE_ACTIVITY_DELTA 3
#define GATE_RISE_COUNT     2

// 确认次数：条件连续满足几次才真正唤醒，压掉单点毛刺。
#define GATE_CONFIRM  2

// 冷却：唤醒后这段时间内不再触发，避免反复唤醒。
#define GATE_COOLDOWN_MS 30000

typedef struct {
    uint16_t hist[GATE_WINDOW];
    uint8_t head;
    uint8_t fill;
    uint8_t hits;           // 连续满足条件的次数
    uint32_t last_trigger_ms;
    bool triggered_once;
} scan_gate_t;

void scan_gate_reset(scan_gate_t *g, uint32_t now_ms);

// 喂一个采样点。返回 true 表示"确认有人来了，该唤醒"。
// 调用顺序必须是时间递增；采样周期可以不严格等于 GATE_SAMPLE_MS。
bool scan_gate_feed(scan_gate_t *g, uint16_t count, uint32_t now_ms);

// 只读：当前窗口均值（调试用）。
uint16_t scan_gate_mean(const scan_gate_t *g);
