idf_component_register(SRCS "pipeline.c" "scheduler.c" "memory_guard.c" "codec.c" "codec_status.c" "domain_debug.c" INCLUDE_DIRS "include"
    REQUIRES cp_network cp_collect cp_journal cp_perf bt json esp_partition esp_timer
    PRIV_REQUIRES nvs_flash esp_hw_support)
