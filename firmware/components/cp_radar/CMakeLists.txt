# Keep imported files at their provenance paths while giving diagnostics a real
# component dependency boundary (no reverse references into the main archive).
set(radar_root "${CMAKE_CURRENT_LIST_DIR}/../../ai-passport-radar/main")
idf_component_register(
    SRCS "${radar_root}/scan_ble.c" "${radar_root}/ad_parse.c"
         "${radar_root}/dev_phone.c" "${radar_root}/veh_rules.c"
         "${radar_root}/dev_diag.c" "${radar_root}/scan_table.c"
         "${radar_root}/scan_stats.c" "${radar_root}/ble_radar.c"
         "${radar_root}/demo_radio.c" "${radar_root}/wifi_time.c"
    INCLUDE_DIRS "${radar_root}"
    REQUIRES bt esp_event esp_hw_support esp_netif esp_timer esp_wifi nvs_flash
)
