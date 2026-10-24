set(ui_root "${CMAKE_CURRENT_LIST_DIR}/../../ai-passport-radar/main")
idf_component_register(
    SRCS "${ui_root}/page_radar.c" "${ui_root}/page_status.c"
         "${ui_root}/ui_mini.c" "${ui_root}/font_zh.c" "${ui_root}/font_digit.c"
    INCLUDE_DIRS "${ui_root}"
    REQUIRES cp_radar bsp esp_timer
)
