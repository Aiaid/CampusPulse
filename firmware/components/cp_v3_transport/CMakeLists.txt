set(cp_v3_sources "transport.c" "protocol.c")
set(cp_v3_private_includes "")
if(CONFIG_CP_V3_NATIVE_MQTT)
    list(APPEND cp_v3_sources "mqtt_native.c")
    list(APPEND cp_v3_private_includes "../cp_network")
else()
    list(APPEND cp_v3_sources "mqtt_disabled.c")
endif()
idf_component_register(SRCS ${cp_v3_sources} INCLUDE_DIRS "include"
    PRIV_INCLUDE_DIRS ${cp_v3_private_includes}
    REQUIRES cp_settings cp_v3_evidence esp_common
    # IDF scans dependencies before Kconfig. These inert SDK libraries are
    # declared unconditionally; neither starts a network owner by registration.
    PRIV_REQUIRES esp_wifi esp_netif esp_event esp_timer esp-tls mbedtls
        lwip wpa_supplicant http_parser mqtt tcp_transport)
if(CONFIG_CP_V3_NATIVE_MQTT)
    idf_build_get_property(cp_v3_build_components BUILD_COMPONENTS)
    if("cp_network" IN_LIST cp_v3_build_components AND CONFIG_CP_NETWORK_MQTT_WSS)
        message(FATAL_ERROR "cp_network and cp_v3_transport cannot both own MQTT transport wrappers; disable CP_V3_NATIVE_MQTT for legacy V2 builds")
    endif()
    target_link_libraries(${COMPONENT_LIB} INTERFACE "-Wl,--wrap=esp_transport_read" "-Wl,--wrap=esp_transport_write")
endif()
