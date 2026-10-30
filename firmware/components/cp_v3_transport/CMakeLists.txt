idf_component_register(SRCS "transport.c" "protocol.c" INCLUDE_DIRS "include"
    REQUIRES cp_settings cp_v3_evidence esp_common
    PRIV_REQUIRES esp_wifi esp_netif esp_event esp_timer esp-tls mbedtls
                  lwip wpa_supplicant http_parser)
