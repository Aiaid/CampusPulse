// main/frame_batch.h —— 原始 BLE 帧采集与封批。
//
// 数据通路（对照服务端契约的四段式）：
//
//   NimBLE on_disc → 小 RAM 队列 → 封批任务 → raw_store(ble_raw 分区)
//   （只取身份+载荷     64 槽纯解耦    冻结 JSON   环形追加，断电不丢）
//
// 为什么 RAM 队列去不掉：Flash 擦一个扇区要几十毫秒，NimBLE 回调里写
// Flash 等于高峰期成百上千地丢帧。队列只做解耦（64 槽 ≈ 3.3KB 静态
// RAM），数据本体全程在 Flash——断电损失的只有正在过路的几十帧。
//
// 封批触发（任一满足，契约参数）：
//   * 凑满 32 帧；
//   * JSON 接近 16KB 上限；
//   * 缓冲里最老的帧满 60 秒（flush_max_age_ms，"每分钟"的出处）。
//
// 封批 = 生成 batch_id、算 SHA-256、把 JSON 字节原样冻结进 Flash。
// 冻结的好处：重传就是重发同一段字节，天然幂等（契约 §12.2）。
//
// 背压（水位盯 ble_raw 已用百分比）：
//   60% 告警日志；80% 暂停采新帧（丢新不丢旧）；低于 70% 恢复。
//   空间永远先留给"已采未传"的数据。
//
// JSON 帧格式为暂定实现，待服务端契约文档确认字段名后统一对齐。
#pragma once

#include <stdint.h>

// 启动存储层 + 封批任务，并把原始帧 tap 挂进扫描链路（幂等）。
// ble_raw 分区缺失时只告警，不影响雷达等已有功能。
void frame_batch_start(void);

// 诊断计数。
uint32_t frame_batch_frames(void);    // 累计采集帧数
uint32_t frame_batch_dropped(void);   // 丢弃帧数（队列满 / 背压停采）
uint32_t frame_batch_batches(void);   // 已入库批数
uint32_t frame_batch_lost(void);      // 入库失败批数（Flash 满到背压都来不及）
