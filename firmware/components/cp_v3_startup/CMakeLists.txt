idf_component_register(SRCS "profile.c" "startup_nvs.c" INCLUDE_DIRS "include"
    REQUIRES cp_settings PRIV_REQUIRES nvs_flash mbedtls)
