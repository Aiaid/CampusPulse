// main/raw_store.c —— 实现见 raw_store.h。
#include "raw_store.h"

#include "raw_ring.h"

#include "esp_log.h"
#include "esp_partition.h"
#include "nvs.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include <string.h>

static const char *TAG = "raw_store";

#define NVS_NS        "rawstore"
#define NVS_KEY_READ  "read_off"
#define NVS_KEY_SEQ   "batch_seq"

static const esp_partition_t *s_part;
static uint32_t s_size;
static uint32_t s_write_off;
static uint32_t s_read_off;
static uint32_t s_erased_upto;
static uint32_t s_pending;
static uint32_t s_seq;
static bool s_ready;
static volatile bool s_erasing;   // 全擦进行中：擦写接口一律让路

static esp_err_t read_at(uint32_t off, void *buf, uint32_t len)
{
    return esp_partition_read(s_part, off, buf, len);
}

static void nvs_save(void)
{
    nvs_handle_t h;
    if (nvs_open(NVS_NS, NVS_READWRITE, &h) != ESP_OK) return;
    nvs_set_u32(h, NVS_KEY_READ, s_read_off);
    nvs_set_u32(h, NVS_KEY_SEQ, s_seq);
    nvs_commit(h);
    nvs_close(h);
}

// 从某个候选起点逐条向后校验，找到"数据末尾"（第一条头不合法的记录）。
// 回绕复刻追加规则：一条记录放不下尾部时跳到 0。
static uint32_t walk_to_end(uint32_t from, uint32_t *pending_out)
{
    uint32_t off = from;
    uint32_t pending = 0;
    uint8_t hdr[RAW_RING_HDR_LEN];
    for (;;) {
        uint32_t len = 0;
        if (off + RAW_RING_HDR_LEN > s_size ||
            read_at(off, hdr, sizeof(hdr)) != ESP_OK ||
            !raw_ring_hdr_parse(hdr, &len, NULL)) {
            break;
        }
        if (off + raw_ring_record_len(len) > s_size) {
            off = 0;                      // 回绕点
            continue;
        }
        off += raw_ring_record_len(len);
        if (off >= s_size) off = 0;
        pending++;
        if (pending > s_size / RAW_RING_HDR_LEN) break;   // 防呆：不可能有这么多条
    }
    if (pending_out) *pending_out = pending;
    return off;
}

esp_err_t raw_store_init(void)
{
    if (s_ready) return ESP_OK;
    s_part = esp_partition_find_first(ESP_PARTITION_TYPE_DATA,
                                      (esp_partition_subtype_t)0x99, "ble_raw");
    if (!s_part) {
        ESP_LOGW(TAG, "找不到 ble_raw 分区，原始帧存储不可用");
        return ESP_ERR_NOT_FOUND;
    }
    s_size = (uint32_t)s_part->size;

    // NVS 里的读指针只是"上次记得的位置"，必须真的指着一条合法记录才采信；
    // 否则从头走一遍（比如分区被整体擦过、或换了固件布局）。
    s_read_off = 0;
    s_seq = 0;
    nvs_handle_t h;
    if (nvs_open(NVS_NS, NVS_READONLY, &h) == ESP_OK) {
        uint32_t saved_read = 0;
        if (nvs_get_u32(h, NVS_KEY_READ, &saved_read) == ESP_OK &&
            saved_read + RAW_RING_HDR_LEN <= s_size) {
            uint8_t hdr[RAW_RING_HDR_LEN];
            if (read_at(saved_read, hdr, sizeof(hdr)) == ESP_OK &&
                raw_ring_hdr_parse(hdr, NULL, NULL)) {
                s_read_off = saved_read;
            }
        }
        nvs_get_u32(h, NVS_KEY_SEQ, &s_seq);
        nvs_close(h);
    }

    s_write_off = walk_to_end(s_read_off, &s_pending);
    // erased_upto 的取值规则见 raw_ring.h：扇区对齐时必须重擦当前扇区，
    // 否则信任"正在写的扇区在本圈进入时已擦"。
    s_erased_upto = (s_write_off % RAW_RING_SECTOR == 0)
                        ? s_write_off
                        : raw_ring_sector_ceil(s_write_off);
    s_ready = true;
    ESP_LOGI(TAG, "ble_raw @0x%lx 共 %luKB：待传 %lu 批，写指针 %lu，已用 %lu%%",
             (unsigned long)s_part->address, (unsigned long)(s_size / 1024),
             (unsigned long)s_pending, (unsigned long)s_write_off,
             (unsigned long)raw_store_used_pct());
    return ESP_OK;
}

esp_err_t raw_store_append(const void *payload, uint32_t len,
                           const uint8_t sha256[32])
{
    if (!s_ready) return ESP_ERR_INVALID_STATE;
    if (!payload || !sha256) return ESP_ERR_INVALID_ARG;
    if (s_erasing) return ESP_ERR_NO_MEM;   // 全擦中：当背压丢弃本批

    raw_ring_plan_t plan;
    if (!raw_ring_plan_append(s_size, s_write_off, s_read_off, s_erased_upto,
                              len, &plan)) {
        return ESP_ERR_NO_MEM;      // 背压：空间先留给已采未传
    }
    if (plan.erase_end > plan.erase_off) {
        const esp_err_t err = esp_partition_erase_range(s_part, plan.erase_off,
                                                        plan.erase_end - plan.erase_off);
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "擦除失败 @%lu+%lu: %s", (unsigned long)plan.erase_off,
                     (unsigned long)(plan.erase_end - plan.erase_off),
                     esp_err_to_name(err));
            return err;
        }
        s_erased_upto = plan.erase_end;
    }

    uint8_t hdr[RAW_RING_HDR_LEN];
    raw_ring_hdr_pack(len, sha256, hdr);
    esp_err_t err = esp_partition_write(s_part, plan.write_off, hdr, sizeof(hdr));
    if (err == ESP_OK) {
        err = esp_partition_write(s_part, plan.write_off + RAW_RING_HDR_LEN,
                                  payload, len);
    }
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "写入失败 @%lu: %s", (unsigned long)plan.write_off,
                 esp_err_to_name(err));
        return err;
    }
    // 对齐填充留在擦除态（0xFF）即可，不用写。

    s_write_off = plan.write_off + raw_ring_record_len(len);
    if (s_write_off >= s_size) s_write_off = 0;
    s_pending++;
    return ESP_OK;
}

uint32_t raw_store_pending(void)
{
    return s_ready ? s_pending : 0;
}

uint32_t raw_store_oldest_len(void)
{
    if (!s_ready || s_erasing || s_pending == 0) return 0;
    uint8_t hdr[RAW_RING_HDR_LEN];
    uint32_t len = 0;
    if (read_at(s_read_off, hdr, sizeof(hdr)) != ESP_OK ||
        !raw_ring_hdr_parse(hdr, &len, NULL)) {
        return 0;
    }
    return len;
}

esp_err_t raw_store_oldest_peek(void *buf, uint32_t cap, uint32_t *out_len,
                                uint8_t sha256_out[32])
{
    if (!s_ready || s_erasing) return ESP_ERR_INVALID_STATE;
    if (s_pending == 0) return ESP_ERR_NOT_FOUND;
    uint8_t hdr[RAW_RING_HDR_LEN];
    uint32_t len = 0;
    esp_err_t err = read_at(s_read_off, hdr, sizeof(hdr));
    if (err != ESP_OK) return err;
    if (!raw_ring_hdr_parse(hdr, &len, sha256_out)) return ESP_ERR_INVALID_RESPONSE;
    if (len > cap) return ESP_ERR_INVALID_SIZE;
    err = read_at(s_read_off + RAW_RING_HDR_LEN, buf, len);
    if (err != ESP_OK) return err;
    if (out_len) *out_len = len;
    return ESP_OK;
}

esp_err_t raw_store_drop_oldest(void)
{
    if (!s_ready || s_erasing) return ESP_ERR_INVALID_STATE;
    if (s_pending == 0) return ESP_ERR_NOT_FOUND;
    const uint32_t len = raw_store_oldest_len();
    if (len == 0) return ESP_ERR_INVALID_RESPONSE;
    uint32_t next = s_read_off + raw_ring_record_len(len);
    if (next >= s_size) next = 0;
    uint8_t hdr[RAW_RING_HDR_LEN];
    bool next_valid =
        next != 0 &&
        next + RAW_RING_HDR_LEN <= s_size &&
        read_at(next, hdr, sizeof(hdr)) == ESP_OK &&
        raw_ring_hdr_parse(hdr, NULL, NULL);
    if (!next_valid && s_pending > 1 && next != 0) {
        // 后面本该还有记录但此处头不合法：先按"写侧回绕"处理——
        // 回绕时尾部留白作废、记录写在 0 偏移，头必然在 0 处合法。
        if (read_at(0, hdr, sizeof(hdr)) == ESP_OK &&
            raw_ring_hdr_parse(hdr, NULL, NULL)) {
            next = 0;
            next_valid = true;
        } else {
            // 0 处也不合法：数据已损坏。与其逐字节猜，不如直接清空重采——
            // 这种路径正常到不了（断电损坏由开机校验兜底）。
            ESP_LOGE(TAG, "读指针后记录损坏（剩 %lu 批），清空重采",
                     (unsigned long)(s_pending - 1));
            s_read_off = s_write_off;
            s_pending = 0;
            nvs_save();
            return ESP_OK;
        }
    }
    s_read_off = next;
    s_pending--;
    nvs_save();
    return ESP_OK;
}

uint32_t raw_store_used_pct(void)
{
    if (!s_ready || s_size == 0) return 0;
    const uint32_t free_b = raw_ring_free(s_size, s_write_off, s_read_off);
    return (uint32_t)(((uint64_t)(s_size - free_b) * 100u) / s_size);
}

uint32_t raw_store_next_seq(void)
{
    return s_ready ? s_seq : 0;
}

// 供 frame_batch 在封批成功后推进序号（只有真正入库的批才消耗号）。
void raw_store_bump_seq(void)
{
    if (!s_ready) return;
    s_seq++;
    nvs_save();
}

// ---------------------------------------------------------------------------
// 全擦：UI"全部清零"用。4MB 分区擦完要十几秒到几十秒，放独立任务里做，
// 否则会把 LVGL 的输入/刷新卡死。擦除期间读写接口按失败让路。
// ---------------------------------------------------------------------------
static void erase_all_task(void *arg)
{
    (void)arg;
    ESP_LOGW(TAG, "开始擦除 ble_raw（%luKB），期间采集暂停入库",
             (unsigned long)(s_size / 1024));

    const esp_err_t err = esp_partition_erase_range(s_part, 0, s_size);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "擦除失败：%s（数据保持原样）", esp_err_to_name(err));
        s_erasing = false;
        vTaskDelete(NULL);
        return;
    }

    s_read_off   = 0;
    s_write_off  = 0;
    s_erased_upto = 0;
    s_pending    = 0;
    // s_seq 故意不回零：batch/window 序号继续单调，避免服务端看到重复序号。
    nvs_save();

    s_erasing = false;
    ESP_LOGI(TAG, "ble_raw 已清空：待传 0 批，已用 0%%");
    vTaskDelete(NULL);
}

esp_err_t raw_store_erase_all(void)
{
    if (!s_ready) return ESP_ERR_INVALID_STATE;
    if (s_erasing) return ESP_ERR_INVALID_STATE;    // 上一轮还没擦完

    s_erasing = true;
    if (xTaskCreate(erase_all_task, "raw_erase", 3072, NULL, 3, NULL) != pdPASS) {
        s_erasing = false;
        return ESP_ERR_NO_MEM;
    }
    return ESP_OK;
}

bool raw_store_erasing(void)
{
    return s_erasing;
}
