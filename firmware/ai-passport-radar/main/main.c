#include "cp_app.h"
#include "esp_log.h"

void app_main(void)
{
    const esp_err_t result = cp_app_start();
    if (result != ESP_OK)
        ESP_LOGE("main", "Application start failed: %s", esp_err_to_name(result));
}
