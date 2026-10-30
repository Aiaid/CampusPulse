// CampusPulse 1.54" ePaper card: SSD1681 full-refresh driver and text card.
//
// Panel facts: GDEH0154D67, 200x200, controller SSD1681, SPI, BUSY high while
// busy, panel rail on GPIO6 (low = on). The command values below are the
// controller's documented register settings for this panel; no third-party
// driver code is copied. The 5x7 glyph data is BSD-licensed and recorded in
// docs/notes/reuse.md.

#include "epaper_card.h"

#include "driver/gpio.h"
#include "driver/spi_master.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include <stdio.h>
#include <string.h>

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

#define CHAR_W 5
#define CHAR_H 7
#define CHAR_ADVANCE 6
#define LEFT_MARGIN 4
#define MAX_CHARS ((PANEL_W - LEFT_MARGIN) / CHAR_ADVANCE)

extern const unsigned char cp_font5x7[128 * 5];

static const char *TAG = "epaper";
static spi_device_handle_t s_spi;
static bool s_ready;
static uint8_t s_fb[FB_BYTES];

static esp_err_t xfer(const uint8_t *data, size_t length) {
    spi_transaction_t t = {.length = length * 8, .tx_buffer = data};
    return spi_device_polling_transmit(s_spi, &t);
}

static esp_err_t write_command(uint8_t command) {
    gpio_set_level(PIN_DC, 0);
    return xfer(&command, 1);
}

static esp_err_t write_data(const uint8_t *data, size_t length) {
    gpio_set_level(PIN_DC, 1);
    return xfer(data, length);
}

static esp_err_t write_data1(uint8_t value) { return write_data(&value, 1); }

static esp_err_t wait_not_busy(uint32_t timeout_ms) {
    const int64_t start = esp_timer_get_time();
    while (gpio_get_level(PIN_BUSY)) {
        if ((esp_timer_get_time() - start) / 1000 > timeout_ms)
            return ESP_ERR_TIMEOUT;
        vTaskDelay(pdMS_TO_TICKS(5));
    }
    return ESP_OK;
}

static void panel_reset(void) {
    gpio_set_level(PIN_RST, 1);
    vTaskDelay(pdMS_TO_TICKS(10));
    gpio_set_level(PIN_RST, 0);
    vTaskDelay(pdMS_TO_TICKS(10));
    gpio_set_level(PIN_RST, 1);
    vTaskDelay(pdMS_TO_TICKS(10));
}

static esp_err_t set_ram_area(void) {
    esp_err_t err = write_command(0x11);
    if (err == ESP_OK) err = write_data1(0x03); /* x and y increment */
    if (err == ESP_OK) err = write_command(0x44);

    if (err == ESP_OK) err = write_data1(0x00);
    if (err == ESP_OK) err = write_data1(ROW_BYTES - 1);
    if (err == ESP_OK) err = write_command(0x45);
    if (err == ESP_OK) err = write_data1(0x00);
    if (err == ESP_OK) err = write_data1(0x00);
    if (err == ESP_OK) err = write_data1((PANEL_H - 1) & 0xFF);
    if (err == ESP_OK) err = write_data1((PANEL_H - 1) >> 8);
    if (err == ESP_OK) err = write_command(0x4E);
    if (err == ESP_OK) err = write_data1(0x00);
    if (err == ESP_OK) err = write_command(0x4F);
    if (err == ESP_OK) err = write_data1(0x00);
    if (err == ESP_OK) err = write_data1(0x00);
    return err;
}

static esp_err_t panel_begin(void) {
    gpio_set_level(PIN_PWR, 0); /* panel rail on */
    vTaskDelay(pdMS_TO_TICKS(10));
    panel_reset();

    esp_err_t err = write_command(0x12); /* soft reset */
    if (err == ESP_OK) vTaskDelay(pdMS_TO_TICKS(10));
    if (err == ESP_OK) err = write_command(0x01); /* driver output control */
    if (err == ESP_OK) err = write_data1((PANEL_H - 1) & 0xFF);
    if (err == ESP_OK) err = write_data1((PANEL_H - 1) >> 8);
    if (err == ESP_OK) err = write_data1(0x00);
    if (err == ESP_OK) err = write_command(0x3C); /* border waveform */
    if (err == ESP_OK) err = write_data1(0x05);
    if (err == ESP_OK) err = write_command(0x18); /* internal temperature */
    if (err == ESP_OK) err = write_data1(0x80);
    if (err == ESP_OK) err = set_ram_area();
    if (err == ESP_OK) err = write_command(0x22); /* power on */
    if (err == ESP_OK) err = write_data1(0xE0);
    if (err == ESP_OK) err = write_command(0x20);
    if (err == ESP_OK) err = wait_not_busy(2000);
    if (err != ESP_OK) gpio_set_level(PIN_PWR, 1);
    return err;
}

static esp_err_t panel_end(void) {
    esp_err_t err = write_command(0x22); /* power off */
    if (err == ESP_OK) err = write_data1(0x83);
    if (err == ESP_OK) err = write_command(0x20);
    if (err == ESP_OK) err = wait_not_busy(2000);
    gpio_set_level(PIN_PWR, 1);
    return err;
}

static void clear_fb(uint8_t value) { memset(s_fb, value, sizeof(s_fb)); }

static void set_pixel(int x, int y) {
    if (x < 0 || y < 0 || x >= PANEL_W || y >= PANEL_H)
        return;
    s_fb[y * ROW_BYTES + x / 8] &= (uint8_t)~(0x80u >> (x % 8)); /* 0 = black */
}

static void draw_text(int x, int y, const char *text, int scale) {
    if (!text || scale < 1)
        return;
    for (const char *p = text; *p && x < PANEL_W; p++, x += CHAR_ADVANCE * scale) {
        unsigned char c = (unsigned char)*p;
        if (c < 0x20 || c > 0x7E)
            c = ' ';
        for (int col = 0; col < CHAR_W; col++) {
            const unsigned char bits = cp_font5x7[c * CHAR_W + col];
            for (int row = 0; row < CHAR_H; row++) {
                if (!(bits & (1u << row)))
                    continue;
                for (int dx = 0; dx < scale; dx++)
                    for (int dy = 0; dy < scale; dy++)
                        set_pixel(x + col * scale + dx, y + row * scale + dy);
            }
        }
    }
}

static void draw_rule(int y) {
    for (int x = LEFT_MARGIN; x < PANEL_W - LEFT_MARGIN; x++)
        set_pixel(x, y);
}

static void draw_row(int y, const char *label, const char *value) {
    char line[MAX_CHARS + 1];
    snprintf(line, sizeof(line), "%s %s", label, value ? value : "-");
    draw_text(LEFT_MARGIN, y, line, 1);
}

esp_err_t epaper_card_init(void) {
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
    s_ready = true;
    ESP_LOGI(TAG, "SSD1681 panel ready");
    return ESP_OK;
}

bool epaper_card_ready(void) { return s_ready; }

esp_err_t epaper_card_show(const epaper_card_t *card) {
    if (!s_ready || !card)
        return ESP_ERR_INVALID_STATE;

    clear_fb(0xFF);
    draw_text(LEFT_MARGIN, 4, card->title ? card->title : "CAMPUSPULSE", 2);
    draw_text(148, 10, "SNAP", 1); /* All values are from the last screen refresh. */
    draw_rule(24);
    char line[40];
    if (card->setup_active) {
        draw_row(34, "NODE", card->node);
        draw_row(50, "BOARD", card->board);
        draw_row(66, "AUTH", card->authentication);
        draw_row(82, "CAPTURE", card->collection);
        draw_rule(100);
        draw_row(112, "SETUP", card->setup_state);
        draw_text(LEFT_MARGIN, 132, "USE USB", 2);
        draw_rule(158);
        draw_text(LEFT_MARGIN, 172, "CONFIGURE BEFORE USE", 1);
    } else {
        draw_row(29, "NODE", card->node);
        draw_row(41, "NET", card->network);
        if (card->wifi_rssi_known)
            snprintf(line, sizeof(line), "WIFI RSSI %d DBM", card->wifi_rssi_dbm);
        else snprintf(line, sizeof(line), "WIFI RSSI --");
        draw_text(LEFT_MARGIN, 53, line, 1);
        draw_row(65, "AUTH", card->authentication);
        draw_row(77, "CAPTURE", card->collection);
        draw_row(89, "POLICY", card->policy);
        if (card->heap_known)
            snprintf(line, sizeof(line), "HEAP %lu/%lu KIB FREE", card->heap_free / 1024,
                     card->heap_total / 1024);
        else snprintf(line, sizeof(line), "HEAP --");
        draw_text(LEFT_MARGIN, 101, line, 1);
        if (card->queue_known)
            snprintf(line, sizeof(line), "QUEUE %lu/%lu", card->queue_pending, card->queue_capacity);
        else snprintf(line, sizeof(line), "QUEUE --");
        draw_text(LEFT_MARGIN, 113, line, 1);
        snprintf(line, sizeof(line), "UPLOAD %s", card->upload_in_flight ? "SENDING" :
                 card->upload_known ? card->upload_state : "--");
        draw_text(LEFT_MARGIN, 125, line, 1);
        if (card->upload_known)
            snprintf(line, sizeof(line), "LAST %lus  FAIL %lu", card->upload_age_seconds,
                     card->upload_failures);
        else snprintf(line, sizeof(line), "LAST --  FAIL %lu", card->upload_failures);
        draw_text(LEFT_MARGIN, 137, line, 1);
        snprintf(line, sizeof(line), "BLE REPORTS %lu", card->reports_total);
        draw_text(LEFT_MARGIN, 149, line, 1);
        snprintf(line, sizeof(line), "AGG DROP %lu", card->aggregation_drops);
        draw_text(LEFT_MARGIN, 161, line, 1);
        snprintf(line, sizeof(line), "RAW DROP %lu", card->raw_drops);
        draw_text(LEFT_MARGIN, 173, line, 1);
        snprintf(line, sizeof(line), "SUMMARY DROP %lu", card->summary_drops);
        draw_text(LEFT_MARGIN, 185, line, 1);
    }

    esp_err_t err = panel_begin();
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "panel begin failed: %s", esp_err_to_name(err));
        return err;
    }
    if ((err = write_command(0x26)) == ESP_OK) /* previous buffer, full refresh */
        err = write_data(s_fb, FB_BYTES);
    if (err == ESP_OK && (err = write_command(0x24)) == ESP_OK)
        err = write_data(s_fb, FB_BYTES);
    if (err == ESP_OK && (err = write_command(0x22)) == ESP_OK &&
        (err = write_data1(0xF7)) == ESP_OK && (err = write_command(0x20)) == ESP_OK)
        err = wait_not_busy(10000);
    const esp_err_t off = panel_end();
    if (err == ESP_OK)
        err = off;
    ESP_LOGI(TAG, "card refresh %s", err == ESP_OK ? "done" : esp_err_to_name(err));
    return err;
}
