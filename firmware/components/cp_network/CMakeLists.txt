idf_component_register(SRCS "network.c" "protocol.c" "diagnostic.c" "diagnostic_store.c" INCLUDE_DIRS "include"
    REQUIRES cp_core cp_settings
    PRIV_REQUIRES esp_wifi esp_netif esp_event esp_timer esp_http_client mbedtls json nvs_flash lwip wpa_supplicant esp-tls)
