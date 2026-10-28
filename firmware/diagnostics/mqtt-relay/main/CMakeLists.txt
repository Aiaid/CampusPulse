idf_component_register(SRCS "main.c" "saved_wifi.c" INCLUDE_DIRS "${CMAKE_CURRENT_BINARY_DIR}" "."
    REQUIRES cp_settings esp_wifi esp_event esp_netif mqtt esp_timer heap mbedtls json
    wpa_supplicant nvs_flash esp_partition)
if(CMAKE_BUILD_EARLY_EXPANSION)
    return()
endif()
if(NOT CP_MQTT_CONFIG_FILE OR NOT IS_ABSOLUTE "${CP_MQTT_CONFIG_FILE}")
    message(FATAL_ERROR "Supply absolute CP_MQTT_CONFIG_FILE outside the repository (never pass credentials as -D)")
endif()
find_program(CP_MQTT_NODE node REQUIRED)
execute_process(COMMAND "${CP_MQTT_NODE}" "${CMAKE_CURRENT_LIST_DIR}/../tools/configure.mjs"
    "${CP_MQTT_CONFIG_FILE}" "${CMAKE_CURRENT_BINARY_DIR}/mqtt_config.h"
    RESULT_VARIABLE config_result OUTPUT_QUIET ERROR_VARIABLE config_error)
if(NOT config_result EQUAL 0)
    message(FATAL_ERROR "Private MQTT configuration rejected: ${config_error}")
endif()
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${CP_MQTT_CONFIG_FILE}")
