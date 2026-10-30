idf_component_register(
    SRCS "board.c" "main.c"
    INCLUDE_DIRS "."
    REQUIRES esp_adc esp_partition esp_psram esp_hw_support spi_flash esp_common log
)
