// main/raw_ring.h —— ble_raw 裸分区的环形批记录布局（纯逻辑，host 可测）。
//
// 分区里只放一种东西：封好的批记录。布局：
//
//   [40B 记录头][冻结的 JSON 字节][0~3B 对齐填充]
//   头 = magic(4) + payload_len(4) + payload 的 SHA-256(32)
//
// 为什么是裸分区而不是 FAT 文件：本设备"拔 USB 就是断电"（见 scan_ble.h
// 的实测教训），FAT 在写文件中途断电可能损坏目录项。裸分区追加写 +
// 开机从头逐条校验，断电最多损失最后一条不完整记录。
//
// 环形语义（边擦边写）：
//   * 追加在 write_off，回收在读指针 read_off（上传 ACK 后才前移）；
//   * 擦除以 4KB 扇区为单位、提前进行：erased_upto 之前的扇区保证已擦；
//   * write 追上 read（剩余 < 一条记录 + 1 扇区）时拒绝写入，
//     空间永远先留给"已采未传"的数据（服务端契约的水位背压）。
//
// 本文件不含任何 ESP-IDF 依赖，可直接用 host gcc 编译测试；
// 真正擦写/读 Flash 的胶水在 raw_store.c。
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define RAW_RING_MAGIC   0x52454C42u   // "BLER" 小端
#define RAW_RING_SECTOR  4096u
#define RAW_RING_HDR_LEN 40u           // magic(4) + len(4) + sha256(32)
#define RAW_RING_SHA_LEN 32u

// 单批 JSON 上限（封批器按 16KB 冻结，留足余量防呆）。
#define RAW_RING_MAX_PAYLOAD (24u * 1024u)

typedef struct {
    uint32_t write_off;   // 本次记录应写到的偏移
    uint32_t erase_off;   // 需要先擦除的范围起点（扇区对齐）
    uint32_t erase_end;   // 擦除范围终点（不含）。erase_off == erase_end 表示不用擦
    bool wrapped;         // 本次是否发生了回绕（尾部留白作废）
} raw_ring_plan_t;

static inline uint32_t raw_ring_align4(uint32_t n)
{
    return (n + 3u) & ~3u;
}

// 一条记录占用的总字节数（头 + 对齐后的载荷）。
static inline uint32_t raw_ring_record_len(uint32_t payload_len)
{
    return RAW_RING_HDR_LEN + raw_ring_align4(payload_len);
}

static inline uint32_t raw_ring_sector_ceil(uint32_t off)
{
    return (off + RAW_RING_SECTOR - 1u) & ~(RAW_RING_SECTOR - 1u);
}

// 打包/解析 40B 记录头。parse 校验 magic 与长度合理性，失败返回 false
// （空白 Flash 是全 0xFF，magic 必然不匹配——空分区靠这一点识别）。
void raw_ring_hdr_pack(uint32_t payload_len, const uint8_t sha256[RAW_RING_SHA_LEN],
                       uint8_t out[RAW_RING_HDR_LEN]);
bool raw_ring_hdr_parse(const uint8_t buf[RAW_RING_HDR_LEN], uint32_t *payload_len,
                        uint8_t sha256_out[RAW_RING_SHA_LEN]);

// 环形剩余空间。约定 read == write 表示空（追加规则保证永远留 1 扇区间隔，
// 不存在"满到 read==write"的歧义）。
uint32_t raw_ring_free(uint32_t size, uint32_t write_off, uint32_t read_off);

// 规划一次追加：返回 false 表示空间不足（调用方应触发背压/等上传回收）。
//
// erased_upto：当前这一圈已擦除到的字节偏移（扇区对齐）。
//   开机时由 raw_store 按"write_off 所在扇区的下一扇区边界"初始化——
//   正在写的这个扇区在本圈第一次进入时已经擦过，不能再擦（里面有上一条
//   记录的尾巴）；例外是 write_off 正好扇区对齐（上一圈恰好写满/断电在
//   擦后写前），此时该扇区必须重擦，erased_upto = write_off。
bool raw_ring_plan_append(uint32_t size, uint32_t write_off, uint32_t read_off,
                          uint32_t erased_upto, uint32_t payload_len,
                          raw_ring_plan_t *plan);
