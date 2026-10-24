idf_component_register(SRCS "settings_validate.c" "settings_nvs.c"
    INCLUDE_DIRS "include" REQUIRES esp_common PRIV_REQUIRES nvs_flash esp_hw_support bootloader_support)
