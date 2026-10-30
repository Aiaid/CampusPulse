if(NOT IDF_TARGET STREQUAL "esp32s3")
    message(FATAL_ERROR "The T-Energy-S3 board adapter requires esp32s3")
endif()
idf_component_register(
    SRCS "tenergy_s3.c"
    INCLUDE_DIRS "../../../components/cp_board/include"
    REQUIRES cp_core cp_collect esp_hw_support
    PRIV_REQUIRES esp_adc log
)
