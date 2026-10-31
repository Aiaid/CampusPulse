idf_component_register(SRCS "main.c" "../ingress/raw_ingress.c"
    INCLUDE_DIRS "." "../ingress"
    REQUIRES bt esp_timer esp_psram nvs_flash)
