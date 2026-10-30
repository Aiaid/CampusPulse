# Active headless S3 entry point, using the current shared CampusPulse chain.
cmake_minimum_required(VERSION 3.16)

set(EXTRA_COMPONENT_DIRS "${CMAKE_CURRENT_LIST_DIR}/../components")
# IDF 5.5.3 registers extra components before project components/cp_board.
# The SDK's unused Wi-Fi provisioning manager requires a protocomm security
# version even though this application's setup transport is physical USB only.
set(EXCLUDE_COMPONENTS cp_ui_passport wifi_provisioning)
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(campuspulse_tenergy_s3)

# Same build-local pinned SDK repairs as the current shared chain.
include("${CMAKE_CURRENT_LIST_DIR}/../components/cp_network/cmake/transport_async_errors.cmake")

idf_component_get_property(CP_S3_BOARD_DIR cp_board COMPONENT_DIR)
if(NOT CP_S3_BOARD_DIR STREQUAL "${CMAKE_CURRENT_LIST_DIR}/components/cp_board")
    message(FATAL_ERROR "S3 build must use the project-local cp_board override")
endif()
