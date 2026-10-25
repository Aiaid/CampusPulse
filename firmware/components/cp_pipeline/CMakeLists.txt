idf_component_register(SRCS "pipeline.c" "scheduler.c" "codec.c" "codec_status.c" INCLUDE_DIRS "include"
    REQUIRES cp_network cp_collect cp_journal bt json esp_partition esp_timer
    PRIV_REQUIRES nvs_flash esp_hw_support)
