set(RAW_DIR "${CMAKE_CURRENT_LIST_DIR}/../../waveshare-raw/main")
idf_component_register(
    SRCS "main.c" "trial_bootstrap.c"
         "${RAW_DIR}/raw_v3_queue_store.c" "${RAW_DIR}/raw_v3_queue_sd_sync.c"
         "${RAW_DIR}/raw_board.c" "${RAW_DIR}/raw_power.c"
         "${RAW_DIR}/raw_battery.c" "${RAW_DIR}/raw_clock.c"
         "${RAW_DIR}/raw_display.c" "${RAW_DIR}/raw_ui.c"
         "${RAW_DIR}/raw_fonts.c" "${RAW_DIR}/raw_panel.c" "${RAW_DIR}/raw_refresh.c"
    INCLUDE_DIRS "." "${RAW_DIR}"
    REQUIRES cp_v3_evidence cp_v3_control cp_v3_queue cp_v3_transport
             bt nvs_flash json bootloader_support esp_timer esp_psram
             fatfs sdmmc esp_driver_sdmmc esp_driver_gpio esp_driver_spi
             esp_driver_i2c esp_driver_usb_serial_jtag esp_adc lvgl__lvgl)
target_compile_definitions(${COMPONENT_LIB} PRIVATE RAW_DISPLAY_EXTERNAL_RENDER=1)
