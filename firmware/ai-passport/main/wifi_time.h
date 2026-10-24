// wifi_time.h —— WiFi 对时：连 WiFi → SNTP → 断开，界面读北京时间。
//
// 设计取舍：
//   * 对完就断开 WiFi（stop+deinit）。两个理由：省电；把 2.4G 射频还给
//     BLE——C3 只有一根天线，WiFi 常开会拉低 BLE 扫描占空比，雷达数字
//     的口径会受影响（scan_ble.h 早就标过这个共存问题）。
//   * 系统时钟靠 SNTP 设一次之后自己走（esp_timer 时基），不需要 WiFi 常开；
//     每 12 小时重对一次防漂移。断电重启后回到未同步态，开机自动重对。
//   * 时区写死 CST-8（POSIX 写法，= UTC+8 北京，无夏令时）。
//   * 每轮对时最多连 3 次（单次 15s 超时、间隔 3s），全败才等 12h 下一轮——
//     手机热点可能晚于设备开机才打开，一次超时就放弃代价太大。
#pragma once

#include <stdbool.h>

// 启动后台对时任务（幂等）。不阻塞开机：界面先显示 "--:--"，对上后自动变时间。
void wifi_time_start(void);

// 读当前北京时间（小时/分钟）。未对过时返回 false，界面据此显示 "--:--"。
bool wifi_time_now(int *hh, int *mm);
