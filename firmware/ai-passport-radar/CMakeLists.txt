cmake_minimum_required(VERSION 3.16)
set(EXTRA_COMPONENT_DIRS "${CMAKE_CURRENT_LIST_DIR}/../components")
include($ENV{IDF_PATH}/tools/cmake/project.cmake)

project(CampusPulse-AI-Passport-Radar)

# Pinned SDK private IV alignment fix, generated only inside each build directory.
include("${CMAKE_CURRENT_LIST_DIR}/../components/cp_provision/cmake/security2_alignment.cmake")
include("${CMAKE_CURRENT_LIST_DIR}/../components/cp_network/cmake/transport_async_errors.cmake")
