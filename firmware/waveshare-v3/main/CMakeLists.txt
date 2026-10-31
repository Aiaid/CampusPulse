set(RAW_DIR "${CMAKE_CURRENT_LIST_DIR}/../../waveshare-raw/main")
set(TRIAL_DIR "${CMAKE_CURRENT_LIST_DIR}/../../waveshare-v3-trial/main")
idf_component_register(
    SRCS "main.c" "local_raw.c" "${TRIAL_DIR}/trial_bootstrap.c"
         "${RAW_DIR}/raw_board.c" "${RAW_DIR}/raw_power.c"
         "${RAW_DIR}/raw_battery.c" "${RAW_DIR}/raw_clock.c"
         "${RAW_DIR}/raw_format.c" "${RAW_DIR}/raw_display.c"
         "edge_ui.c" "edge_fonts.c"
         "${RAW_DIR}/raw_panel.c" "${RAW_DIR}/raw_refresh.c"
         "${RAW_DIR}/raw_v3_queue_store.c" "${RAW_DIR}/raw_v3_queue_sd_sync.c"
    INCLUDE_DIRS "." "${RAW_DIR}" "${TRIAL_DIR}"
    REQUIRES cp_v3_control cp_v3_queue cp_v3_budget cp_v3_transport cp_v3_stats
             cp_v3_temporal cp_v3_capture cp_v3_small_results
             nvs_flash json bootloader_support esp_timer esp_psram esp_wifi esp_netif
             fatfs sdmmc esp_driver_sdmmc esp_driver_gpio esp_driver_spi
             esp_driver_i2c esp_driver_usb_serial_jtag esp_adc lvgl__lvgl)
target_compile_definitions(${COMPONENT_LIB} PRIVATE RAW_DISPLAY_EXTERNAL_RENDER=1 CP_V3_BOOTSTRAP_CONTINUOUS=1)
