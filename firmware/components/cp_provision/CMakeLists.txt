idf_component_register(SRCS "cp_provision.c" "cp_provision_guard.c" INCLUDE_DIRS "include"
    REQUIRES cp_settings protocomm esp_wifi esp_netif esp_event esp_http_server
    json esp_timer mbedtls bt)
