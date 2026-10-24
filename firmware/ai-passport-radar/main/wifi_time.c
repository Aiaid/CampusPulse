// wifi_time.c —— 实现见 wifi_time.h。
#include "wifi_time.h"
#if __has_include("wifi_cred_local.h")
#include "wifi_cred_local.h"     // Optional ignored local WIFI_SSID / WIFI_PASS.
#endif

#if defined(WIFI_SSID) && defined(WIFI_PASS)
#include "demo_radio.h"          // demo_radio_network_prepare()

#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_sntp.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/task.h"

#include <string.h>
#include <time.h>

static const char *TAG = "wifi_time";

#define RESYNC_INTERVAL_MS  (3 * 60 * 1000)  // 每 3 分钟对一次（用户要求 [historical session]：
                                             // 开机失败等 12h 的代价太大。代价是每次
                                             // 对时 WiFi 醒 ~5~10s，BLE 扫描短暂受影响）
#define CONNECT_TIMEOUT_MS  15000   // 单次连接等待 GOT_IP 的最长时间
#define CONNECT_ATTEMPTS    3       // 每轮对时最多连几次（手机热点可能晚于开机才打开）
#define RETRY_DELAY_MS      3000    // 两次连接尝试之间的间隔
#define SYNC_TIMEOUT_MS     10000   // SNTP 等回包的最长时间
#define TIME_VALID_AFTER    1760000000  // [historical session]；小于它说明还没对上

#define EG_GOT_IP  (1u << 0)

static EventGroupHandle_t s_eg;
static volatile bool s_synced;
static esp_event_handler_instance_t s_h_wifi;
static esp_event_handler_instance_t s_h_ip;
static esp_netif_t *s_sta_netif;

// diag_scan 只在首轮或失败后做：它是阻塞式全信道扫描（~1.3s），
// 会抢走 BLE 的射频时间。3 分钟一次的常规对时每次都扫的话，
// 车的 dwell 会被反复打断（[historical session]，配合 SCAN_DWELL_GAP_MS=20s 双修）。
static bool s_need_diag = true;

static void on_wifi_event(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    (void)arg; (void)base; (void)data;
    // 不在 STA_START 里自动连：先扫描诊断再显式 connect（见 do_sync_once）。
    // 断线也不重连：本轮交给超时兜底，避免密码错了在这里死循环。
    // 但要记录断开原因：201=没找到 AP（频段/名字问题），202/15/2=认证失败
    // （密码错或加密方式不兼容）。没有这个日志两种病一个症状（都是 15s 超时）。
    if (id == WIFI_EVENT_STA_DISCONNECTED) {
        const wifi_event_sta_disconnected_t *d = (const wifi_event_sta_disconnected_t *)data;
        ESP_LOGW(TAG, "WiFi disconnected: reason=%d", (int)d->reason);
    }
}

// 诊断：连之前先扫一圈。C3 只有 2.4G——目标 AP 不在可见列表里的话，
// 连一百年也连不上（5G 路由器 / 名字写错 / 隐藏 SSID），先把这个分清。
static void diag_scan(void)
{
    const wifi_scan_config_t sc = { .show_hidden = true };
    if (esp_wifi_scan_start(&sc, true) != ESP_OK) {   // 阻塞到扫完
        ESP_LOGW(TAG, "扫描启动失败");
        return;
    }
    // 静态分配：24 条约 2.5KB，放栈上会把 wifi_time 任务（4KB 栈）撑爆
    // （[historical session] 实测：rec[24] 局部变量 → Stack protection fault 反复重启）
    static wifi_ap_record_t rec[24];
    uint16_t n = 24;   // 校园网 AP 密集，12 条可能把热点挤出可见列表
    if (esp_wifi_scan_get_ap_records(&n, rec) != ESP_OK) return;
    bool found = false;
    ESP_LOGI(TAG, "Visible 2.4 GHz AP records: %d", (int)n);
    for (int i = 0; i < n; i++) {
        if (strcmp((const char *)rec[i].ssid, WIFI_SSID) == 0) found = true;
    }
    if (!found) {
        ESP_LOGW(TAG, "Configured AP absent from visible 2.4 GHz records");
    }
}

static void on_ip_event(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    (void)arg; (void)base; (void)data;
    if (id == IP_EVENT_STA_GOT_IP) {
        ESP_LOGI(TAG, "WiFi address acquired");
        xEventGroupSetBits(s_eg, EG_GOT_IP);
    }
}

static void do_sync_once(void)
{
    bool ok = false;
    xEventGroupClearBits(s_eg, EG_GOT_IP);

    if (demo_radio_network_prepare() != ESP_OK) goto out;
    // 必须创建默认 STA netif：DHCP 是在它上面跑的。否则链路进了 run 状态
    // 也永远拿不到 IP（[historical session] 实测：assoc->run 成功但 GOT_IP 不到，
    // 被误判成"密码错"）。只建一次，随应用生命周期保留。
    if (!s_sta_netif) s_sta_netif = esp_netif_create_default_wifi_sta();
    if (!s_sta_netif) goto out;
    {
        const wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
        if (esp_wifi_init(&cfg) != ESP_OK) goto out;
    }
    esp_event_handler_instance_register(WIFI_EVENT, ESP_EVENT_ANY_ID,
                                        on_wifi_event, NULL, &s_h_wifi);
    esp_event_handler_instance_register(IP_EVENT, IP_EVENT_STA_GOT_IP,
                                        on_ip_event, NULL, &s_h_ip);
    if (esp_wifi_set_mode(WIFI_MODE_STA) != ESP_OK) goto out;
    {
        wifi_config_t c;
        memset(&c, 0, sizeof c);
        strncpy((char *)c.sta.ssid, WIFI_SSID, sizeof(c.sta.ssid) - 1);
        strncpy((char *)c.sta.password, WIFI_PASS, sizeof(c.sta.password) - 1);
        if (esp_wifi_set_config(WIFI_IF_STA, &c) != ESP_OK) goto out;
    }
    if (esp_wifi_start() != ESP_OK) goto out;
    if (s_need_diag) diag_scan();

    // 最多连 CONNECT_ATTEMPTS 次：手机热点常常晚于设备开机才打开，
    // 一次 15s 超时就等 12h 的代价太大。每次之间断开并稍等。
    bool connected = false;
    int attempt;
    for (attempt = 1; attempt <= CONNECT_ATTEMPTS; attempt++) {
        xEventGroupClearBits(s_eg, EG_GOT_IP);
        esp_wifi_connect();
        if ((xEventGroupWaitBits(s_eg, EG_GOT_IP, pdFALSE, pdTRUE,
                                 pdMS_TO_TICKS(CONNECT_TIMEOUT_MS)) & EG_GOT_IP) != 0) {
            connected = true;
            break;
        }
        ESP_LOGW(TAG, "WiFi connection timeout (attempt %d/%d)",
                 attempt, CONNECT_ATTEMPTS);
        esp_wifi_disconnect();
        if (attempt < CONNECT_ATTEMPTS) vTaskDelay(pdMS_TO_TICKS(RETRY_DELAY_MS));
    }
    if (!connected) {
        ESP_LOGW(TAG, "连接 WiFi 失败（%d 次均超时），%d 分钟后重试",
                 CONNECT_ATTEMPTS, RESYNC_INTERVAL_MS / 60000);
        s_need_diag = true;   // 下一轮先扫一圈，看是 AP 没了还是别的
        goto out;
    }
    ESP_LOGI(TAG, "已连接（第 %d 次尝试），开始 SNTP 对时", attempt);
    s_need_diag = false;

    setenv("TZ", "CST-8", 1);       // POSIX：UTC+8 北京，无夏令时
    tzset();
    esp_sntp_setoperatingmode(SNTP_OPMODE_POLL);
    // 校园网实测：域名解析可能被 portal 拦，直接用 IP 绕过 DNS（[historical session]）。
    // 注意 sdkconfig 里 LWIP_SNTP_MAX_SERVERS=1，只有一个服务器槽位，
    // 设多个是空操作——要换服务器就换这一行。
    ip_addr_t ntp_ip;
    ipaddr_aton("203.107.6.88", &ntp_ip);          // ntp.aliyun.com
    esp_sntp_setserver(0, &ntp_ip);
    esp_sntp_init();

    for (int i = 0; i < SYNC_TIMEOUT_MS / 500; i++) {
        if (time(NULL) > TIME_VALID_AFTER) { ok = true; break; }
        vTaskDelay(pdMS_TO_TICKS(500));
    }
    esp_sntp_stop();

out:
    // 不管成败都关 WiFi：失败下个周期重来，成功已经不需要它了
    if (s_h_wifi) esp_event_handler_instance_unregister(WIFI_EVENT, ESP_EVENT_ANY_ID, s_h_wifi);
    if (s_h_ip)   esp_event_handler_instance_unregister(IP_EVENT, IP_EVENT_STA_GOT_IP, s_h_ip);
    s_h_wifi = NULL; s_h_ip = NULL;
    esp_wifi_stop();
    esp_wifi_deinit();              // 顺手把驱动那几十 KB 堆还给系统

    s_synced = ok;
    if (ok) {
        int hh, mm;
        wifi_time_now(&hh, &mm);
        ESP_LOGI(TAG, "对时成功：%02d:%02d（北京时间）", hh, mm);
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
    if (WIFI_SSID[0] == '\0') {
        ESP_LOGI(TAG, "WiFi time disabled: empty local SSID");
        return;
    }
    started = true;
    s_eg = xEventGroupCreate();
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

#else

#include "esp_log.h"

void wifi_time_start(void)
{
    ESP_LOGI("wifi_time", "WiFi time disabled: local credentials not configured");
}

bool wifi_time_now(int *hh, int *mm)
{
    (void)hh;
    (void)mm;
    return false;
}

#endif
