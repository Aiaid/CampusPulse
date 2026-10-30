#include "cp_app.h"
#include "esp_err.h"
#include "esp_log.h"

void app_main(void)
{
    /* The shared chain owns everything after this call: factory identity, board
     * profile, console, runtime state machine, the bounded queue and the setup
     * transport. A headless board with no enrollment ends in awaiting_usb_setup
     * rather than falling back to a display it does not have. */
    const esp_err_t result = cp_app_start();
    if (result != ESP_OK)
        ESP_LOGE("main", "Application start failed: %s", esp_err_to_name(result));
}
