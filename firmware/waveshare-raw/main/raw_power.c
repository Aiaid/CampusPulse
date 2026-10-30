#include "raw_power.h"

#include <stdint.h>
#include "driver/gpio.h"
#include "driver/rtc_io.h"
#include "esp_sleep.h"

/* Waveshare V2 schematic and 07_BATT_PWR_Test, pinned upstream commit
 * aaf395c1bbd86f7c5b7a2f9f0401241ff5c44956: GPIO17 HIGH holds battery ON.
 * USB VBUS supplies VSYS through D4 independently of this battery latch. */
#define POWER_HOLD GPIO_NUM_17
#define POWER_BUTTON GPIO_NUM_18
#define BOOT_BUTTON GPIO_NUM_0

static bool power_ready;

esp_err_t raw_power_init(void)
{
    power_ready = false;
    /* Preload the output latch before switching direction: never pulse LOW
     * during initialization. EPD/audio power use the opposite polarity. */
    esp_err_t error = gpio_set_level(POWER_HOLD, 1);
    if (error != ESP_OK) return error;
    const gpio_config_t hold = {
        .pin_bit_mask = UINT64_C(1) << POWER_HOLD,
        .mode = GPIO_MODE_OUTPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    error = gpio_config(&hold);
    if (error != ESP_OK) return error;
    const gpio_config_t buttons = {
        .pin_bit_mask = (UINT64_C(1) << POWER_BUTTON) | (UINT64_C(1) << BOOT_BUTTON),
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    error = gpio_config(&buttons);
    if (error == ESP_OK) power_ready = true;
    return error;
}

bool raw_power_pressed(void)
{
    return gpio_get_level(POWER_BUTTON) == 0;
}

bool raw_boot_pressed(void)
{
    return gpio_get_level(BOOT_BUTTON) == 0;
}

esp_err_t raw_power_shutdown(void)
{
    if (!power_ready || raw_power_pressed()) return ESP_ERR_INVALID_STATE;
    /* All fallible setup happens before releasing GPIO17. esp_sleep enables
     * RTC pin routing immediately before sleep, so digital PWR remains usable
     * if preparation fails. Keep RTC peripheral pulls powered during USB-off. */
    esp_err_t error = rtc_gpio_pullup_en(POWER_BUTTON);
    if (error != ESP_OK) return error;
    error = rtc_gpio_pulldown_dis(POWER_BUTTON);
    if (error != ESP_OK) return error;
    error = esp_sleep_pd_config(ESP_PD_DOMAIN_RTC_PERIPH, ESP_PD_OPTION_ON);
    if (error != ESP_OK) return error;
    error = esp_sleep_enable_ext1_wakeup_io(UINT64_C(1) << POWER_BUTTON,
                                            ESP_EXT1_WAKEUP_ANY_LOW);
    if (error != ESP_OK) return error;
    if (raw_power_pressed()) return ESP_ERR_INVALID_STATE;
    error = gpio_set_level(POWER_HOLD, 0);
    if (error != ESP_OK) return error;
    esp_deep_sleep_start();
    return ESP_ERR_INVALID_STATE; /* Defensive if a platform stub returns. */
}
