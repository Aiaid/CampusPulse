idf_component_register(
    SRCS "main.c"
         "page_term.c"
         "ui_mini.c"
         "font_zh.c"
         "font_digit.c"
         "net_link.c"
         "obs_api.c"
         "obs_store.c"
    INCLUDE_DIRS "."
    REQUIRES bsp esp_event esp_hw_support esp_netif esp_timer esp_wifi nvs_flash
             esp_http_client esp-tls json
)
