# The inherited Radar sources are a C3 diagnostic mode only. Other targets
# build the canonical collector (cp_pipeline) without them.
if(IDF_TARGET STREQUAL "esp32c3")
    idf_component_register(
        SRCS "app.c"
        INCLUDE_DIRS "include"
        PRIV_INCLUDE_DIRS "../../ai-passport-radar/main"
        REQUIRES cp_core cp_board cp_radar cp_runtime cp_usb
        PRIV_REQUIRES esp_timer
    )
else()
    idf_component_register(
        SRCS "app.c"
        INCLUDE_DIRS "include"
        REQUIRES cp_core cp_board cp_runtime cp_usb
        PRIV_REQUIRES esp_timer
    )
endif()
