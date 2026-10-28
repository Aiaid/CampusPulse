idf_component_register(SRCS "main.c" "saved_wifi.c" "probe_wire.c"
    INCLUDE_DIRS "${CMAKE_CURRENT_BINARY_DIR}" "."
    REQUIRES cp_settings esp_wifi esp_event esp_netif esp_http_client esp_websocket_client
    esp_timer heap mbedtls json wpa_supplicant nvs_flash esp_partition lwip)
if(CMAKE_BUILD_EARLY_EXPANSION)
    return()
endif()
if(NOT CP_LINK_CONFIG_FILE OR NOT IS_ABSOLUTE "${CP_LINK_CONFIG_FILE}")
    message(FATAL_ERROR "Supply absolute external CP_LINK_CONFIG_FILE; never credentials as -D")
endif()
find_program(CP_LINK_NODE node REQUIRED)
execute_process(COMMAND "${CP_LINK_NODE}" "${CMAKE_CURRENT_LIST_DIR}/../tools/configure.mjs"
    "${CP_LINK_CONFIG_FILE}" "${CMAKE_CURRENT_BINARY_DIR}/link_config.h"
    RESULT_VARIABLE config_result OUTPUT_QUIET ERROR_QUIET)
if(NOT config_result EQUAL 0)
    message(FATAL_ERROR "Private link configuration rejected; check schema, external path, permissions and epoch")
endif()
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${CP_LINK_CONFIG_FILE}")
