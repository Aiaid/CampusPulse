// net_link.h —— 按需 Wi-Fi 连接 + SNTP 对时。
//
// 与雷达项目 wifi_time.c 的差异：本固件不跑 BLE 扫描，没有射频共存顾虑；
// 但终端仍是电池设备，所以默认保持断开，由 obs_api 在有事要做时
// （拉地点列表 / 提交 / 重试队列）调 net_link_ensure() 连网，空闲
// IDLE_DISCONNECT_MS 后后台任务自动断开并把驱动内存还给系统。
//
// 对时：连上后若系统时间不可信（< TIME_VALID_AFTER）则 SNTP 对时一次；
// 系统时钟之后靠 esp_timer 时基自走，重连时按需重对。时区写死 CST-8
// （POSIX 写法，UTC+8 北京，无夏令时），仅用于界面显示；提交给服务器的
// observed_at 一律用 UTC（gmtime）。
#pragma once

#include <stdbool.h>

typedef enum {
    NET_OFF = 0,      // 空闲，Wi-Fi 已断开
    NET_CONNECTING,   // 正在连接 / 对时
    NET_ONLINE,       // 已连接，可用
} net_state_t;

// 启动后台管理任务（幂等）。不连网，只建任务。
void net_link_start(void);

// 确保已联网（必要时发起连接与对时），阻塞至多 timeout_ms。
// 返回 true 表示可用（已拿到 IP；时间是否已同步用 net_link_time_synced 查）。
// 由 obs_api 工作线程调用，不要在按键回调等短上下文里调。
bool net_link_ensure(int timeout_ms);

// 标记一轮网络使用结束；空闲超时后后台任务自动断开。幂等。
void net_link_release(void);

net_state_t net_link_state(void);
bool net_link_time_synced(void);

// 当前 UTC 时间格式化为 "2026-10-23T05:00:00.000Z"。时间未同步返回 false。
bool net_link_utc_now(char *buf, int len);

// 当前北京时间（小时/分钟），供状态栏显示。未同步返回 false。
bool net_link_time_hhmm(int *hh, int *mm);
