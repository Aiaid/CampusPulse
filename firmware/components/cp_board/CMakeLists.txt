# Exactly one board profile per build. The C3 path is the verified Passport
# adapter; the S3 path is the T-Energy adapter, which deliberately has no BSP,
# no LVGL and no display. Neither profile may inherit the other's pins.
if(IDF_TARGET STREQUAL "esp32c3")
    set(cp_board_srcs "passport.c")
    set(cp_board_priv_include "../../ai-passport-radar/main")
    set(cp_board_requires cp_core cp_ui_passport bsp esp_hw_support)
elseif(IDF_TARGET STREQUAL "esp32s3")
    set(cp_board_srcs "tenergy_s3.c")
    set(cp_board_priv_include ".")
    set(cp_board_requires cp_core esp_adc esp_hw_support)
else()
    message(FATAL_ERROR
        "No board profile for IDF_TARGET=${IDF_TARGET}; add and validate one explicitly.")
endif()

idf_component_register(
    SRCS "${cp_board_srcs}"
    INCLUDE_DIRS "include"
    PRIV_INCLUDE_DIRS "${cp_board_priv_include}"
    REQUIRES ${cp_board_requires}
    PRIV_REQUIRES esp_timer
)
