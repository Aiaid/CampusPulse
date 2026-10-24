// main/raw_ring.c —— 实现见 raw_ring.h。纯逻辑，无 SDK 依赖。
#include "raw_ring.h"

#include <string.h>

void raw_ring_hdr_pack(uint32_t payload_len, const uint8_t sha256[RAW_RING_SHA_LEN],
                       uint8_t out[RAW_RING_HDR_LEN])
{
    out[0] = (uint8_t)(RAW_RING_MAGIC & 0xFF);
    out[1] = (uint8_t)((RAW_RING_MAGIC >> 8) & 0xFF);
    out[2] = (uint8_t)((RAW_RING_MAGIC >> 16) & 0xFF);
    out[3] = (uint8_t)((RAW_RING_MAGIC >> 24) & 0xFF);
    out[4] = (uint8_t)(payload_len & 0xFF);
    out[5] = (uint8_t)((payload_len >> 8) & 0xFF);
    out[6] = (uint8_t)((payload_len >> 16) & 0xFF);
    out[7] = (uint8_t)((payload_len >> 24) & 0xFF);
    memcpy(out + 8, sha256, RAW_RING_SHA_LEN);
}

bool raw_ring_hdr_parse(const uint8_t buf[RAW_RING_HDR_LEN], uint32_t *payload_len,
                        uint8_t sha256_out[RAW_RING_SHA_LEN])
{
    const uint32_t magic = (uint32_t)buf[0] | ((uint32_t)buf[1] << 8) |
                           ((uint32_t)buf[2] << 16) | ((uint32_t)buf[3] << 24);
    if (magic != RAW_RING_MAGIC) return false;
    const uint32_t len = (uint32_t)buf[4] | ((uint32_t)buf[5] << 8) |
                         ((uint32_t)buf[6] << 16) | ((uint32_t)buf[7] << 24);
    if (len == 0 || len > RAW_RING_MAX_PAYLOAD) return false;
    if (payload_len) *payload_len = len;
    if (sha256_out) memcpy(sha256_out, buf + 8, RAW_RING_SHA_LEN);
    return true;
}

uint32_t raw_ring_free(uint32_t size, uint32_t write_off, uint32_t read_off)
{
    if (read_off == write_off) return size;      // 空（见头文件约定）
    if (read_off > write_off) return read_off - write_off;
    return size - write_off + read_off;
}

bool raw_ring_plan_append(uint32_t size, uint32_t write_off, uint32_t read_off,
                          uint32_t erased_upto, uint32_t payload_len,
                          raw_ring_plan_t *plan)
{
    if (!plan || payload_len == 0 || payload_len > RAW_RING_MAX_PAYLOAD) return false;
    const uint32_t total = raw_ring_record_len(payload_len);
    // 永远保留 1 个扇区的间隔，read==write 才不会有"空/满"歧义。
    if (total + RAW_RING_SECTOR > size) return false;

    plan->wrapped = false;
    plan->erase_off = plan->erase_end = 0;

    if (write_off + total > size) {
        // 回绕：尾部留白作废，从 0 开始写。开头会擦掉的范围里
        // 不能有未上传的数据（read 必须还在足够靠后的位置）。
        if (read_off < total + RAW_RING_SECTOR) return false;
        plan->write_off = 0;
        plan->erase_off = 0;
        plan->erase_end = raw_ring_sector_ceil(total);
        plan->wrapped = true;
        return true;
    }

    if (raw_ring_free(size, write_off, read_off) < total + RAW_RING_SECTOR) return false;

    plan->write_off = write_off;
    const uint32_t ceil = raw_ring_sector_ceil(write_off + total);
    if (ceil > erased_upto) {
        // 只擦"本圈还没擦过"的扇区。erased_upto 的初始化保证它不会
        // 指向上一条记录所在的扇区（见头文件注释）。
        plan->erase_off = erased_upto;
        plan->erase_end = ceil;
    }
    return true;
}
