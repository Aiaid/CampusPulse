idf_component_register(SRCS "cp_provision.c" "cp_provision_guard.c" INCLUDE_DIRS "include"
    REQUIRES cp_settings cp_network json esp_timer mbedtls esp_app_format)
