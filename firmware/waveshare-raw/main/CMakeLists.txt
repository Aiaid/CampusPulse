idf_component_register(
    SRCS "main.c" "raw_format.c" "raw_board.c" "raw_display.c" "raw_ui.c" "raw_control.c" "raw_activity.c" "raw_fonts.c" "raw_clock.c" "raw_power.c" "raw_export.c" "raw_refresh.c" "raw_panel.c"
    INCLUDE_DIRS "."
    REQUIRES bt nvs_flash fatfs sdmmc esp_driver_sdmmc esp_timer
             esp_hw_support esp_driver_gpio esp_driver_spi esp_driver_usb_serial_jtag esp_driver_i2c esp_psram lvgl__lvgl
)
