idf_component_register(SRCS "runtime.c" INCLUDE_DIRS "include"
    REQUIRES cp_core cp_network cp_settings cp_provision cp_pipeline
    PRIV_REQUIRES esp_timer esp_hw_support bootloader_support)
