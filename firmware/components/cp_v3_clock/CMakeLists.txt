idf_component_register(SRCS "verify.c" "bootstrap.c" INCLUDE_DIRS "include"
    REQUIRES cp_settings cp_v3_evidence esp_common
    PRIV_REQUIRES json esp_wifi esp_netif esp_event esp_timer esp_http_client
        esp-tls mbedtls lwip)
