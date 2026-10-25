# One verified board adapter per build target. Do not infer hardware at runtime.
if(IDF_TARGET STREQUAL "esp32c3")
    idf_component_register(
        SRCS "passport.c"
        INCLUDE_DIRS "include"
        PRIV_INCLUDE_DIRS "../../ai-passport-radar/main"
        REQUIRES cp_core cp_ui_passport bsp esp_hw_support
        PRIV_REQUIRES esp_timer
    )
elseif(IDF_TARGET STREQUAL "esp32s3")
    # Headless-capable S3 profile with the verified 200x200 ePaper card.
    idf_component_register(
        SRCS "waveshare_epaper.c"
        INCLUDE_DIRS "include"
        REQUIRES cp_core cp_ui_epaper esp_hw_support
        PRIV_REQUIRES esp_timer
    )
else()
    message(FATAL_ERROR "Only the verified Passport C3 and Waveshare S3 profiles are implemented; add and validate another board profile explicitly.")
endif()
