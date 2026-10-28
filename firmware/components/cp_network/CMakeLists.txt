idf_component_register(SRCS "network.c" "mqtt_wss.c" "protocol.c" "diagnostic.c" "diagnostic_store.c" "alloc_monitor.c" INCLUDE_DIRS "include"
    REQUIRES cp_core cp_settings esp_app_format
    PRIV_REQUIRES esp_wifi esp_netif esp_event esp_timer esp_http_client mbedtls json nvs_flash lwip wpa_supplicant esp-tls heap mqtt tcp_transport)
if(CONFIG_CP_NETWORK_MQTT_WSS)
    target_link_libraries(${COMPONENT_LIB} INTERFACE
        "-Wl,--wrap=esp_transport_read" "-Wl,--wrap=esp_transport_write")
endif()
