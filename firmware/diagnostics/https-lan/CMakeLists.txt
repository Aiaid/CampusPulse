cmake_minimum_required(VERSION 3.16)
option(CP_LAN_BLE_LOAD "Enable real passive BLE plus RAM-only aggregation" OFF)
# Discover pure components, but only link them when the Kconfig mode is on.
set(EXTRA_COMPONENT_DIRS "${CMAKE_CURRENT_LIST_DIR}/../../components/cp_settings"
    "${CMAKE_CURRENT_LIST_DIR}/../../components/cp_collect"
    "${CMAKE_CURRENT_LIST_DIR}/../../components/cp_vehicle")
if(CP_LAN_BLE_LOAD)
    set(SDKCONFIG_DEFAULTS "${CMAKE_CURRENT_LIST_DIR}/sdkconfig.defaults;${CMAKE_CURRENT_LIST_DIR}/sdkconfig.ble-load")
endif()
set(COMPONENTS main)
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
# Export the CMake mode into IDF's early dependency-expansion script; Kconfig
# cannot select a dependency before that component's Kconfig has been loaded.
idf_build_set_property(CP_LAN_BLE_LOAD "${CP_LAN_BLE_LOAD}")
project(CampusPulse-LAN-HTTPS-Diagnostic)
# Pin the existing async retry/error repair without linking cp_network.
include("${CMAKE_CURRENT_LIST_DIR}/../common/cmake/transport_async_errors.cmake")
