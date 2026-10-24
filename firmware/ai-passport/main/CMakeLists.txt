idf_component_register(
    SRCS "wifi_time.c" "wifi_link.c" "frame_upload.c" "frame_batch.c" "raw_store.c" "raw_ring.c" "main.c"
         "page_radar.c"
         "ui_mini.c"
         "font_zh.c"
         "font_digit.c"
         "demo_radio.c"
        
         "scan_ble.c"
         "ad_parse.c"
         "dev_phone.c"
         "veh_rules.c"
         "dev_diag.c"
         "scan_table.c"
         "scan_stats.c"
         "ble_radar.c"
    INCLUDE_DIRS "."
    REQUIRES bsp bt esp_event esp_http_client esp_hw_support esp_netif esp_partition esp_timer esp-tls esp_wifi mbedtls nvs_flash
)
