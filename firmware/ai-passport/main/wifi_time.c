// wifi_time.c —— 实现见 wifi_time.h。
//
// WiFi 使用走 wifi_link 互斥会话层：和 frame_upload 串行排队用网，
// 谁也不会把谁的连接中途拆掉（重构前两边各自 init/deinit，会互拆，
// 实测症状是烧录后好几分钟对不上时）。
#include "wifi_time.h"
#include "wifi_link.h"

#include "esp_log.h"
#include "esp_sntp.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include <string.h>
#include <time.h>

static const char *TAG = "wifi_time";

#define RESYNC_INTERVAL_MS  (3 * 60 * 1000)  // 每 3 分钟对一次（用户要求 2026-10-22：
                                             // 开机失败等 12h 的代价太大。代价是每次
                                             // 对时 WiFi 醒 ~5~10s，BLE 扫描短暂受影响）
#define CONNECT_TIMEOUT_MS  15000   // 单次会话等待 GOT_IP 的最长时间
#define SYNC_TIMEOUT_MS     10000   // SNTP 等回包的最长时间
#define TIME_VALID_AFTER    1760000000  // 2025-11-13；小于它说明还没对上

static volatile bool s_synced;

// diag_scan 只在首轮或失败后做：它是阻塞式全信道扫描（~1.3s），
// 会抢走 BLE 的射频时间。3 分钟一次的常规对时每次都扫的话，
// 车的 dwell 会被反复打断（2026-10-22，配合 SCAN_DWELL_GAP_MS=20s 双修）。
static bool s_need_diag = true;

// 诊断：扫一圈看目标 AP 在不在。C3 只有 2.4G——目标 AP 不在可见列表里
// 的话连一百年也连不上（5G 路由器 / 名字写错 / 隐藏 SSID）。
static void diag_scan(void)
{
    const wifi_scan_config_t sc = { .show_hidden = true };
    if (esp_wifi_scan_start(&sc, true) != ESP_OK) {   // 阻塞到扫完
        ESP_LOGW(TAG, "扫描启动失败");
        return;
    }
    // 静态分配：24 条约 2.5KB，放栈上会把任务（4KB 栈）撑爆
    // （2026-10-21 实测：rec[24] 局部变量 → Stack protection fault 反复重启）
    static wifi_ap_record_t rec[24];
    uint16_t n = 24;
    if (esp_wifi_scan_get_ap_records(&n, rec) != ESP_OK) return;
    ESP_LOGI(TAG, "2.4G 可见 AP（共 %d 个）：", (int)n);
    for (int i = 0; i < n; i++) {
        ESP_LOGI(TAG, "  \"%s\" rssi=%d auth=%d ch=%d",
                 rec[i].ssid, (int)rec[i].rssi, (int)rec[i].authmode,
                 (int)rec[i].primary);
    }
}

static void do_sync_once(void)
{
    // 每轮一次会话：排上传的队 → 连接 → SNTP → 归还。
    // 失败不再本轮重试（旧版 15s×3 是为"手机热点晚于开机"设计；
    // 现在 3 分钟一轮天然就是重试，且单轮不再阻塞上传 51 秒）。
    if (wifi_link_acquire(CONNECT_TIMEOUT_MS) != ESP_OK) {
        ESP_LOGW(TAG, "WiFi 会话失败，%d 分钟后下一轮",
                 RESYNC_INTERVAL_MS / 60000);
        s_need_diag = true;   // 下一轮扫一圈，看是 AP 没了还是别的
        return;
    }
    if (s_need_diag) {
        diag_scan();
        s_need_diag = false;
    }

    setenv("TZ", "CST-8", 1);       // POSIX：UTC+8 北京，无夏令时
    tzset();
    esp_sntp_setoperatingmode(SNTP_OPMODE_POLL);
    // 校园网实测：域名解析可能被 portal 拦，直接用 IP 绕过 DNS（2026-10-21）。
    // 注意 sdkconfig 里 LWIP_SNTP_MAX_SERVERS=1，只有一个服务器槽位。
    ip_addr_t ntp_ip;
    ipaddr_aton("203.107.6.88", &ntp_ip);          // ntp.aliyun.com
    esp_sntp_setserver(0, &ntp_ip);
    esp_sntp_init();

    bool ok = false;
    for (int i = 0; i < SYNC_TIMEOUT_MS / 500; i++) {
        if (time(NULL) > TIME_VALID_AFTER) { ok = true; break; }
        vTaskDelay(pdMS_TO_TICKS(500));
    }
    esp_sntp_stop();
    wifi_link_release();

    s_synced = ok;
    if (ok) {
        int hh, mm;
        wifi_time_now(&hh, &mm);
        ESP_LOGI(TAG, "对时成功：%02d:%02d（北京时间）", hh, mm);
    } else {
        ESP_LOGW(TAG, "SNTP 未等到回包");
    }
}

static void wifi_time_task(void *arg)
{
    (void)arg;
    for (;;) {
        do_sync_once();
        vTaskDelay(pdMS_TO_TICKS(RESYNC_INTERVAL_MS));
    }
}

void wifi_time_start(void)
{
    static bool started;
    if (started) return;
    started = true;
    xTaskCreate(wifi_time_task, "wifi_time", 4096, NULL, 3, NULL);
}

bool wifi_time_now(int *hh, int *mm)
{
    if (!s_synced) return false;
    const time_t now = time(NULL);
    struct tm tm;
    localtime_r(&now, &tm);
    *hh = tm.tm_hour;
    *mm = tm.tm_min;
    return true;
}
