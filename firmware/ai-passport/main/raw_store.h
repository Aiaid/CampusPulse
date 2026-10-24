// main/raw_store.h —— ble_raw 分区存储层：环形批记录的追加、读取与回收。
//
// 职责边界：
//   raw_ring.c   纯布局/偏移计算（host 可测）
//   raw_store.c  本文件：esp_partition 擦写 + NVS 元数据 + 开机校验
//
// 数据流：frame_batch 封批 → raw_store_append() 冻结字节入库
//         上传器 peek 最老一批 → POST 验 ACK → raw_store_drop_oldest() 回收
//
// 断电语义：追加写到一半断电，开机校验会在第一条"头不合法"的记录处停下，
// 把它当作数据末尾继续追加——最多损失最后一批，已入库的批不受影响。
#pragma once

#include "esp_err.h"
#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// 定位 ble_raw 分区、恢复读/写指针。分区不存在或全空都不算失败：
// 全空 = 从零开始；分区不存在返回 ESP_ERR_NOT_FOUND（功能降级，不影响雷达）。
esp_err_t raw_store_init(void);

// 追加一批冻结字节（payload + 其 SHA-256）。空间不足返回 ESP_ERR_NO_MEM，
// 调用方据此进入背压（丢弃新帧，等上传回收）。
esp_err_t raw_store_append(const void *payload, uint32_t len,
                           const uint8_t sha256[32]);

// 待上传批数与最老一批的长度（0 = 没有待传数据）。
uint32_t raw_store_pending(void);
uint32_t raw_store_oldest_len(void);

// 把最老一批拷进 buf（cap 不够返回 ESP_ERR_INVALID_SIZE），并带出头部存的
// SHA-256——上传时直接当 X-Body-SHA256 用，不用重算。
esp_err_t raw_store_oldest_peek(void *buf, uint32_t cap, uint32_t *out_len,
                                uint8_t sha256_out[32]);

// 上传 ACK 核对无误后调用：回收最老一批的空间（前移读指针并落 NVS）。
esp_err_t raw_store_drop_oldest(void);

// 水位：已用百分比（0~100）。封批器据此做 60 告警 / 80 停采的背压。
uint32_t raw_store_used_pct(void);

// 清空 ble_raw：擦除整个分区并复位读/写指针（异步任务执行，立即返回）。
// 擦除期间 append 按背压丢弃（返回 ESP_ERR_NO_MEM）、读接口返回
// ESP_ERR_INVALID_STATE，调用方按"这轮失败、下轮重试"处理即可。
esp_err_t raw_store_erase_all(void);

// 是否正在擦除（UI/日志可用）。
bool raw_store_erasing(void);

// 批次序号：单调递增、NVS 持久化，用来拼 batch_id（断电能续号）。
uint32_t raw_store_next_seq(void);

// 封批入库成功后推进序号（只有真正入库的批才消耗号）。
void raw_store_bump_seq(void);

#ifdef __cplusplus
}
#endif
