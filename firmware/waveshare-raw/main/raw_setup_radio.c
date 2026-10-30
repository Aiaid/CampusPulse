#include "raw_setup_radio.h"

esp_err_t raw_setup_radio_admit(const raw_setup_radio_state_t *state) {
    if (!state) return ESP_ERR_INVALID_ARG;
    return state->writer_done && state->storage_safe && state->stop_requested &&
        !state->accepting_reports && !state->scanning && !state->callbacks &&
        !state->power_requested ? ESP_OK : ESP_ERR_INVALID_STATE;
}
