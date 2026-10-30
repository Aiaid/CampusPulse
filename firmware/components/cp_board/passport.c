#include "cp_board.h"
#include "sdkconfig.h"
#if !CONFIG_IDF_TARGET_ESP32C3
#error "Passport supports ESP32-C3 only; verify a board before adding its profile."
#endif
#include "bsp_battery.h"
#include "bsp_button.h"
#include "bsp_display.h"
#include "bsp_pins.h"
#include "esp_chip_info.h"
#include "esp_mac.h"
#include "esp_sleep.h"
#include "esp_timer.h"
#include "key_guard.h"
#include "page_radar.h"
#include "page_status.h"
#include "cp_perf.h"
#include "display_schedule.h"
#include "ui_mini.h"
#include <stdio.h>
#include <string.h>

static cp_input_handler_t s_handler;
static void *s_handler_context;
#if CONFIG_CP_PASSPORT_BUTTONS
static key_guard_t s_wake_guard;
#endif
static bool s_display_ready, s_battery_ready, s_have_view;
static cp_status_view_t s_last_view;
static uint64_t s_last_render_ms;
#ifndef CONFIG_CP_PASSPORT_REFRESH_MS
#define CONFIG_CP_PASSPORT_REFRESH_MS 2000
#endif
static const cp_board_profile_t s_profile = {
    .board_id = "passport_c3",
    .revision = "imported_pins_unverified",
    .target_chip = "esp32c3",
    .capabilities = CP_CAP_BLE_SCAN | CP_CAP_BATTERY
#if CONFIG_CP_PASSPORT_DISPLAY
                    | CP_CAP_DISPLAY
#endif
#if CONFIG_CP_PASSPORT_BUTTONS
                    | CP_CAP_INPUT
#endif
    ,
    .max_addresses = 128,
    .ingress_queue_bytes = 8192,
    /* A compiled ceiling, not an authorization grant or measured capacity. */
    .max_collection_lease_ms = 300000,
};

const cp_board_profile_t *cp_board_profile(void) { return &s_profile; }
esp_err_t cp_board_factory_mac(uint8_t mac[6]) {
    if (!mac)
        return ESP_ERR_INVALID_ARG;
    esp_chip_info_t chip;
    esp_chip_info(&chip);
    if (chip.model != CHIP_ESP32C3)
        return ESP_ERR_NOT_SUPPORTED;
    return esp_efuse_mac_get_default(mac);
}
#if CONFIG_CP_PASSPORT_DISPLAY
static void paint_boot(void *context) {
    (void)context;
    ui_clear(UI_COL_BG);
}
#endif
#if CONFIG_CP_PASSPORT_BUTTONS
static void on_button(bsp_btn_t button, bsp_btn_ev_t kind, void *context) {
    (void)context;
    const uint64_t now = (uint64_t)esp_timer_get_time() / 1000;
    if (key_guard_consume(&s_wake_guard, kind == BSP_BTN_RELEASE, (int64_t)now * 1000))
        return;
    cp_input_event_t event = {.monotonic_ms = now};
    switch (button) {
    case BSP_BTN_UP:
        event.button = CP_BUTTON_UP;
        break;
    case BSP_BTN_DOWN:
        event.button = CP_BUTTON_DOWN;
        break;
    case BSP_BTN_OK:
        event.button = CP_BUTTON_OK;
        break;
    default:
        return;
    }
    switch (kind) {
    case BSP_BTN_PRESS:
        event.kind = CP_INPUT_PRESS;
        break;
    case BSP_BTN_CLICK:
        event.kind = CP_INPUT_CLICK;
        break;
    case BSP_BTN_DOUBLE:
        event.kind = CP_INPUT_DOUBLE;
        break;
    case BSP_BTN_LONG:
        event.kind = CP_INPUT_LONG;
        break;
    case BSP_BTN_RELEASE:
        event.kind = CP_INPUT_RELEASE;
        break;
    default:
        return;
    }
    if (s_handler)
        s_handler(&event, s_handler_context);
}
#endif
esp_err_t cp_board_initialize(cp_board_health_t *health, cp_input_handler_t handler,
                              void *context) {
    if (!health)
        return ESP_ERR_INVALID_ARG;
    memset(health, 0, sizeof(*health));
    health->display_error = health->input_error = ESP_ERR_NOT_SUPPORTED;
    s_handler = handler;
    s_handler_context = context;
    health->battery_error = bsp_battery_init();
    s_battery_ready = health->battery_ready = health->battery_error == ESP_OK;
#if CONFIG_CP_PASSPORT_DISPLAY
    health->display_error = bsp_display_init();
    if (health->display_error == ESP_OK)
        health->display_error = ui_init(bsp_display_panel());
    s_display_ready = health->display_ready = health->display_error == ESP_OK;
    if (s_display_ready) {
        ui_render((ui_rect_t){0, 0, UI_W, UI_H}, paint_boot, NULL);
        bsp_display_backlight(100);
    }
#endif
#if CONFIG_CP_PASSPORT_BUTTONS
    if (esp_sleep_get_wakeup_causes() & (1u << ESP_SLEEP_WAKEUP_GPIO))
        key_guard_arm(&s_wake_guard, esp_timer_get_time(), 10LL * 1000 * 1000);
    health->input_error = bsp_button_init(on_button, NULL);
    health->input_ready = health->input_error == ESP_OK;
    if (health->input_ready && s_wake_guard.armed)
        key_guard_sync_released(&s_wake_guard, bsp_button_read_mv() >= BSP_BTN_MV_RELEASED_MIN);
#endif
    /* Optional peripheral errors do not prevent application services starting. */
    return ESP_OK;
}
int cp_board_battery_percent(void) { return s_battery_ready ? bsp_battery_soc() : -1; }
void cp_board_present(const cp_board_view_t *view) {
    if (!view || !s_display_ready)
        return;
    const uint64_t now=(uint64_t)esp_timer_get_time()/1000;
    cp_status_view_t screen;
    memset(&screen,0,sizeof screen);
    screen.battery_percent=view->battery_percent;
#define COPY_FIELD(field) snprintf(screen.field, sizeof(screen.field), "%s", view->field)
    COPY_FIELD(node_id);
    COPY_FIELD(board);
    COPY_FIELD(network);
    COPY_FIELD(authentication);
    COPY_FIELD(policy);
    COPY_FIELD(collection);
    COPY_FIELD(setup_state);
    screen.setup_active = view->setup_active;
    screen.debug = view->debug;
    screen.page = view->page;
    /* Age text stops at 999s+; subsecond telemetry never defeats redraw
     * deduplication. This affects presentation only, not producer evidence. */
    screen.debug.upload.last_age_ms=screen.debug.upload.last_age_ms>=1000000 ?
        1000000 : screen.debug.upload.last_age_ms/1000*1000;
    screen.debug.upload.attempt_elapsed_ms=screen.debug.upload.attempt_elapsed_ms/1000*1000;
#undef COPY_FIELD
    if (!cp_display_should_render(&screen, &s_last_view, s_have_view, now,
                                  s_last_render_ms, CONFIG_CP_PASSPORT_REFRESH_MS))
        return;
    CP_PERF_START(paint_started);
    status_page_render_diff(&screen, s_have_view ? &s_last_view : NULL);
    CP_PERF_END(CP_PERF_UI_RENDER, 0, paint_started);
    s_last_render_ms=now;
    s_last_view = screen;
    s_have_view = true;
}
esp_err_t cp_board_start_diagnostic_ui(void) {
    return s_display_ready ? radar_page_start() : ESP_ERR_NOT_SUPPORTED;
}
void cp_board_diagnostic_input(const cp_input_event_t *event) {
    if (!event || !s_display_ready)
        return;
    bsp_btn_t button;
    bsp_btn_ev_t kind;
    switch (event->button) {
    case CP_BUTTON_UP:
        button = BSP_BTN_UP;
        break;
    case CP_BUTTON_DOWN:
        button = BSP_BTN_DOWN;
        break;
    case CP_BUTTON_OK:
        button = BSP_BTN_OK;
        break;
    default:
        return;
    }
    switch (event->kind) {
    case CP_INPUT_PRESS:
        kind = BSP_BTN_PRESS;
        break;
    case CP_INPUT_CLICK:
        kind = BSP_BTN_CLICK;
        break;
    case CP_INPUT_DOUBLE:
        kind = BSP_BTN_DOUBLE;
        break;
    case CP_INPUT_LONG:
        kind = BSP_BTN_LONG;
        break;
    case CP_INPUT_RELEASE:
        kind = BSP_BTN_RELEASE;
        break;
    default:
        return;
    }
    radar_page_key_at(button, kind, (int64_t)event->monotonic_ms * 1000);
}
