cmake_minimum_required(VERSION 3.16)
set(EXTRA_COMPONENT_DIRS "${CMAKE_CURRENT_LIST_DIR}/../components/cp_v3_stats" "${CMAKE_CURRENT_LIST_DIR}/../components/cp_v3_temporal")
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(campuspulse_tenergy_v3_probe)
