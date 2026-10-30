// CampusPulse Waveshare V2: LVGL renderer and SSD1681 differential refresh.
//
// Panel facts: GDEH0154D67, 200x200, controller SSD1681, SPI, BUSY high while
// busy, panel rail on GPIO6 (low = on). The command values below are the
// controller's documented register settings for this panel; no third-party
// driver code is copied. LVGL supplies the Montserrat fonts.

#include "raw_display.h"
#include "raw_panel.h"
#include "raw_refresh.h"
#include <inttypes.h>
#include "lvgl.h"

#include "driver/gpio.h"
#include "driver/spi_master.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include <stdio.h>
#include <string.h>
#ifdef RAW_DISPLAY_EXTERNAL_RENDER
#include "esp_heap_caps.h"
#endif

#define PIN_PWR 6
#define PIN_BUSY 8
#define PIN_RST 9
#define PIN_DC 10
#define PIN_CS 11
#define PIN_SCK 12
#define PIN_MOSI 13

#define PANEL_W 200
#define PANEL_H 200
#define ROW_BYTES (PANEL_W / 8)
#define FB_BYTES (ROW_BYTES * PANEL_H)

static const char *TAG = "epaper";
static spi_device_handle_t s_spi;
static bool s_ready;
static uint8_t s_fb[FB_BYTES];
#ifdef RAW_DISPLAY_EXTERNAL_RENDER
/* Trial option: CPU-only render/history buffers use verified PSRAM. The actual
 * SPI framebuffer remains internal; no external buffer is passed to DMA. */
static uint8_t *s_draw;
static uint8_t *s_previous;
#else
static uint8_t s_draw[PANEL_W * PANEL_H];
static uint8_t s_previous[FB_BYTES];
#endif
static lv_display_t *s_display;
static raw_refresh_state_t s_refresh;
static char s_previous_state[24];
static esp_err_t s_io_error;

/* The LVGL flush only collects pixels. The panel is refreshed once after
 * lv_refr_now has finished, never from the flush callback. */
static void collect_frame(lv_display_t *display, const lv_area_t *area, uint8_t *pixels) {
    const int width = area->x2 - area->x1 + 1;
    for (int y = area->y1; y <= area->y2; ++y) {
        for (int x = area->x1; x <= area->x2; ++x) {
            const unsigned offset = (unsigned)y * ROW_BYTES + (unsigned)x / 8;
            const uint8_t mask = (uint8_t)(0x80u >> (x % 8));
            if (pixels[(y - area->y1) * width + (x - area->x1)] >= 128) s_fb[offset] |= mask;
            else s_fb[offset] &= (uint8_t)~mask;
        }
    }
    lv_display_flush_ready(display);
}

static uint32_t tick_ms(void) { return (uint32_t)(esp_timer_get_time() / 1000); }

static esp_err_t ui_init(void) {
#ifdef RAW_DISPLAY_EXTERNAL_RENDER
    s_draw=heap_caps_calloc(1,PANEL_W*PANEL_H,MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT);
    s_previous=heap_caps_calloc(1,FB_BYTES,MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT);
    if(!s_draw||!s_previous)return ESP_ERR_NO_MEM;
#endif
    lv_init();
    lv_tick_set_cb(tick_ms);
    s_display = lv_display_create(PANEL_W, PANEL_H);
    if (!s_display) return ESP_ERR_NO_MEM;
    lv_display_set_color_format(s_display, LV_COLOR_FORMAT_L8);
    lv_display_set_buffers(s_display, s_draw, NULL, PANEL_W * PANEL_H, LV_DISPLAY_RENDER_MODE_FULL);
    lv_display_set_flush_cb(s_display, collect_frame);
    raw_ui_init(s_display);
    return ESP_OK;
}

static esp_err_t xfer(const uint8_t *data, size_t length) {
    spi_transaction_t t = {.length = length * 8, .tx_buffer = data};
    return spi_device_polling_transmit(s_spi, &t);
}

static esp_err_t write_command(uint8_t command) {
    esp_err_t err = gpio_set_level(PIN_DC, 0);
    if (err != ESP_OK) return err;
    return xfer(&command, 1);
}

static esp_err_t write_data(const uint8_t *data, size_t length) {
    esp_err_t err = gpio_set_level(PIN_DC, 1);
    if (err != ESP_OK) return err;
    return xfer(data, length);
}

static esp_err_t wait_not_busy(uint32_t timeout_ms) {
    const int64_t start = esp_timer_get_time();
    while (gpio_get_level(PIN_BUSY)) {
        if ((esp_timer_get_time() - start) / 1000 > timeout_ms)
            return ESP_ERR_TIMEOUT;
        vTaskDelay(pdMS_TO_TICKS(5));
    }
    return ESP_OK;
}

static void gpio_checked(int pin, int level) {
    esp_err_t result = gpio_set_level(pin, level);
    if (s_io_error == ESP_OK && result != ESP_OK) s_io_error = result;
}
static int io_command(void *context, uint8_t command) {
    (void)context;
    return s_io_error != ESP_OK ? s_io_error : write_command(command);
}
static int io_data(void *context, const uint8_t *data, size_t length) {
    (void)context;
    return s_io_error != ESP_OK ? s_io_error : write_data(data, length);
}
static int io_wait(void *context, uint32_t timeout) {
    (void)context;
    return s_io_error != ESP_OK ? s_io_error : wait_not_busy(timeout);
}
static void io_reset(void *context) {
    (void)context;
    gpio_checked(PIN_RST, 1); vTaskDelay(pdMS_TO_TICKS(10));
    gpio_checked(PIN_RST, 0); vTaskDelay(pdMS_TO_TICKS(10));
    gpio_checked(PIN_RST, 1); vTaskDelay(pdMS_TO_TICKS(10));
}
static void io_power(void *context, bool on) {
    (void)context; gpio_checked(PIN_PWR, on ? 0 : 1);
}
static void io_delay(void *context, uint32_t milliseconds) {
    (void)context; vTaskDelay(pdMS_TO_TICKS(milliseconds));
}
static const raw_panel_io_t s_panel = {.command = io_command, .data = io_data,
    .wait_idle = io_wait, .reset = io_reset, .power = io_power, .delay_ms = io_delay};

esp_err_t raw_display_init(void) {
    if (s_ready)
        return ESP_OK;

    gpio_config_t out = {
        .pin_bit_mask = (1ULL << PIN_PWR) | (1ULL << PIN_RST) | (1ULL << PIN_DC),
        .mode = GPIO_MODE_OUTPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    esp_err_t err = gpio_config(&out);
    if (err != ESP_OK)
        return err;
    gpio_config_t in = {
        .pin_bit_mask = 1ULL << PIN_BUSY,
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    if ((err = gpio_config(&in)) != ESP_OK)
        return err;
    gpio_set_level(PIN_PWR, 1); /* keep the panel unpowered until a refresh */
    gpio_set_level(PIN_DC, 0);
    gpio_set_level(PIN_RST, 1);

    spi_bus_config_t bus = {
        .mosi_io_num = PIN_MOSI,
        .miso_io_num = -1,
        .sclk_io_num = PIN_SCK,
        .quadwp_io_num = -1,
        .quadhd_io_num = -1,
        .max_transfer_sz = FB_BYTES,
    };
    if ((err = spi_bus_initialize(SPI2_HOST, &bus, SPI_DMA_CH_AUTO)) != ESP_OK)
        return err;
    spi_device_interface_config_t dev = {
        .clock_speed_hz = 4 * 1000 * 1000,
        .mode = 0,
        .spics_io_num = PIN_CS,
        .queue_size = 1,
    };
    if ((err = spi_bus_add_device(SPI2_HOST, &dev, &s_spi)) != ESP_OK) {
        spi_bus_free(SPI2_HOST);
        return err;
    }
    if ((err = ui_init()) != ESP_OK) {
        spi_bus_remove_device(s_spi);
        spi_bus_free(SPI2_HOST);
        return err;
    }
    s_ready = true;
    ESP_LOGI(TAG, "SSD1681 panel ready");
    return ESP_OK;
}


esp_err_t raw_display_present(const raw_display_snapshot_t *snapshot) {
    if (!snapshot) return ESP_ERR_INVALID_ARG;
    if (!s_ready) return ESP_ERR_INVALID_STATE;
    raw_ui_update(snapshot);
    lv_obj_invalidate(lv_display_get_screen_active(s_display));
    lv_refr_now(s_display);
    int64_t start = esp_timer_get_time();
    bool critical_change = memcmp(snapshot->state, s_previous_state, sizeof s_previous_state) &&
        (strstr(snapshot->state, "ERROR") || strstr(snapshot->state, "FULL") ||
         !strcmp(snapshot->state, "POWER OFF"));
    raw_refresh_plan_t plan = raw_refresh_plan(&s_refresh, s_previous, s_fb,
        snapshot->page, (uint64_t)start / 1000, critical_change);
    if (plan.mode == RAW_REFRESH_NONE) return ESP_OK;
    s_io_error = ESP_OK;
    esp_err_t err = plan.mode == RAW_REFRESH_FULL ? raw_panel_full(&s_panel, s_fb)
        : raw_panel_partial(&s_panel, s_fb, &plan);
    if (err == ESP_OK && s_io_error != ESP_OK) err = s_io_error;
    if (err == ESP_OK) {
        memcpy(s_previous, s_fb, FB_BYTES);
        memcpy(s_previous_state, snapshot->state, sizeof s_previous_state);
        raw_refresh_commit(&s_refresh, &plan, snapshot->page, (uint64_t)esp_timer_get_time() / 1000);
        ESP_LOGI(TAG, "refresh=%s x=%u..%u y=%u..%u elapsed_ms=%"PRId64,
            plan.mode == RAW_REFRESH_FULL ? "full" : "partial", plan.x0 * 8,
            plan.x1 * 8 + 7, plan.y0, plan.y1, (esp_timer_get_time() - start) / 1000);
    } else {
        raw_refresh_invalidate(&s_refresh);
        gpio_set_level(PIN_PWR, 1);
        ESP_LOGE(TAG, "refresh failed: %s; next update rebuilds full baseline", esp_err_to_name(err));
    }
    return err;
}

esp_err_t raw_display_sleep(void) {
    if (!s_ready) return ESP_ERR_INVALID_STATE;
    s_io_error = ESP_OK;
    esp_err_t result = raw_panel_off(&s_panel);
    raw_refresh_invalidate(&s_refresh);
    return result != ESP_OK ? result : s_io_error;
}
