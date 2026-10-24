// main/scan_ble.h —— BLE 周边设备扫描（Observer 角色）。
//
// 与官方 demo_ble.c（只做广播）不同，这里用 NimBLE Observer 接收周边设备的
// 广播包，按"地址 + 载荷指纹"去重后统计当前在场的设备数量。
//
// 已知限制（写进文档里，别当 bug）：
//   * ESP32-C3 只有 BLE，没有 BR/EDR，扫不到蓝牙经典设备。
//   * 只统计"正在广播"的 BLE 设备。已配对连接的 BLE 外设通常不广播。
//   * 默认主动扫描（会发 SCAN_REQ 索要 SCAN_RSP）。原因见 scan_ble.c 里的说明。
//   * 数量是**代表性样本**，不是绝对值。原因是 ESP32-C3 只有一个 2.4GHz 射频，
//     Wi-Fi 与 BLE 分时复用；BLE 自身在连接状态也要让出时间片。
//     详见 scan_gate ——这里用"连续已听时长"把不可靠的窗口挡在门外。
#pragma once

#include "esp_err.h"
#include "dev_class.h"     // ADV_KIND_*
#include "scan_table.h"
#include <stddef.h>
#include <stdbool.h>
#include <stdint.h>

// 连续已听多久之后，数字才算"稳定"。
// 依据：没被占用时 C3 的 BLE 能跑到 90%+ 的扫描占空比；一旦撞上射频共存缩窗，
// 就会掉到 30~70%。两种状态的差距远大于噪声，所以用时长过渡来区分：
// 刚开始的几秒不许信。
#define SCAN_STABLE_AFTER_MS 5000

typedef struct {
    size_t live_count;       // 当前在场设备数（SCAN_LIVE_WINDOW_MS = 10 秒口径）
    size_t live_short;       // 2 秒短窗口：更严格，用于观察"刚刚还很活跃的"
    size_t live_wide;        // 15 秒宽窗口：给唤醒判定用，抗待机扫描抖动
    size_t phone_count;      // 手机数（在场 + 被判定为手机）；PHONE 关掉时恒为 0
    bool phone_on;           // PHONE 采样开关是否打开
    size_t vehicle_count;    // 电动车数（**有正面证据**：车厂品牌名。见 EVID_POSITIVE）
    size_t vehicle_maybe;    // "像车但无正面证据"的台数（默认不计入车数，只作参考显示）
    // 车数里"其中有多少台是这几家广播的"。只用于诊断，不参与判定。
    // 10 楼数出 27 辆车时，看这几个数就知道污染源是楼里的手机还是电脑。
    size_t vehicle_apple;
    size_t vehicle_google;
    size_t vehicle_samsung;
    size_t vehicle_ms;       // Microsoft：Windows / Surface
    uint8_t evidence_mask;   // 当前生效的证据位（EVID_*）
    uint32_t vehicle_wait_ms;// 还有多久才可能有车数结果（0 = 现在就是结果）
    // 判据观察期剩余时间。判据（evidence_mask）刚被用户改动后的
    // SCAN_VEHICLE_DWELL_MS 之内，所有设备的在场计时都已归零，
    // 车数是**作废状态**，界面必须显示 LOADING 而不是 0。
    //
    // 为什么不用 vehicle_wait_ms 代替：那个值在「现场没有任何候选设备」时
    // 会返回 0（真的没车，不用等），于是一改判据就跳回 TOTAL，看起来
    // 像按键没生效。观察期是"判据刚变"这个事件本身决定的，和有没有候选无关。
    uint32_t vehicle_settle_left_ms;
    uint32_t total_seen;     // 累计发现的设备段数
    size_t top_len;          // top[] 有效条数
    scan_view_t top[6];      // 信号最强的若干设备（10 秒窗口内）
    bool running;
    bool sniffing;           // sniffer 日志模式是否开启
    bool armed;              // 已听够 SCAN_STABLE_AFTER_MS，数字可信
    uint32_t listened_ms;    // 连续已听时长（0 表示刚开始/被打断）
    uint32_t packets;        // 本轮收到的广播包总数
    uint32_t per_sec;        // 最近一秒的包速率
    int last_error;
} scan_snapshot_t;

esp_err_t scan_ble_start(void);
esp_err_t scan_ble_stop(void);

// 原始帧 tap（数据采集上云用）：注册后 on_disc 每收到一个广播包就回调一次，
// 在任何去重门限**之前**——要的是全量原始帧。
// 回调跑在 NimBLE host 任务里，必须只做"打时间戳 + 入队"级别的轻量操作。
typedef void (*scan_ble_raw_sink_t)(const uint8_t addr[6], uint8_t addr_type,
                                    uint8_t event_type, int8_t rssi,
                                    const uint8_t *data, uint8_t len);
void scan_ble_set_raw_sink(scan_ble_raw_sink_t cb);

// 唤醒：收音机彻底停下（省电），表保留。
// 给"不刷屏但还要计数"的场景用。恢复走 scan_ble_resume()。
//
// 注意：停止后再启动，控制器会换一个随机地址给自己——但这只影响本机对外身份，
// 不影响我们收到的对端地址。
void scan_ble_suspend(void);
bool scan_ble_resume(void);          // 返回 true 表示已恢复扫描

// WiFi 会话期间把 BLE 协议栈**整套拆掉/接回**（host 池 + 控制器内存全释放）。
// 本机堆 ~150KB，BLE 开着只剩 ~29KB，WiFi init 需要 ~50KB，两者不可并存——
// 这是实测出来的唯一可行解。计数表在静态区，跨 park/unpark 原样保留；
// 不碰 NVS（避免每分钟一次的擦写）。
//   park  在 wifi_link_acquire 里调：成功后 free 堆 ~130KB，WiFi init 才装得下
//   unpark 在 wifi_link_release / acquire 失败路径里调：host sync 自动恢复扫描
// 已停/未启动时两者都是 no-op。会话期间屏幕数字冻结属预期。
esp_err_t scan_ble_park(void);
esp_err_t scan_ble_unpark(void);

// 给"唤醒协议"用：读一个原子快照（不解析、不做格式转换）。
void scan_ble_get_counts(size_t *live, uint32_t *total);
// 唤醒协议读快照时用：告诉扫描层"外部已经确认按下"，不需要攒证据。
void scan_ble_mark_armed(void);

void scan_ble_snapshot(scan_snapshot_t *out);

// 清空计数表，重新开始统计（扫描本身不中断）。换场景时按 OK 调用。
void scan_ble_reset(void);

// 把"本轮累计的设备签名表"打到串口，返回打印的组数（负值 = 表忙，跳过）。
//
// 这张表和 scan_ble_reset 清的那张**不是同一张**：
//   * 扫描表（3 秒前的那张）按 10 秒在场窗口滚动，用来算屏幕上的数字；
//   * 累计签名表不按时间过期，只按 (厂商 ID, 设备名前缀) 聚合，
//     用来回答"这一趟走过的地方都出现过哪些类型的设备"。
//
// 为什么需要它：拿着设备去车棚转一圈时不可能连着电脑，而串口逐包日志
// 没有接收方就等于没记。累计表让这件事变成可能——转完回来一进页面自动打印。
//
// RESET 行会连同累计表一起清空。
int scan_ble_dump_stats(void);

// 把累计表保存到 NVS（掉电不丢）。
//
// 两条调用路径：
//   * `scan_ble_stop()` 里自动调 —— 退出页面时保存
//   * 页面定时器每 30 秒调一次 —— 兜底，防止用户直接拔线
//
// 为什么必须有这一步：**拔掉 USB 就是断电**。实测去过一次车棚，回来插线时
// 芯片 uptime 只有 98 秒（说明中途重启过），RAM 里的累计表全丢了。
// 没有持久化，离线标定这个功能根本不成立。
void scan_ble_save_stats(void);

// ---------------------------------------------------------------------------
// 电动车证据勾选（见 scan_class.h 的 EVID_*）
// ---------------------------------------------------------------------------

// 设置当前生效的证据位。传 0 表示关闭电动车判定。
//
// 副作用：会**重置所有设备的电动车计时**，让它们重新累计 10 秒
// （SCAN_VEHICLE_DWELL_MS）。
// 原因：换了判据就应该重新观察。否则旧判据下攒的时间会被新判据直接继承，
// 屏幕上会瞬间冒出一个用户没预期的大数字，而且**没有任何反馈能告诉用户
// 这次改动到底生效了没有**——数字没变的话，他分不清是"判据改了但结论一样"
// 还是"按键根本没吃进去"。
//
// 重置之后到够 10 秒之前，snapshot 里的 vehicle_settle_left_ms > 0，
// 界面据此显示 LOADING 倒计时并把车数显示成 "--"。
//
// mask 与当前值相同则不重置计时（重复按同一行不该重来一轮）。
// 手机判定与计数不受任何影响。
//
// 返回 false 表示拿不到扫描表锁、本次改动没有生效（界面应保持原样）。
bool scan_ble_set_evidence(uint8_t mask);

// PHONE 采样开关。
//
// 关掉之后 on_disc 里**跳过 dev_phone_is_phone()**——那个函数要对设备名做
// 十几次大小写无关的子串比较，是每包解析里最贵的一段。
// 界面上的手机数会显示 "--"（表示"没在看"，不是"0 个人"）。
// 把当前被计入车数的设备逐台打到串口（标定用，见 scan_table_dump_vehicles）。
// 拿不到表锁时返回 -1，不阻塞。
int scan_ble_dump_vehicles(void);

bool scan_ble_get_phone(void);
void scan_ble_set_phone(bool on);

// 读当前证据位。
uint8_t scan_ble_get_evidence(void);

// 现场标定用的串口日志模式：把每条广播的身份、名字、RSSI、广播类型打到串口。
// 用来判断某类设备（电动车、手环……）到底广播什么。
// 默认关闭——开着会把 UART 刷满，而且每条日志都走 printf，很吃 CPU。
void scan_ble_set_sniff(bool on);
bool scan_ble_get_sniff(void);
