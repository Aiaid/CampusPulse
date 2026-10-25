if(NOT IDF_TARGET STREQUAL "esp32c3")
    message(FATAL_ERROR "Only the verified-source Passport C3 profile is implemented; add and validate an S3 board profile explicitly.")
endif()
idf_component_register(
    SRCS "passport.c"
    INCLUDE_DIRS "include"
    PRIV_INCLUDE_DIRS "../../ai-passport-radar/main"
    REQUIRES cp_core cp_ui_passport bsp esp_hw_support
    PRIV_REQUIRES esp_timer
)
