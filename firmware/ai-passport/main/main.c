// app_main.c —— 直绘版主程序：初始化 BSP → 直进雷达页（无套件菜单）。
//
// 替换说明：本文件对应套件 main.c 的位置。菜单（DEMOS[]）、demo_navigation、
// ui_pixel 全部废弃；输入分发（队列 + 任务 + key_guard 唤醒守卫）原样保留。
//
// 按键语义（全局统一）：
//   上/下 短按   移动焦点（含"无"空位）
//   确定  短按   切换开关 / 确认动作
//   确定  双击   切换串口标定日志（sniffer）
//   确定  长按   无功能——开关机是机身左侧的独立硬件电源键（硬件指南 §3），
//                与 BSP 三枚 ADC 功能键相互独立，固件不占键重复实现。
#include "bsp_i2c.h"
#include "bsp_display.h"
#include "bsp_button.h"
#include "bsp_battery.h"
#include "bsp_pins.h"          // BSP_LCD_* / BSP_BTN_MV_RELEASED_MIN
#include "key_guard.h"
#include "ui_mini.h"
#include "page_radar.h"
#include "frame_batch.h"
#include "frame_upload.h"
#include "wifi_time.h"

#include "esp_log.h"
#include "esp_sleep.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"

static const char *TAG = "main";

#define INPUT_QUEUE_DEPTH 8

typedef struct {
    bsp_btn_t btn;
    bsp_btn_ev_t event;
} input_event_t;

static QueueHandle_t s_input_queue;
static volatile bool s_input_ready;

// 开机清屏用：整屏推一帧底色（见 app_main 里的说明）。
static void paint_boot_black(void *user)
{
    (void)user;
    ui_clear(UI_COL_BG);
}

// ---------------------------------------------------------------------------
// 输入分发（与套件 main.c 相同：按键回调只入队，页面处理在专门任务里做）
// ---------------------------------------------------------------------------

static void input_task(void *arg)
{
    (void)arg;
    input_event_t input;
    for (;;) {
        if (xQueueReceive(s_input_queue, &input, portMAX_DELAY) == pdTRUE) {
            radar_page_key(input.btn, input.event);
        }
    }
}

// 深睡按键唤醒后的"按键动作守卫"（原理见 key_guard.h 头注释）。
#define KEY_GUARD_MAX_US (10LL * 1000 * 1000)
static key_guard_t s_key_guard;

// 按键回调跑在共享 esp_timer 任务里：只入队，立即返回。
static void on_key(bsp_btn_t btn, bsp_btn_ev_t ev, void *user)
{
    (void)user;
    const bool was_armed = s_key_guard.armed;
    if (key_guard_consume(&s_key_guard, ev == BSP_BTN_RELEASE,
                          esp_timer_get_time())) {
        if (was_armed && !s_key_guard.armed) {
            ESP_LOGI(TAG, "唤醒键已松手，按键恢复响应");
        }
        return;
    }
    if (!s_input_ready || !s_input_queue) return;
    const input_event_t input = { .btn = btn, .event = ev };
    (void)xQueueSend(s_input_queue, &input, 0);
}

// ---------------------------------------------------------------------------

void app_main(void)
{
    ESP_LOGI(TAG, "AI Passport 雷达（直绘 UI）启动");
    const uint32_t wake_causes = esp_sleep_get_wakeup_causes();
    if (wake_causes & (1u << ESP_SLEEP_WAKEUP_GPIO)) {
        // 唤醒键在整个启动期间还按着：先挡住它的动作，直到松手（见 on_key）
        key_guard_arm(&s_key_guard, esp_timer_get_time(), KEY_GUARD_MAX_US);
        ESP_LOGI(TAG, "按键唤醒：先屏蔽按键动作，直到那颗键松手");
    }

    bsp_i2c_init();

    // 屏幕是 UI 载体，失败就没有界面可言：打清日志后退出
    if (bsp_display_init() != ESP_OK || ui_init(bsp_display_panel()) != ESP_OK) {
        ESP_LOGE(TAG, "显示初始化失败。检查 SPI 接线"
                      "(MOSI=%d SCLK=%d CS=%d DC=%d BL=%d)",
                 BSP_LCD_MOSI, BSP_LCD_SCLK, BSP_LCD_CS, BSP_LCD_DC, BSP_LCD_BL);
        return;
    }
    // 先清屏再开背光。ST7789 上电后 GRAM 内容是未定义的，而且本板复位脚
    // 硬接 3.3V（BSP_LCD_RST=-1）、只走软复位——上次关机的画面残影还在
    // 显存里。不先推一帧黑，背光一亮到雷达页首帧（约 0.6s）之间就是花屏。
    ui_render((ui_rect_t){ 0, 0, UI_W, UI_H }, paint_boot_black, NULL);
    bsp_display_backlight(100);

    // 电量计失败不阻塞：界面右上角显示 "--"
    const esp_err_t bat_err = bsp_battery_init();
    if (bat_err != ESP_OK) {
        ESP_LOGW(TAG, "电量计初始化失败: %s（界面电量显示 --）",
                 esp_err_to_name(bat_err));
    }

    // 输入：队列 + 任务 + 按键
    s_input_queue = xQueueCreate(INPUT_QUEUE_DEPTH, sizeof(input_event_t));
    if (!s_input_queue ||
        xTaskCreate(input_task, "radar_input", 4096, NULL, 5, NULL) != pdPASS) {
        ESP_LOGE(TAG, "输入任务创建失败");
        return;
    }
    const esp_err_t btn_err = bsp_button_init(on_key, NULL);
    if (btn_err != ESP_OK) {
        ESP_LOGE(TAG, "按键初始化失败: %s", esp_err_to_name(btn_err));
        return;
    }
    if (s_key_guard.armed) {
        // 若唤醒键在按键驱动启动前就已松手，组件不会产生 release 事件，
        // 守卫会一直拦到兜底。按真实电压同步一次：已松手立即撤防。
        const bool released = bsp_button_read_mv() >= BSP_BTN_MV_RELEASED_MIN;
        key_guard_sync_released(&s_key_guard, released);
        if (!s_key_guard.armed) {
            ESP_LOGI(TAG, "唤醒键在按键驱动启动前已松手，提前撤防");
        }
    }

    radar_page_start();
    frame_batch_start();    // 原始帧采集→封批→ble_raw 存储（扫描 tap 随之挂上）
    frame_upload_start();   // 每分钟一轮：挂起扫描→连 WiFi→POST→验 ACK→回收
    wifi_time_start();      // 后台连 WiFi 对时，对上后状态栏自动出现时间
    s_input_ready = true;
    ESP_LOGI(TAG, "就绪（电量计=%d）", bat_err == ESP_OK);
}
