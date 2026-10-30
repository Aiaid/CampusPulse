if(NOT IDF_TARGET STREQUAL "esp32s3")
    message(FATAL_ERROR "The Waveshare ePaper adapter requires ESP32-S3")
endif()
idf_component_register(
    SRCS "../../../components/cp_board/waveshare_epaper.c"
    INCLUDE_DIRS "../../../components/cp_board/include"
    REQUIRES cp_core cp_collect cp_ui_epaper esp_hw_support
    PRIV_REQUIRES esp_timer log
)
