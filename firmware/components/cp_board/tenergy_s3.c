/*
 * CampusPulse board adapter: LILYGO T-Energy-S3 V1.0.
 *
 * Scope: the seven cp_board.h entry points for a headless 18650 node. There is
 * no panel, no BSP and no LVGL here; those belong to the Passport adapter.
 * Capabilities are BLE scan plus battery only, so a policy that demands a
 * display or input is rejected by cp_core_validate_policy() instead of silently
 * succeeding and then never being applied.
 *
 * Every pin below is vendor-derived, not measured. See
 * docs/research/t-energy-s3-hardware.md and docs/design/tenergy-s3-port.md.
 * This file has never been built for a device or run on hardware.
 */
#include "cp_board.h"
#include "sdkconfig.h"

#if !CONFIG_IDF_TARGET_ESP32S3
#error "This adapter is the T-Energy-S3 profile; do not compile it for another target."
#endif

#include "esp_adc/adc_cali.h"
#include "esp_adc/adc_cali_scheme.h"
#include "esp_adc/adc_oneshot.h"
#include "esp_chip_info.h"
#include "esp_log.h"
#include "esp_mac.h"
#include <stddef.h>
#include <string.h>

static const char *TAG = "cp_board_s3";

/* The only pin the vendor code assigns: BATTERY_VOLTAGE_DATA = 3. */
#define S3_BATTERY_ADC_UNIT ADC_UNIT_1
#define S3_BATTERY_ADC_CHANNEL ADC_CHANNEL_2
#define S3_BATTERY_ADC_ATTEN ADC_ATTEN_DB_12
#define S3_BATTERY_ADC_WIDTH ADC_BITWIDTH_12
#define S3_BATTERY_ADC_SAMPLES 16
#define S3_BATTERY_ADC_MAX_RAW 4095
#define S3_BATTERY_ADC_FALLBACK_FULL_SCALE_MV 3100

/* The pack is halved by an on-board divider before the ADC pin. */
#define S3_BATTERY_DIVIDER 2

static adc_oneshot_unit_handle_t s_adc;
static adc_cali_handle_t s_cali;
static bool s_battery_ready;

/* Compiled ceilings, not authorizations and not measured capacity. They match
 * the Passport values because the collector, not the board, sets the budget. */
static const cp_board_profile_t s_profile = {
    .board_id = "tenergy_s3",
    .revision = "v1.0",
    .target_chip = "esp32s3",
    .capabilities = CP_CAP_BLE_SCAN | CP_CAP_BATTERY,
    .max_addresses = 384,
    .ingress_queue_bytes = 8192,
    .max_collection_lease_ms = 300000,
};

const cp_board_profile_t *cp_board_profile(void) { return &s_profile; }

esp_err_t cp_board_factory_mac(uint8_t mac[6])
{
    if (mac == NULL) return ESP_ERR_INVALID_ARG;
    esp_chip_info_t chip;
    esp_chip_info(&chip);
    if (chip.model != CHIP_ESP32S3) return ESP_ERR_NOT_SUPPORTED;
    return esp_efuse_mac_get_default(mac);
}

/* Uncalibrated 18650 estimate between 3.30 V and 4.20 V. The real divider
 * resistor values, ADC linearity and low-voltage cut-off have not been measured,
 * so this value is orientation only: it must never gate collection or upload. */
static int percent_from_mv(int32_t pack_mv)
{
    static const int32_t mv[] = {3300, 3400, 3500, 3600, 3700, 3800, 3900, 4000, 4200};
    static const int8_t pct[] = {0, 5, 10, 20, 35, 50, 65, 80, 100};
    const size_t last = sizeof pct / sizeof pct[0] - 1u;

    if (pack_mv <= mv[0]) return 0;
    if (pack_mv >= mv[last]) return 100;
    for (size_t i = 0; i < last; ++i) {
        if (pack_mv >= mv[i] && pack_mv <= mv[i + 1]) {
            const int32_t span_mv = mv[i + 1] - mv[i];
            const int32_t span_pct = pct[i + 1] - pct[i];
            return pct[i] + (int)((pack_mv - mv[i]) * span_pct / span_mv);
        }
    }
    return -1;
}

static esp_err_t battery_init(void)
{
    adc_oneshot_unit_init_cfg_t unit_cfg = {.unit_id = S3_BATTERY_ADC_UNIT};
    esp_err_t err = adc_oneshot_new_unit(&unit_cfg, &s_adc);
    if (err != ESP_OK) return err;

    adc_oneshot_chan_cfg_t chan_cfg = {
        .atten = S3_BATTERY_ADC_ATTEN,
        .bitwidth = S3_BATTERY_ADC_WIDTH,
    };
    err = adc_oneshot_config_channel(s_adc, S3_BATTERY_ADC_CHANNEL, &chan_cfg);
    if (err != ESP_OK) return err;

    adc_cali_curve_fitting_config_t cali_cfg = {
        .unit_id = S3_BATTERY_ADC_UNIT,
        .chan = S3_BATTERY_ADC_CHANNEL,
        .atten = S3_BATTERY_ADC_ATTEN,
        .bitwidth = S3_BATTERY_ADC_WIDTH,
    };
    if (adc_cali_create_scheme_curve_fitting(&cali_cfg, &s_cali) != ESP_OK) {
        s_cali = NULL;
        ESP_LOGW(TAG, "battery ADC without calibration; readings are approximate");
    }
    s_battery_ready = true;
    return ESP_OK;
}

static esp_err_t battery_read_mv(int32_t *out_mv)
{
    if (out_mv == NULL) return ESP_ERR_INVALID_ARG;
    if (s_adc == NULL) return ESP_ERR_INVALID_STATE;

    int64_t pin_total_mv = 0;
    int usable = 0;
    for (int i = 0; i < S3_BATTERY_ADC_SAMPLES; ++i) {
        int raw = 0;
        if (adc_oneshot_read(s_adc, S3_BATTERY_ADC_CHANNEL, &raw) != ESP_OK) continue;

        int pin_mv = 0;
        if (s_cali != NULL) {
            if (adc_cali_raw_to_voltage(s_cali, raw, &pin_mv) != ESP_OK) continue;
        } else {
            pin_mv = raw * S3_BATTERY_ADC_FALLBACK_FULL_SCALE_MV / S3_BATTERY_ADC_MAX_RAW;
        }
        pin_total_mv += pin_mv;
        ++usable;
    }
    if (usable == 0) return ESP_FAIL;

    *out_mv = (int32_t)((pin_total_mv / usable) * S3_BATTERY_DIVIDER);
    return ESP_OK;
}

int cp_board_battery_percent(void)
{
    if (!s_battery_ready) return -1;
    int32_t pack_mv = 0;
    if (battery_read_mv(&pack_mv) != ESP_OK) return -1;
    return percent_from_mv(pack_mv);
}

/* Optional peripherals never gate startup: a failed ADC is reported in health
 * and the node keeps collecting. This board has no display and no UI input. */
esp_err_t cp_board_initialize(cp_board_health_t *health,
                              cp_input_handler_t handler, void *context)
{
    (void)handler;
    (void)context;
    if (health == NULL) return ESP_ERR_INVALID_ARG;

    health->display_ready = false;
    health->display_error = ESP_ERR_NOT_SUPPORTED;
    health->input_ready = false;
    health->input_error = ESP_ERR_NOT_SUPPORTED;

    const esp_err_t err = battery_init();
    health->battery_ready = err == ESP_OK;
    health->battery_error = err;
    if (err != ESP_OK)
        ESP_LOGW(TAG, "battery ADC unavailable: %s", esp_err_to_name(err));

    ESP_LOGI(TAG, "T-Energy-S3 adapter ready; battery=%d", health->battery_ready);
    return ESP_OK;
}

/* Headless: the semantic view has no renderer. A status endpoint, not this
 * function, is where a headless node reports its state. */
void cp_board_present(const cp_board_view_t *view)
{
    (void)view;
}

/* The inherited Radar diagnostic UI is Passport-shaped and has no renderer here. */
esp_err_t cp_board_start_diagnostic_ui(void) { return ESP_ERR_NOT_SUPPORTED; }

void cp_board_diagnostic_input(const cp_input_event_t *event)
{
    (void)event;
}
