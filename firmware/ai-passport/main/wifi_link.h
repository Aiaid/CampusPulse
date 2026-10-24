// main/wifi_link.h —— 互斥的 WiFi 会话层。
//
// 为什么需要它：对时（wifi_time，每 3 分钟）和上传（frame_upload，每
// 1 分钟）都要用 WiFi，而以前各自 init/deinit——任何一方的
// esp_wifi_stop()+deinit() 都会把另一方正连着的会话连锅端掉
// （实测症状：烧录后好几分钟对不上时——对时的连接被上传周期反复打断）。
//
// 规则：同一时间只有一个会话，先来先用，后来者排队等互斥锁。
// acquire 拿到锁 = 已连接并拿到 IP；release 断开并 deinit，把射频还给
// BLE。会话是串行的，双方都不需要再关心对方的存在。
#pragma once

#include "esp_err.h"
#include <stdint.h>

// 占有一次 WiFi 会话：阻塞排队 → 初始化 → 连接 → 等到 IP（或超时）。
// 成功返回 ESP_OK（此后独占射频，直到 release）；失败自动清理并释放排队位。
esp_err_t wifi_link_acquire(uint32_t timeout_ms);

// 结束会话：断开 + deinit（把几十 KB 堆和射频还回去），唤醒排队者。
void wifi_link_release(void);
