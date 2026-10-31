# Include after project(): component targets exist. The installed SDK is read-only.
if(CONFIG_ESP_HTTP_CLIENT_ENABLE_HTTPS)
    set(CP_TRANSPORT_PATCH_DIR "${CMAKE_BINARY_DIR}/campuspulse-transport-patch")
    find_program(CP_TRANSPORT_PATCH_UV NAMES uv REQUIRED)
    execute_process(
        COMMAND "${CP_TRANSPORT_PATCH_UV}" --cache-dir "${CMAKE_BINARY_DIR}/.uv-cache" run --no-project
                "${CMAKE_CURRENT_LIST_DIR}/patch_transport_async.py"
                --idf-path "$ENV{IDF_PATH}" --output "${CP_TRANSPORT_PATCH_DIR}"
        RESULT_VARIABLE CP_TRANSPORT_PATCH_RESULT
        OUTPUT_VARIABLE CP_TRANSPORT_PATCH_OUTPUT
        ERROR_VARIABLE CP_TRANSPORT_PATCH_ERROR)
    if(NOT CP_TRANSPORT_PATCH_RESULT EQUAL 0)
        message(FATAL_ERROR "Cannot apply pinned async transport repair: ${CP_TRANSPORT_PATCH_ERROR}")
    endif()
    idf_component_get_property(CP_TRANSPORT_LIB tcp_transport COMPONENT_LIB)
    get_target_property(CP_TRANSPORT_SOURCES "${CP_TRANSPORT_LIB}" SOURCES)
    set(CP_TRANSPORT_PATCHED_SOURCES "")
    set(CP_TRANSPORT_REPLACED 0)
    foreach(CP_SOURCE IN LISTS CP_TRANSPORT_SOURCES)
        if(CP_SOURCE MATCHES "(^|/)transport_ssl\\.c$")
            list(APPEND CP_TRANSPORT_PATCHED_SOURCES "${CP_TRANSPORT_PATCH_DIR}/transport_ssl.c")
            math(EXPR CP_TRANSPORT_REPLACED "${CP_TRANSPORT_REPLACED}+1")
        else()
            list(APPEND CP_TRANSPORT_PATCHED_SOURCES "${CP_SOURCE}")
        endif()
    endforeach()
    if(NOT CP_TRANSPORT_REPLACED EQUAL 1)
        message(FATAL_ERROR "Expected exactly one SDK TLS transport translation unit; found ${CP_TRANSPORT_REPLACED}")
    endif()
    set_property(TARGET "${CP_TRANSPORT_LIB}" PROPERTY SOURCES "${CP_TRANSPORT_PATCHED_SOURCES}")
    message(STATUS "CampusPulse: pinned async TLS error and read-retry repair enabled")
endif()
