// main/wifi_link.c —— 实现见 wifi_link.h。
#include "wifi_link.h"

#include "demo_radio.h"          // demo_radio_network_prepare()（netif+事件循环）
#include "scan_ble.h"            // scan_ble_park/unpark（会话期间整体腾让 BLE）
#include "wifi_cred_local.h"     // WIFI_SSID / WIFI_PASS（gitignore）

#include "esp_event.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_system.h"        // esp_get_free_heap_size()（内存诊断）
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include <string.h>

static const char *TAG = "wifi_link";

static SemaphoreHandle_t s_mtx;     // 会话互斥：持有者独占射频
static esp_netif_t *s_netif;        // 只建一次（DHCP 跑在它上面）
static volatile bool s_got_ip;
static bool s_acquired;
static bool s_handler_registered;

static void on_ip(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    (void)arg; (void)base; (void)data;
    if (id == IP_EVENT_STA_GOT_IP) s_got_ip = true;
}

// 断开原因日志（2026-10-23：没有这个，"密码错"和"AP 不在"都是同一个
// 症状——15s 超时。常见码：201=没找到 AP（5G/名字错/隐藏），
// 202/15/2=认证失败（密码错或加密方式不兼容），205=被 AP 拒绝）。
static void on_wifi(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    (void)arg; (void)base;
    if (id == WIFI_EVENT_STA_DISCONNECTED) {
        const wifi_event_sta_disconnected_t *d =
            (const wifi_event_sta_disconnected_t *)data;
        ESP_LOGW(TAG, "断开/连接失败：reason=%d ssid=%.*s",
                 (int)d->reason, d->ssid_len, (const char *)d->ssid);
    }
}

// 逐步报错：707ms 就"会话失败"说明根本不是超时，而是某一步直接返回错误，
// 必须让日志说出是哪一步、什么错。
#define STEP_GOTO(expr, label)                                              \
    do {                                                                    \
        const esp_err_t e_ = (expr);                                        \
        if (e_ != ESP_OK) {                                                 \
            ESP_LOGE(TAG, #expr " 失败: %s", esp_err_to_name(e_));          \
            goto label;                                                     \
        }                                                                   \
    } while (0)

// WiFi 收尾。顺序和间隔都有讲究（2026-10-24 实测）：
// disconnect 的 DISCONNECTED 事件在 wifi 任务队列里异步送达，不等它走完就
// stop+deinit，wifi 任务还攥着已释放的结构；紧接着 BLE 扫描恢复触发共存，
// 就在 ieee80211_output_do 里 Load access fault（当晚 7 次连环重启的元凶）。
static void wifi_teardown(void)
{
    esp_wifi_disconnect();
    vTaskDelay(pdMS_TO_TICKS(200));   // 等 DISCONNECTED 事件在 wifi 任务里处理完
    esp_wifi_stop();
    vTaskDelay(pdMS_TO_TICKS(80));    // 等 stop 收尾，再放 deinit
    esp_wifi_deinit();
}

esp_err_t wifi_link_acquire(uint32_t timeout_ms)
{
    if (!s_mtx && !(s_mtx = xSemaphoreCreateMutex())) return ESP_ERR_NO_MEM;
    xSemaphoreTake(s_mtx, portMAX_DELAY);   // 排队：等上一个会话传完

    // BLE 整体腾让（2026-10-24）：本机堆 ~150KB，BLE 栈开着 free 只剩 ~29KB，
    // WiFi init 一次要 ~50KB → 之前每次 esp_wifi_init 都 ESP_ERR_NO_MEM。
    // 会话期间把 BLE 拆掉（计数表保留），会话结束/失败都接回去。
    STEP_GOTO(scan_ble_park(), fail);

    // netif + 默认事件循环是 WiFi 会话的地基，幂等，谁先来谁建。
    STEP_GOTO(demo_radio_network_prepare(), fail);

    if (!s_handler_registered) {
        esp_event_handler_instance_t h;
        esp_event_handler_instance_register(IP_EVENT, IP_EVENT_STA_GOT_IP,
                                            on_ip, NULL, &h);
        esp_event_handler_instance_register(WIFI_EVENT, WIFI_EVENT_STA_DISCONNECTED,
                                            on_wifi, NULL, &h);
        s_handler_registered = true;    // 常驻：只置一个 volatile，不卸
    }
    if (!s_netif) s_netif = esp_netif_create_default_wifi_sta();
    // 内存诊断（2026-10-24）：本机堆总量只有 ~151KB，WiFi init（静态 RX 缓冲
    // + 任务栈 + 协处理器内存）是最大的单笔开销。之前 NO_MEM 时这里是哑巴，
    // 不知道差多少。每次会话打一行，失败时一眼看出余量。
    ESP_LOGI(TAG, "WiFi init 前 free=%luKB largest=%luKB",
             (unsigned long)(esp_get_free_heap_size() / 1024),
             (unsigned long)(heap_caps_get_largest_free_block(MALLOC_CAP_DEFAULT) / 1024));
    const wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    STEP_GOTO(esp_wifi_init(&cfg), fail);
    STEP_GOTO(esp_wifi_set_mode(WIFI_MODE_STA), fail_stop);
    {
        wifi_config_t c;
        memset(&c, 0, sizeof c);
        strncpy((char *)c.sta.ssid, WIFI_SSID, sizeof(c.sta.ssid) - 1);
        strncpy((char *)c.sta.password, WIFI_PASS, sizeof(c.sta.password) - 1);
        STEP_GOTO(esp_wifi_set_config(WIFI_IF_STA, &c), fail_stop);
    }
    STEP_GOTO(esp_wifi_start(), fail_stop);

    s_got_ip = false;
    STEP_GOTO(esp_wifi_connect(), fail_stop);
    for (uint32_t i = 0; i < timeout_ms / 100 && !s_got_ip; i++) {
        vTaskDelay(pdMS_TO_TICKS(100));
    }
    if (!s_got_ip) {
        ESP_LOGW(TAG, "连接超时（%lums）", (unsigned long)timeout_ms);
        goto fail_stop;
    }
    s_acquired = true;
    return ESP_OK;

fail_stop:
    wifi_teardown();
fail:
    scan_ble_unpark();      // 失败也要把 BLE 接回去（表还在内存里）
    xSemaphoreGive(s_mtx);
    return ESP_FAIL;
}

void wifi_link_release(void)
{
    if (!s_acquired) return;    // 防御：没占成别拆别人的东西
    s_acquired = false;
    wifi_teardown();
    scan_ble_unpark();          // 把射频和内存还给 BLE
    xSemaphoreGive(s_mtx);
}
