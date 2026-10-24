#pragma once
#include "cp_core.h"
#include "esp_err.h"
#include <stdbool.h>
#include <stdint.h>

typedef enum { CP_BUTTON_UP, CP_BUTTON_DOWN, CP_BUTTON_OK } cp_button_t;
typedef enum { CP_INPUT_PRESS, CP_INPUT_CLICK, CP_INPUT_DOUBLE,
               CP_INPUT_LONG, CP_INPUT_RELEASE } cp_input_kind_t;
typedef struct {
    cp_button_t button;
    cp_input_kind_t kind;
    uint64_t monotonic_ms;
} cp_input_event_t;
typedef void (*cp_input_handler_t)(const cp_input_event_t *event, void *context);
typedef struct {
    bool display_ready, input_ready, battery_ready;
    esp_err_t display_error, input_error, battery_error;
} cp_board_health_t;
/* Semantic state, not shared pixels or a shared refresh policy. */
typedef struct {
    char node_id[32], board[24], network[24], authentication[24];
    char policy[24], collection[24];
    int battery_percent;
    bool setup_active,setup_softap;
    char setup_name[32],setup_proof[33],setup_password[33],setup_state[24];
} cp_board_view_t;

const cp_board_profile_t *cp_board_profile(void);
esp_err_t cp_board_initialize(cp_board_health_t *health,
                             cp_input_handler_t handler, void *context);
esp_err_t cp_board_factory_mac(uint8_t mac[6]);
int cp_board_battery_percent(void);
/* Only the supervisor renders outside explicit diagnostics. */
void cp_board_present(const cp_board_view_t *view);
esp_err_t cp_board_start_diagnostic_ui(void);
void cp_board_diagnostic_input(const cp_input_event_t *event);
