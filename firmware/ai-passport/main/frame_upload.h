// main/frame_upload.h —— 原始帧上传器：把 ble_raw 里的冻结批 POST 到后端。
//
// 一轮上传的流程（对应服务端契约）：
//
//   挂起 BLE 扫描 → 连 WiFi → 逐批 POST /api/v1/ingest
//     （Bearer 凭据 + X-Body-SHA256 头，body = 冻结 JSON 字节）
//   → ACK 逐字段核对（batch_id + hash 都在响应里才算数）
//   → raw_store_drop_oldest() 回收空间 → 全部传完 / 出错 → 断 WiFi → 恢复扫描
//
// 为什么挂起扫描：C3 单天线，WiFi 传输期间 BLE 占空比只剩 30~70%，
// "边采边传"等于全天候丢一半帧；挂起换来一个明确的空窗（用户拍板）。
// 代价：每轮上传期间采集停 ~5~30 秒，由上传周期摊薄。
//
// 失败语义：
//   * 连不上 WiFi / 5xx / 网络错误：保留数据，按 1、2、4…60 秒退避下轮再试；
//   * 409 / 410 / 422（契约：数据本身被拒）：隔离 = 丢弃该批不再重试，记数；
//   * 凭据未配置（device_cred_local.h 缺失）：上传器静默休眠，采集存储照常。
//
// TODO（契约文档到手后对齐）：ACK 的精确 JSON 结构（现在是"响应里找得到
// batch_id + hash"的宽松核对）、GET /api/v1/device/config 采集策略拉取、
// 与 wifi_time 共用 WiFi 会话（两边各自 init/deinit，撞车时本轮让行）。
#pragma once

#include <stdbool.h>
#include <stdint.h>

// 启动上传任务（幂等）。周期 UPLOAD_INTERVAL_MS，或 ble_raw 用到 75% 提前触发。
void frame_upload_start(void);

// 是否正在上传（挂起扫描 ~ 恢复扫描之间为 true）。界面据此画提示：
// 这段时间数字冻结是刻意的空窗，不是雷达卡死。
bool frame_upload_active(void);

// 诊断计数。
uint32_t frame_upload_sent(void);        // ACK 核对通过、已回收的批数
uint32_t frame_upload_failed(void);      // 失败轮数（网络/5xx）
uint32_t frame_upload_quarantined(void); // 被服务端拒收而丢弃的批数
