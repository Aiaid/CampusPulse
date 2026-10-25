cmake_minimum_required(VERSION 3.16)

# Shared components; the Passport-only diagnostic components are excluded so
# this target contains the canonical collector without inherited C3 UI code.
set(EXTRA_COMPONENT_DIRS "${CMAKE_CURRENT_LIST_DIR}/../components")
set(EXCLUDE_COMPONENTS "cp_radar;cp_ui_passport")

include($ENV{IDF_PATH}/tools/cmake/project.cmake)

project(CampusPulse-Epaper-Collector)

# Pinned SDK private IV alignment fix, generated only inside each build directory.
include("${CMAKE_CURRENT_LIST_DIR}/../components/cp_provision/cmake/security2_alignment.cmake")
include("${CMAKE_CURRENT_LIST_DIR}/../components/cp_network/cmake/transport_async_errors.cmake")
