idf_component_register(
    SRCS "epaper_card.c" "font5x7.c"
    INCLUDE_DIRS "include"
    REQUIRES driver esp_timer
)
