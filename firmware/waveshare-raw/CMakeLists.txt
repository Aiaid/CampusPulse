cmake_minimum_required(VERSION 3.16)
# Default image remains independent of the shared firmware runtime. Only the
# explicit experimental USB-v2 option links these narrowly selected components.
set(COMPONENTS main)
option(RAW_ENABLE_USB_PROVISION_V2 "Explicitly include experimental USB-v2 dependencies" OFF)
if(RAW_ENABLE_USB_PROVISION_V2)
    list(APPEND COMPONENTS cp_core cp_settings cp_network cp_provision)
endif()
set(EXTRA_COMPONENT_DIRS
    "${CMAKE_CURRENT_LIST_DIR}/../components/cp_core"
    "${CMAKE_CURRENT_LIST_DIR}/../components/cp_settings"
    "${CMAKE_CURRENT_LIST_DIR}/../components/cp_network"
    "${CMAKE_CURRENT_LIST_DIR}/../components/cp_provision")
# Optional offline source override; otherwise the component manager fetches
# the exact dependency declared by main/idf_component.yml.
if(DEFINED RAW_LVGL_PATH)
    list(APPEND EXTRA_COMPONENT_DIRS "${RAW_LVGL_PATH}")
endif()
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(waveshare_raw)
if(CONFIG_RAW_USB_PROVISION_V2 AND NOT RAW_ENABLE_USB_PROVISION_V2)
    message(FATAL_ERROR "USB-v2 experiment also requires -D RAW_ENABLE_USB_PROVISION_V2=ON")
endif()
if(RAW_ENABLE_USB_PROVISION_V2 AND NOT CONFIG_RAW_USB_PROVISION_V2)
    message(FATAL_ERROR "USB-v2 experiment also requires CONFIG_RAW_USB_PROVISION_V2=y")
endif()
if(CONFIG_RAW_USB_PROVISION_V2)
    include("${CMAKE_CURRENT_LIST_DIR}/../components/cp_network/cmake/transport_async_errors.cmake")
endif()
