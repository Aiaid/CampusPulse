cmake_minimum_required(VERSION 3.16)
set(COMPONENTS main)
set(EXTRA_COMPONENT_DIRS
    "${CMAKE_CURRENT_LIST_DIR}/../components/cp_v3_capture"
    "${CMAKE_CURRENT_LIST_DIR}/../components/cp_v3_budget"
    "${CMAKE_CURRENT_LIST_DIR}/../components/cp_v3_small_results"
    "${CMAKE_CURRENT_LIST_DIR}/../components/cp_v3_stats"
    "${CMAKE_CURRENT_LIST_DIR}/../components/cp_v3_temporal"
    "${CMAKE_CURRENT_LIST_DIR}/../components/cp_v3_evidence"
    "${CMAKE_CURRENT_LIST_DIR}/../components/cp_v3_control"
    "${CMAKE_CURRENT_LIST_DIR}/../components/cp_v3_queue"
    "${CMAKE_CURRENT_LIST_DIR}/../components/cp_v3_transport"
    "${CMAKE_CURRENT_LIST_DIR}/../components/cp_settings")
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(t_energy_v3_trial)
