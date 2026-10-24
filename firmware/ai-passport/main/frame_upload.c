// main/frame_upload.c —— 实现见 frame_upload.h。
#include "frame_upload.h"

#include "raw_store.h"
#include "scan_ble.h"
#include "wifi_link.h"       // 互斥 WiFi 会话（与 wifi_time 串行排队用网）

#include "esp_crt_bundle.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// 身份与服务器：真实值放 device_cred_local.h（gitignore）。
#if __has_include("device_cred_local.h")
#include "device_cred_local.h"
#endif
#ifndef DEVICE_CREDENTIAL
#define DEVICE_CREDENTIAL ""
#endif
#ifndef INGEST_URL
#define INGEST_URL "https://pulse.anend.net/api/v1/ingest"
#endif

static const char *TAG = "frame_upload";

#define UPLOAD_INTERVAL_MS  (60 * 1000)   // 用户拍板：每分钟一轮
#define EARLY_UPLOAD_PCT    75            // 水位到 75% 不等周期，提前传
#define CONNECT_TIMEOUT_MS  10000         // 单次连接上限（连不上就放弃本轮）
#define HTTP_TIMEOUT_MS     30000   // 隧道联调链路 RTT 高，15s 不够用
#define BATCH_BUF_MAX       (20 * 1024)   // 单批上限（封批侧 16KB + 余量）
#define RESP_BUF_MAX        1024

static uint32_t s_sent;
static uint32_t s_failed;
static uint32_t s_quarantined;
static volatile bool s_active;
static bool s_started;

// ---- HTTP 响应收集（ACK 核对要用响应体） ----
static char s_resp[RESP_BUF_MAX];
static int s_resp_len;

static esp_err_t on_http(esp_http_client_event_t *e)
{
    if (e->event_id == HTTP_EVENT_ON_DATA &&
        s_resp_len + e->data_len < RESP_BUF_MAX) {
        memcpy(s_resp + s_resp_len, e->data, e->data_len);
        s_resp_len += e->data_len;
        s_resp[s_resp_len] = '\0';
    }
    return ESP_OK;
}

// ---- 单批上传：true=已回收 / false=保留（下轮重试） / 契约拒收直接丢弃 ----
// 返回 1=成功 0=失败保留 -1=服务端拒收（409/410/422）
static int post_one(const uint8_t *body, uint32_t len, const char *sha_hex)
{
    s_resp_len = 0;
    s_resp[0] = '\0';
    char auth[160];
    snprintf(auth, sizeof(auth), "Bearer %s", DEVICE_CREDENTIAL);

    esp_http_client_config_t cfg = {
        .url = INGEST_URL,
        .method = HTTP_METHOD_POST,
        .timeout_ms = HTTP_TIMEOUT_MS,
        .event_handler = on_http,
        .crt_bundle_attach = esp_crt_bundle_attach,
    };
    esp_http_client_handle_t cli = esp_http_client_init(&cfg);
    if (!cli) return 0;
    esp_http_client_set_header(cli, "Authorization", auth);
    esp_http_client_set_header(cli, "X-Body-SHA256", sha_hex);
    esp_http_client_set_header(cli, "Content-Type", "application/json");
    esp_http_client_set_post_field(cli, (const char *)body, (int)len);
    const esp_err_t err = esp_http_client_perform(cli);
    const int code = esp_http_client_get_status_code(cli);
    esp_http_client_cleanup(cli);

    if (err != ESP_OK) {
        ESP_LOGW(TAG, "POST 失败: %s", esp_err_to_name(err));
        return 0;
    }
    if (code == 409 || code == 410 || code == 422) {
        ESP_LOGE(TAG, "服务端拒收（%d），隔离丢弃：%.120s", code, s_resp);
        return -1;
    }
    if (code != 200) {
        ESP_LOGW(TAG, "HTTP %d，保留重试：%.120s", code, s_resp);
        return 0;
    }
    // ACK 逐字段核对（宽松版，契约文档到手后换精确解析）：
    // 响应里必须同时找得到 batch_id 和 body 的 SHA-256。
    // batch_id 从冻结 JSON 头里抠（"batch_id":"xxx"）。
    char bid[80] = {0};
    const char *p = strstr((const char *)body, "\"batch_id\":\"");
    if (p) {
        p += 12;
        const char *q = strchr(p, '"');
        if (q && q - p < (int)sizeof(bid)) {
            memcpy(bid, p, (size_t)(q - p));
        }
    }
    const bool ack_ok = bid[0] && strstr(s_resp, bid) &&
                        strstr(s_resp, sha_hex);
    if (!ack_ok) {
        ESP_LOGW(TAG, "ACK 字段对不上（bid=%s），保留重试：%.200s", bid, s_resp);
        return 0;
    }
    return 1;
}

// 一轮上传。返回 true 表示"所有待传批都传完了"。
// *connect_failed 置位 = 败在"连不上 WiFi"（没网），区别于"有网但传失败"：
// 两者退避策略不同（见 upload_task）。
//
// 顺序有讲究：**先连 WiFi，连上了才挂起扫描**。反过来（先挂起再连）的话，
// 断网期间每轮都会白挂起 10 秒才发现没网——无网一整天就是持续的
// 无用空窗（2026-10-23 用户指出的缺陷）。
static bool upload_round(bool *connect_failed)
{
    if (raw_store_pending() == 0) return true;
    *connect_failed = false;
    if (wifi_link_acquire(CONNECT_TIMEOUT_MS) != ESP_OK) {
        *connect_failed = true;
        ESP_LOGW(TAG, "WiFi 连不上，本轮放弃（数据保留，退避后重试）");
        return false;
    }
    // 连上了才挂起：空窗只罩住真正的传输时间
    ESP_LOGI(TAG, "开始上传：待传 %lu 批，挂起 BLE 扫描",
             (unsigned long)raw_store_pending());
    s_active = true;
    scan_ble_suspend();

    bool done = true;
    {
        uint8_t *buf = malloc(BATCH_BUF_MAX);
        if (!buf) {
            ESP_LOGE(TAG, "批缓冲分配失败");
            done = false;
        } else {
            while (raw_store_pending() > 0) {
                uint8_t sha[32];
                uint32_t len = 0;
                if (raw_store_oldest_peek(buf, BATCH_BUF_MAX, &len, sha) != ESP_OK) {
                    ESP_LOGE(TAG, "读取最老批失败，本轮中止");
                    done = false;
                    break;
                }
                char sha_hex[65];
                for (int i = 0; i < 32; i++) snprintf(sha_hex + i * 2, 3, "%02x", sha[i]);
                const int r0 = post_one(buf, len, sha_hex);
                int r = r0;
                if (r0 == 0) {
                    // 同一次 WiFi 会话里先重试一次：校园网瞬时抖动很常见，
                    // 等到下一分钟要重新关联 + TLS 握手，代价更高。
                    vTaskDelay(pdMS_TO_TICKS(800));
                    r = post_one(buf, len, sha_hex);
                }
                if (r == 0) { done = false; break; }   // 网络/5xx：留下轮
                raw_store_drop_oldest();               // ACK 通过 或 隔离丢弃
                if (r > 0) {
                    s_sent++;
                    ESP_LOGI(TAG, "已上传回收（剩 %lu 批）",
                             (unsigned long)raw_store_pending());
                } else {
                    s_quarantined++;
                }
            }
            free(buf);
        }
    }

    scan_ble_resume();
    s_active = false;
    wifi_link_release();
    ESP_LOGI(TAG, "本轮结束，扫描已恢复（待传 %lu 批，已用 %lu%%）",
             (unsigned long)raw_store_pending(),
             (unsigned long)raw_store_used_pct());
    return done;
}

static void upload_task(void *arg)
{
    (void)arg;
    uint32_t backoff_ms = 0;   // 0 = 按正常周期
    for (;;) {
        uint32_t wait_ms = backoff_ms ? backoff_ms : UPLOAD_INTERVAL_MS;
        if (backoff_ms) {
            // 退避期不抢跑：网络刚失败，立刻再试只会复现同样的失败。
            vTaskDelay(pdMS_TO_TICKS(wait_ms));
        } else {
            // 正常周期按 1 秒粒度等，让"水位逼近上限提前传"有机会生效
            // （2026-10-23：此前的 EARLY_UPLOAD_PCT 只在启动日志里出现过，
            //  从没参与判断，等于水位满了也得等满 60 秒）。
            while (wait_ms > 0) {
                const uint32_t step = wait_ms > 1000u ? 1000u : wait_ms;
                vTaskDelay(pdMS_TO_TICKS(step));
                wait_ms -= step;
                if (raw_store_pending() > 0 &&
                    raw_store_used_pct() >= EARLY_UPLOAD_PCT) {
                    ESP_LOGW(TAG, "存储已用 %lu%%（>=%d%%），不等周期，提前上传",
                             (unsigned long)raw_store_used_pct(),
                             EARLY_UPLOAD_PCT);
                    break;
                }
            }
        }
        if (raw_store_pending() == 0) continue;
        bool connect_failed = false;
        if (upload_round(&connect_failed)) {
            backoff_ms = 0;
        } else {
            // 没网（连不上 WiFi）：长退避 5、10…300 秒封顶——网络半天
            // 不会好，省得一遍遍白尝试（数据在 Flash 里丢不了）。
            // 有网但传失败（5xx 等）：契约的 1、2、4…60 秒。
            const uint32_t start = connect_failed ? 5000 : 1000;
            const uint32_t cap   = connect_failed ? 300000 : 60000;
            backoff_ms = backoff_ms ? backoff_ms * 2 : start;
            if (backoff_ms > cap) backoff_ms = cap;
            s_failed++;
            ESP_LOGW(TAG, "本轮未传完，%lu 秒后重试",
                     (unsigned long)(backoff_ms / 1000));
        }
    }
}

void frame_upload_start(void)
{
    if (s_started) return;
    s_started = true;
    if (DEVICE_CREDENTIAL[0] == '\0') {
        ESP_LOGW(TAG, "未配置设备凭据，上传器休眠（采集存储照常）");
        return;
    }
    // 栈 8KB：esp_http_client_perform 要在本任务栈里做 TLS 握手 + 证书
    // 验证，调用链很深。官方 http_request 示例用的就是 8192；6KB 属于
    // 能跑但没余量（§5.41 有过 wifi 任务栈撑爆直接重启的前科）。
    if (xTaskCreate(upload_task, "frame_upload", 8192, NULL, 4, NULL) != pdPASS) {
        ESP_LOGE(TAG, "上传任务创建失败");
        return;
    }
    ESP_LOGI(TAG, "上传器已启动：每 %ds 一轮，水位 %d%% 提前，目标 %s",
             UPLOAD_INTERVAL_MS / 1000, EARLY_UPLOAD_PCT, INGEST_URL);
}

uint32_t frame_upload_sent(void)         { return s_sent; }
uint32_t frame_upload_failed(void)       { return s_failed; }
uint32_t frame_upload_quarantined(void)  { return s_quarantined; }
bool frame_upload_active(void)           { return s_active; }
