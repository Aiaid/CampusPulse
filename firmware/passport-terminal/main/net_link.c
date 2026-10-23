// net_link.c —— 实现见 net_link.h。
// 连接 / 诊断扫描 / SNTP 的写法借鉴自赛前 ai-passport 的 wifi_time.c
// （复用登记见 docs/notes/reuse.md），生命周期改为按需连接 + 空闲断开。
#include "net_link.h"

// 真实凭据在 term_cred_local.h（gitignore，不进仓库）；
// 缺失时退回模板占位值，保证无凭据也能编译（连不上网属预期）。
#if __has_include("term_cred_local.h")
#include "term_cred_local.h"    // WIFI_SSID / WIFI_PASS
#else
#include "term_cred.example.h"
#endif

#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_sntp.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "nvs_flash.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

#include <string.h>
#include <time.h>

static const char *TAG = "net_link";

#define CONNECT_TIMEOUT_MS   15000   // 单次连接等待 GOT_IP 的最长时间
#define CONNECT_ATTEMPTS     3       // 每轮最多连几次（热点可能晚于设备开机才打开）
#define RETRY_DELAY_MS       3000
#define SYNC_TIMEOUT_MS      10000   // SNTP 等回包的最长时间
#define IDLE_DISCONNECT_MS   30000   // 最后一次 release 后多久断开 Wi-Fi
#define TIME_VALID_AFTER     1760000000  // 2025-11-13；小于它说明还没对上

#define EG_GOT_IP  (1u << 0)
#define EG_WANT    (1u << 1)         // 有人需要网络

static EventGroupHandle_t s_eg;
static SemaphoreHandle_t s_lock;     // 保护状态字段，任务/调用方双向读写
static volatile net_state_t s_state;
static volatile bool s_synced;
static int64_t s_last_use_us;        // 最近一次 ensure 成功 / release 的时间
static esp_event_handler_instance_t s_h_wifi;
static esp_event_handler_instance_t s_h_ip;
static esp_netif_t *s_sta_netif;
static bool s_wifi_ready;            // wifi_init + start 已完成
static bool s_need_diag = true;      // 首轮或失败后先做一次诊断扫描

static void on_wifi_event(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    (void)arg; (void)base;
    if (id == WIFI_EVENT_STA_DISCONNECTED) {
        // 记录断开原因：201=没找到 AP，202/15/2=认证失败。
        // 没有这个日志两种病一个症状（都是连接超时）。
        const wifi_event_sta_disconnected_t *d = (const wifi_event_sta_disconnected_t *)data;
        ESP_LOGW(TAG, "断开/连接失败：reason=%d ssid=%.*s",
                 (int)d->reason, (int)d->ssid_len, (const char *)d->ssid);
    }
}

static void on_ip_event(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    (void)arg; (void)base; (void)data;
    if (id == IP_EVENT_STA_GOT_IP) {
        const ip_event_got_ip_t *e = (const ip_event_got_ip_t *)data;
        ESP_LOGI(TAG, "拿到 IP：" IPSTR, IP2STR(&e->ip_info.ip));
        xEventGroupSetBits(s_eg, EG_GOT_IP);
    }
}

// 诊断：连不上时先扫一圈，区分「AP 不存在 / 5G 频段 / 密码错」。
// 静态分配：24 条约 2.5KB，放栈上会撑爆 4KB 任务栈（赛前实测教训）。
static void diag_scan(void)
{
    const wifi_scan_config_t sc = { .show_hidden = true };
    if (esp_wifi_scan_start(&sc, true) != ESP_OK) {
        ESP_LOGW(TAG, "扫描启动失败");
        return;
    }
    static wifi_ap_record_t rec[24];
    uint16_t n = 24;
    if (esp_wifi_scan_get_ap_records(&n, rec) != ESP_OK) return;
    bool found = false;
    ESP_LOGI(TAG, "2.4G 可见 AP（共 %d 个）：", (int)n);
    for (int i = 0; i < n; i++) {
        if (strcmp((const char *)rec[i].ssid, WIFI_SSID) == 0) found = true;
    }
    if (!found) {
        ESP_LOGW(TAG, "目标 \"%s\" 不在 2.4G 可见列表里", WIFI_SSID);
    }
}

static esp_err_t wifi_stack_prepare(void)
{
    if (s_wifi_ready) return ESP_OK;

    esp_err_t err = nvs_flash_init();
    if (err != ESP_OK) {
        // 不为启动无线功能而擦除用户数据。
        ESP_LOGE(TAG, "NVS 初始化失败: %s；未自动擦除分区", esp_err_to_name(err));
        return err;
    }
    if (!s_sta_netif) {
        err = esp_netif_init();
        if (err != ESP_OK) return err;
        err = esp_event_loop_create_default();
        if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) return err;
        // 必须创建默认 STA netif：DHCP 在它上面跑，否则永远拿不到 IP。
        s_sta_netif = esp_netif_create_default_wifi_sta();
        if (!s_sta_netif) return ESP_ERR_NO_MEM;
    }
    const wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    err = esp_wifi_init(&cfg);
    if (err != ESP_OK) return err;
    err = esp_event_handler_instance_register(WIFI_EVENT, ESP_EVENT_ANY_ID,
                                              on_wifi_event, NULL, &s_h_wifi);
    if (err != ESP_OK) return err;
    err = esp_event_handler_instance_register(IP_EVENT, IP_EVENT_STA_GOT_IP,
                                              on_ip_event, NULL, &s_h_ip);
    if (err != ESP_OK) return err;
    err = esp_wifi_set_mode(WIFI_MODE_STA);
    if (err != ESP_OK) return err;
    wifi_config_t c;
    memset(&c, 0, sizeof c);
    strncpy((char *)c.sta.ssid, WIFI_SSID, sizeof(c.sta.ssid) - 1);
    strncpy((char *)c.sta.password, WIFI_PASS, sizeof(c.sta.password) - 1);
    err = esp_wifi_set_config(WIFI_IF_STA, &c);
    if (err != ESP_OK) return err;
    err = esp_wifi_start();
    if (err != ESP_OK) return err;
    s_wifi_ready = true;
    return ESP_OK;
}

static void wifi_stack_teardown(void)
{
    if (!s_wifi_ready) return;
    esp_wifi_disconnect();
    if (s_h_wifi) esp_event_handler_instance_unregister(WIFI_EVENT, ESP_EVENT_ANY_ID, s_h_wifi);
    if (s_h_ip)   esp_event_handler_instance_unregister(IP_EVENT, IP_EVENT_STA_GOT_IP, s_h_ip);
    s_h_wifi = NULL;
    s_h_ip = NULL;
    esp_wifi_stop();
    esp_wifi_deinit();   // 把驱动那几十 KB 堆还给系统
    s_wifi_ready = false;
}

// 连接并对时。调用方需持有 s_lock。返回 true = 已拿到 IP。
static bool connect_and_sync(int timeout_ms)
{
    if (wifi_stack_prepare() != ESP_OK) return false;
    if (s_need_diag) diag_scan();

    bool connected = false;
    const int per_attempt = timeout_ms / CONNECT_ATTEMPTS;
    const int wait_ms = per_attempt < CONNECT_TIMEOUT_MS ? per_attempt : CONNECT_TIMEOUT_MS;
    for (int attempt = 1; attempt <= CONNECT_ATTEMPTS; attempt++) {
        xEventGroupClearBits(s_eg, EG_GOT_IP);
        esp_wifi_connect();
        if ((xEventGroupWaitBits(s_eg, EG_GOT_IP, pdFALSE, pdTRUE,
                                 pdMS_TO_TICKS(wait_ms)) & EG_GOT_IP) != 0) {
            connected = true;
            break;
        }
        ESP_LOGW(TAG, "连接超时（第 %d/%d 次）", attempt, CONNECT_ATTEMPTS);
        esp_wifi_disconnect();
        if (attempt < CONNECT_ATTEMPTS) vTaskDelay(pdMS_TO_TICKS(RETRY_DELAY_MS));
    }
    if (!connected) {
        s_need_diag = true;   // 下一轮先扫一圈
        return false;
    }
    s_need_diag = false;

    // 时间不可信才对时：SNTP 设一次后系统时钟自走。
    if (time(NULL) < TIME_VALID_AFTER) {
        setenv("TZ", "CST-8", 1);
        tzset();
        esp_sntp_setoperatingmode(SNTP_OPMODE_POLL);
        // 用 IP 绕过 DNS：校园网 portal 可能拦域名解析（赛前实测）。
        // sdkconfig 默认 LWIP_SNTP_MAX_SERVERS=1，只有一个槽位。
        ip_addr_t ntp_ip;
        ipaddr_aton("203.107.6.88", &ntp_ip);   // ntp.aliyun.com
        esp_sntp_setserver(0, &ntp_ip);
        esp_sntp_init();
        bool ok = false;
        for (int i = 0; i < SYNC_TIMEOUT_MS / 500; i++) {
            if (time(NULL) > TIME_VALID_AFTER) { ok = true; break; }
            vTaskDelay(pdMS_TO_TICKS(500));
        }
        esp_sntp_stop();
        if (ok) {
            s_synced = true;
            ESP_LOGI(TAG, "对时成功");
        } else {
            ESP_LOGW(TAG, "SNTP 对时超时（网络可用但时间不可信）");
        }
    }
    return true;
}

static void net_task(void *arg)
{
    (void)arg;
    for (;;) {
        // 空闲看护：已连接但超过 IDLE_DISCONNECT_MS 没人用就断开省电。
        if (s_state == NET_ONLINE &&
            esp_timer_get_time() - s_last_use_us > (int64_t)IDLE_DISCONNECT_MS * 1000) {
            xSemaphoreTake(s_lock, portMAX_DELAY);
            if (s_state == NET_ONLINE &&
                esp_timer_get_time() - s_last_use_us > (int64_t)IDLE_DISCONNECT_MS * 1000) {
                ESP_LOGI(TAG, "空闲超时，断开 Wi-Fi");
                wifi_stack_teardown();
                s_state = NET_OFF;
            }
            xSemaphoreGive(s_lock);
        }
        vTaskDelay(pdMS_TO_TICKS(1000));
    }
}

void net_link_start(void)
{
    static bool started;
    if (started) return;
    started = true;
    s_eg = xEventGroupCreate();
    s_lock = xSemaphoreCreateMutex();
    xTaskCreate(net_task, "net_link", 4096, NULL, 3, NULL);
}

bool net_link_ensure(int timeout_ms)
{
    if (!s_lock) return false;
    bool ok = false;
    xSemaphoreTake(s_lock, portMAX_DELAY);
    if (s_state == NET_ONLINE) {
        ok = true;
    } else {
        s_state = NET_CONNECTING;
        ok = connect_and_sync(timeout_ms);
        s_state = ok ? NET_ONLINE : NET_OFF;
    }
    if (ok) s_last_use_us = esp_timer_get_time();
    xSemaphoreGive(s_lock);
    return ok;
}

void net_link_release(void)
{
    // 只刷新「最后使用时间」，断开由看护任务做，保证连续多次使用之间
    // 不会反复断开重连。
    s_last_use_us = esp_timer_get_time();
}

net_state_t net_link_state(void)
{
    return s_state;
}

bool net_link_time_synced(void)
{
    return s_synced && time(NULL) > TIME_VALID_AFTER;
}

bool net_link_utc_now(char *buf, int len)
{
    if (!net_link_time_synced()) return false;
    const time_t now = time(NULL);
    struct tm tm;
    gmtime_r(&now, &tm);
    // 与 web-api-v0 示例一致：毫秒固定 .000Z。
    return strftime(buf, len, "%Y-%m-%dT%H:%M:%S.000Z", &tm) > 0;
}

bool net_link_time_hhmm(int *hh, int *mm)
{
    if (!net_link_time_synced()) return false;
    const time_t now = time(NULL);
    struct tm tm;
    localtime_r(&now, &tm);
    *hh = tm.tm_hour;
    *mm = tm.tm_min;
    return true;
}
