cmake_minimum_required(VERSION 3.16)
# Deliberately independent of the existing CampusPulse shared firmware chain.
set(COMPONENTS main)
# Optional offline source override; otherwise the component manager fetches
# the exact dependency declared by main/idf_component.yml.
if(DEFINED RAW_LVGL_PATH)
    set(EXTRA_COMPONENT_DIRS "${RAW_LVGL_PATH}")
endif()
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(waveshare_raw)
