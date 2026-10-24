# Call after project(): all IDF component targets then exist. Never edits the SDK.
if(CONFIG_ESP_PROTOCOMM_SUPPORT_SECURITY_VERSION_2)
    set(CP_SECURITY2_PATCH_DIR "${CMAKE_BINARY_DIR}/campuspulse-security2-patch")
    find_program(CP_PATCH_UV NAMES uv REQUIRED)
    execute_process(
        COMMAND "${CP_PATCH_UV}" --cache-dir "${CMAKE_BINARY_DIR}/.uv-cache" run --no-project
                "${CMAKE_CURRENT_LIST_DIR}/patch_security2.py"
                --idf-path "$ENV{IDF_PATH}" --output "${CP_SECURITY2_PATCH_DIR}"
        RESULT_VARIABLE CP_PATCH_RESULT
        OUTPUT_VARIABLE CP_PATCH_OUTPUT
        ERROR_VARIABLE CP_PATCH_ERROR)
    if(NOT CP_PATCH_RESULT EQUAL 0)
        message(FATAL_ERROR "Cannot apply pinned Security2 alignment repair: ${CP_PATCH_ERROR}")
    endif()
    idf_component_get_property(CP_PROTOCOMM_LIB protocomm COMPONENT_LIB)
    get_target_property(CP_PROTOCOMM_SOURCES "${CP_PROTOCOMM_LIB}" SOURCES)
    set(CP_PROTOCOMM_PATCHED_SOURCES "")
    set(CP_SECURITY2_REPLACED 0)
    foreach(CP_SOURCE IN LISTS CP_PROTOCOMM_SOURCES)
        if(CP_SOURCE MATCHES "(^|/)src/security/security2\\.c$")
            list(APPEND CP_PROTOCOMM_PATCHED_SOURCES "${CP_SECURITY2_PATCH_DIR}/security2_checked.c")
            math(EXPR CP_SECURITY2_REPLACED "${CP_SECURITY2_REPLACED}+1")
        else()
            list(APPEND CP_PROTOCOMM_PATCHED_SOURCES "${CP_SOURCE}")
        endif()
    endforeach()
    if(NOT CP_SECURITY2_REPLACED EQUAL 1)
        message(FATAL_ERROR "Expected exactly one SDK Security2 translation unit; found ${CP_SECURITY2_REPLACED}")
    endif()
    set_property(TARGET "${CP_PROTOCOMM_LIB}" PROPERTY SOURCES "${CP_PROTOCOMM_PATCHED_SOURCES}")
    message(STATUS "CampusPulse: pinned Security2 IV alignment repair enabled (12-byte wire nonce unchanged)")
endif()
