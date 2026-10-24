idf_component_register(
    SRCS "app.c"
    INCLUDE_DIRS "include"
    PRIV_INCLUDE_DIRS "../../ai-passport-radar/main"
    REQUIRES cp_core cp_board cp_radar cp_runtime cp_usb
    PRIV_REQUIRES esp_timer
)
