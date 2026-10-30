cmake_minimum_required(VERSION 3.16)
set(EXTRA_COMPONENT_DIRS "${CMAKE_CURRENT_LIST_DIR}/../components")
# USB setup does not use the SDK wireless provisioning manager.
set(EXCLUDE_COMPONENTS wifi_provisioning)
include($ENV{IDF_PATH}/tools/cmake/project.cmake)

project(CampusPulse-AI-Passport-Radar)

include("${CMAKE_CURRENT_LIST_DIR}/../components/cp_network/cmake/transport_async_errors.cmake")
