cmake_minimum_required(VERSION 3.16)
# Offline CPRAW recorder. V3 runtime setup is independent of this application.
set(COMPONENTS main)
set(EXTRA_COMPONENT_DIRS "")
# Optional pinned LVGL source for offline builds.
if(DEFINED RAW_LVGL_PATH)
    list(APPEND EXTRA_COMPONENT_DIRS "${RAW_LVGL_PATH}")
endif()
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(waveshare_raw)
