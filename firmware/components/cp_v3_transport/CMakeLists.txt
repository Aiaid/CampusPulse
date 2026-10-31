idf_component_register(SRCS "transport.c" "protocol.c" "mqtt_native.c" INCLUDE_DIRS "include"
    PRIV_INCLUDE_DIRS "../cp_network"
    REQUIRES cp_settings cp_v3_evidence esp_common
    PRIV_REQUIRES esp_wifi esp_netif esp_event esp_timer esp-tls mbedtls
                  lwip wpa_supplicant http_parser mqtt tcp_transport)
target_link_libraries(${COMPONENT_LIB} INTERFACE "-Wl,--wrap=esp_transport_read" "-Wl,--wrap=esp_transport_write")
