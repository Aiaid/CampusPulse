cmake_minimum_required(VERSION 3.16)
set(EXTRA_COMPONENT_DIRS "${CMAKE_CURRENT_LIST_DIR}/../../components/cp_settings")
set(COMPONENTS main)
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(CampusPulse-CF-Longlink-Diagnostic)
# Reuse the fingerprint-gated build-local SDK retry repair; do not link the
# production network runtime or modify the installed ESP-IDF checkout.
include("${CMAKE_CURRENT_LIST_DIR}/../../components/cp_network/cmake/transport_async_errors.cmake")
