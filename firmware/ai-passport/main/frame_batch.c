// main/frame_batch.c —— 实现见 frame_batch.h。
#include "frame_batch.h"

#include "raw_store.h"
#include "scan_ble.h"

#include "esp_log.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "mbedtls/sha256.h"
#include <stdio.h>
#include <string.h>

// 设备身份：真实值放 device_cred_local.h（gitignore，模板见 .example.h）。
#if __has_include("device_cred_local.h")
#include "device_cred_local.h"
#endif
#ifndef DEVICE_NODE_ID
#define DEVICE_NODE_ID "dev-local"
#endif
// 上云定位三元组 + 采集配置 ID：必须与服务端 capture_configs 登记的完全一致，
// 否则 422 capture_config_mismatch（批会被隔离丢弃，别写错）。
#ifndef CAPTURE_PLACEMENT_ID
#define CAPTURE_PLACEMENT_ID "campus-test-1"
#endif
#ifndef CAPTURE_CONFIG_ID
#define CAPTURE_CONFIG_ID "cfg-node1-field"
#endif
// 原始帧抽样：服务端 capture_config 的 raw_capture.mode=sampled 时，
// 只接受 seq % sample_every_n == 0 的帧（否则 422 items[n].seq）。
#ifndef CAPTURE_SAMPLE_EVERY_N
#define CAPTURE_SAMPLE_EVERY_N 1
#endif
#ifndef CAPTURE_DATASET
#define CAPTURE_DATASET "field"
#endif

static const char *TAG = "frame_batch";

#define QUEUE_DEPTH        64
#define BATCH_MAX_FRAMES   32                 // 契约：凑满 32 条封批
#define FLUSH_MAX_AGE_MS   60000              // 契约：最老的帧满 60 秒封批
#define JSON_CAP           (16 * 1024)        // 契约：单批 16KB 上限
#define FRAME_JSON_MAX     300                // 单帧 JSON 的最坏长度（含逗号）
#define JSON_SEAL_MARGIN   (JSON_CAP - FRAME_JSON_MAX - 16)

// 背压水位（ble_raw 已用百分比）
#define WM_WARN_PCT        60
#define WM_PAUSE_PCT       80
#define WM_RESUME_PCT      70

// 原始帧记录。52B 定长：队列静态分配，无堆碎片。
typedef struct {
    uint32_t seq;             // 采集序号（本机单调，排查丢帧用）
    uint32_t ts_ms;           // 采集时刻（esp_timer ms）
    uint8_t addr[6];          // NimBLE 原始小端地址
    uint8_t addr_type;
    uint8_t event_type;       // 0=ADV_IND ... 4=SCAN_RSP
    int8_t rssi;
    uint8_t len;              // ad 有效长度（legacy 上限 31）
    uint8_t ad[31];
} raw_frame_t;

static StaticQueue_t s_qcb;
static uint8_t s_qstorage[QUEUE_DEPTH * sizeof(raw_frame_t)];
static QueueHandle_t s_queue;

static char s_json[JSON_CAP]; // 正在拼接的批（静态 16KB，避免堆碎片）
static uint32_t s_pos;
static uint32_t s_count;
static uint32_t s_first_ts;

static volatile bool s_paused;    // 背压停采
static uint32_t s_seq;            // 采集序号
static uint32_t s_frames;         // 累计入队
static uint32_t s_dropped;
static uint32_t s_batches;
static uint32_t s_lost;
static bool s_started;

static uint32_t now_ms(void)
{
    return (uint32_t)(esp_timer_get_time() / 1000);
}

// ---- campuspulse/1 契约的常量映射（校验规则见 ai-ladar/worker/ingest-validation.ts）----

// NimBLE 地址类型 → 契约 identity.address_type 枚举。
static const char *addr_type_name(uint8_t t)
{
    switch (t) {
    case 0:  return "public";
    case 1:  return "random";
    case 2:  return "public_identity";
    case 3:  return "random_identity";
    default: return "unknown";      // 0xFF 匿名等
    }
}

// HCI legacy 广播事件类型 → 契约 report_type 枚举（3=SCAN_REQ 不会上报）。
static const char *report_type_name(uint8_t t)
{
    switch (t) {
    case 0:  return "adv_ind";
    case 1:  return "adv_direct_ind";
    case 2:  return "adv_scan_ind";
    case 3:  return "adv_nonconn_ind";
    case 4:  return "scan_rsp";
    default: return "unknown";
    }
}

// UUID v4（服务端对 batch_id/boot_id 强校验 8-4-4-4-12 小写 + 版本位 + 变体位）。
static void gen_uuid_v4(char out[37])
{
    uint32_t w[4];
    for (int i = 0; i < 4; i++) w[i] = esp_random();
    w[1] = (w[1] & 0xFFFF0FFFu) | 0x00004000u;   // version 4
    w[2] = (w[2] & 0x3FFFFFFFu) | 0x80000000u;   // variant 10xx
    snprintf(out, 37, "%08x-%04x-%04x-%04x-%04x%08x",
             (unsigned)w[0], (unsigned)(w[1] >> 16), (unsigned)(w[1] & 0xFFFFu),
             (unsigned)(w[2] >> 16), (unsigned)(w[2] & 0xFFFFu), (unsigned)w[3]);
}

static char s_boot_id[37];    // 本次开机一个，用于服务端归组

// NimBLE host 任务里的 tap：只做"分配序号 + 打时间戳 + 塞队列"，
// 不解析、不阻塞（AGENTS.md 与契约的硬性要求）。
static void on_raw_frame(const uint8_t addr[6], uint8_t addr_type,
                         uint8_t event_type, int8_t rssi,
                         const uint8_t *data, uint8_t len)
{
    if (s_paused || !s_queue) {
        s_dropped++;
        return;
    }
    // 序号统计的是"看到的所有帧"，抽样只影响入队——这样 seq 与服务端
    // seq_mod_n 的选择口径一致（第 280、560、840… 帧被选中）。
    const uint32_t seq = ++s_seq;
    if (CAPTURE_SAMPLE_EVERY_N > 1 && (seq % CAPTURE_SAMPLE_EVERY_N) != 0) {
        return;                     // 采样跳过：不算丢帧
    }
    // 服务端 capture_config 是 passive 扫描：scan_rsp 帧属于主动探测的产物，
    // 会触发 422 items[n].report_type，直接不上传（聚合计数里仍保留）。
    if (event_type == 4) {
        return;
    }
    raw_frame_t f;
    f.seq = seq;
    f.ts_ms = now_ms();
    memcpy(f.addr, addr, 6);
    f.addr_type = addr_type;
    f.event_type = event_type;
    f.rssi = rssi;
    f.len = len > 31 ? 31 : len;    // legacy ADV 上限 31，超长截断防呆
    memset(f.ad, 0, sizeof(f.ad));
    if (data && f.len) memcpy(f.ad, data, f.len);
    if (xQueueSend(s_queue, &f, 0) != pdTRUE) {
        s_dropped++;                // 队列满：封批任务没跟上，丢帧记数
        return;
    }
    s_frames++;
}

static int fmt_frame(char *out, size_t cap, const raw_frame_t *f)
{
    char ad_hex[63];
    // 契约 payload_hex 是**小写** hex（[0-9a-f] 正则）。
    for (int i = 0; i < f->len; i++) {
        snprintf(ad_hex + i * 2, 3, "%02x", f->ad[i]);
    }
    ad_hex[f->len * 2] = '\0';
    // time：utc_ms/clock_epoch 先给"未对时"口径（null/0），SNTP 对齐后
    // 接入真实墙钟是下一步（服务端只做单调性校验，不拒绝 null）。
    // identity：demo 节点（cp-demo-03）只允许 scheme:"none"，不含地址身份。
    return snprintf(out, cap,
                    "{\"seq\":%lu,\"time\":{\"mono_ms\":%lu,\"utc_ms\":null,"
                    "\"clock_epoch\":0,\"uncertainty_ms\":null},"
                    "\"window_seq\":%lu,"
                    "\"identity\":{\"scheme\":\"none\"},"
                    "\"rssi_dbm\":%d,\"report_type\":\"%s\","
                    "\"report_type_code\":%u,\"format\":\"legacy_ad\","
                    "\"payload_length\":%u,\"payload_hex\":\"%s\"}",
                    (unsigned long)f->seq, (unsigned long)f->ts_ms,
                    (unsigned long)f->seq / BATCH_MAX_FRAMES + 1,
                    (int)f->rssi, report_type_name(f->event_type),
                    (unsigned)f->event_type,
                    (unsigned)f->len, ad_hex);
}

static void open_batch(void)
{
    // campuspulse/1 信封（服务端逐字段强校验，缺一个字段整个批 422）。
    // batch_id 用"即将消耗的序号"预拼：封批任务只有一个，不会并发消耗。
    char bid[37];
    gen_uuid_v4(bid);
    s_pos = (uint32_t)snprintf(s_json, JSON_CAP,
                               "{\"protocol\":\"campuspulse/1\","
                               "\"batch_id\":\"%s\","
                               "\"node_id\":\"%s\","
                               "\"boot_id\":\"%s\","
                               "\"placement_id\":\"%s\","
                               "\"capture_config_id\":\"%s\","
                               "\"dataset\":\"%s\","
                               "\"stream\":\"ble_reports\","
                               "\"firmware_version\":\"esp32c3-0.3.0\","
                               "\"items\":[",
                               bid,
                               DEVICE_NODE_ID,
                               s_boot_id,
                               CAPTURE_PLACEMENT_ID,
                               CAPTURE_CONFIG_ID,
                               CAPTURE_DATASET);
    s_count = 0;
}

static void seal_batch(void)
{
    if (s_count == 0) return;
    // 信封只允许契约字段，帧数不能塞进 JSON（服务端拒绝未知字段），
    // 条数校验交给 items 数组本身。
    s_pos += (uint32_t)snprintf(s_json + s_pos, JSON_CAP - s_pos, "]}");

    uint8_t sha[32];
    mbedtls_sha256((const uint8_t *)s_json, s_pos, sha, 0);

    const esp_err_t err = raw_store_append(s_json, s_pos, sha);
    if (err == ESP_OK) {
        raw_store_bump_seq();
        s_batches++;
        ESP_LOGI(TAG, "封批入库：%lu 帧 %luB（待传 %lu 批，已用 %lu%%）",
                 (unsigned long)s_count, (unsigned long)s_pos,
                 (unsigned long)raw_store_pending(),
                 (unsigned long)raw_store_used_pct());
    } else {
        // Flash 满到背压都没拦住：丢整批。数据在源头还在采，
        // 比"卡死等空间"更符合采集设备的取舍。
        s_lost++;
        ESP_LOGE(TAG, "入库失败（%s），丢弃本批 %lu 帧",
                 esp_err_to_name(err), (unsigned long)s_count);
    }

    // 水位背压：80% 停采新帧（丢新不丢旧），回落到 70% 以下恢复。
    const uint32_t used = raw_store_used_pct();
    if (!s_paused && used >= WM_PAUSE_PCT) {
        s_paused = true;
        ESP_LOGW(TAG, "已用 %lu%% ≥ %d%%，暂停采新帧，等上传回收",
                 (unsigned long)used, WM_PAUSE_PCT);
    } else if (s_paused && used < WM_RESUME_PCT) {
        s_paused = false;
        ESP_LOGI(TAG, "已用 %lu%% 回落，恢复采集", (unsigned long)used);
    } else if (used >= WM_WARN_PCT) {
        ESP_LOGW(TAG, "水位告警：ble_raw 已用 %lu%%", (unsigned long)used);
    }

    s_pos = 0;
    s_count = 0;
}

static void batch_task(void *arg)
{
    (void)arg;
    uint32_t last_stat_ms = now_ms();
    uint32_t last_seq = 0, last_enq = 0;

    for (;;) {
        // 每分钟打一行吞吐观测：看到多少帧、多少进了队列（抽样后）、丢了多少。
        const uint32_t t_now = now_ms();
        if (t_now - last_stat_ms >= 60000) {
            ESP_LOGI(TAG, "吞吐：观测 %lu 帧/分，入队 %lu 帧/分，丢 %lu 帧（抽样 1/%d）",
                     (unsigned long)(s_seq - last_seq),
                     (unsigned long)(s_frames - last_enq),
                     (unsigned long)s_dropped, CAPTURE_SAMPLE_EVERY_N);
            last_stat_ms = t_now;
            last_seq = s_seq;
            last_enq = s_frames;
        }

        // 60 秒最长等待：缓冲非空时按"最老帧的剩余寿命"设超时，
        // 到点即使没凑满 32 条也要封批（契约 flush_max_age_ms）。
        TickType_t wait = portMAX_DELAY;
        if (s_count > 0) {
            const uint32_t age = now_ms() - s_first_ts;
            wait = age >= FLUSH_MAX_AGE_MS ? 0
                                           : pdMS_TO_TICKS(FLUSH_MAX_AGE_MS - age);
        }

        raw_frame_t f;
        if (xQueueReceive(s_queue, &f, wait) != pdTRUE) {
            seal_batch();           // 到点封批（空缓冲时 seal 是空操作）
            continue;
        }

        if (s_count > 0 && s_pos > JSON_SEAL_MARGIN) {
            seal_batch();           // 16KB 上限：先封，当前帧进下一批
        }
        if (s_count == 0) {
            open_batch();
            s_first_ts = f.ts_ms;
        } else {
            s_json[s_pos++] = ',';
        }
        s_pos += (uint32_t)fmt_frame(s_json + s_pos, JSON_CAP - s_pos, &f);
        s_count++;

        if (s_count >= BATCH_MAX_FRAMES) {
            seal_batch();           // 凑满 32 条
        }
    }
}

void frame_batch_start(void)
{
    if (s_started) return;
    s_started = true;

    gen_uuid_v4(s_boot_id);     // campuspulse/1：boot_id 每次上电重新生成

    if (raw_store_init() != ESP_OK) {
        ESP_LOGW(TAG, "存储层不可用，原始帧采集未启用");
        return;
    }

    s_queue = xQueueCreateStatic(QUEUE_DEPTH, sizeof(raw_frame_t),
                                 s_qstorage, &s_qcb);
    if (!s_queue) {
        ESP_LOGE(TAG, "队列创建失败");
        return;
    }
    // 优先级 5：低于 NimBLE host（采集不能被堵），高于 UI。
    if (xTaskCreate(batch_task, "frame_batch", 4096, NULL, 5, NULL) != pdPASS) {
        ESP_LOGE(TAG, "封批任务创建失败");
        return;
    }
    scan_ble_set_raw_sink(on_raw_frame);
    ESP_LOGI(TAG, "原始帧采集已启用：node=%s，%d 帧/%dKB/%ds 封批",
             DEVICE_NODE_ID, BATCH_MAX_FRAMES, JSON_CAP / 1024,
             FLUSH_MAX_AGE_MS / 1000);
}

uint32_t frame_batch_frames(void)  { return s_frames; }
uint32_t frame_batch_dropped(void) { return s_dropped; }
uint32_t frame_batch_batches(void) { return s_batches; }
uint32_t frame_batch_lost(void)    { return s_lost; }
