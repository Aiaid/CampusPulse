idf_component_register(SRCS "capture.c" INCLUDE_DIRS "include"
    REQUIRES cp_v3_stats cp_v3_temporal cp_v3_evidence bt esp_timer esp_psram)
