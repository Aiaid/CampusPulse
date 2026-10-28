idf_component_register(SRCS "perf_profile.c" INCLUDE_DIRS "include"
    REQUIRES esp_timer PRIV_REQUIRES freertos heap)
