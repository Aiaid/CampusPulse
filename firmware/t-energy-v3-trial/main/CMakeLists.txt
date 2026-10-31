idf_component_register(
    SRCS "small_runtime.c" "trial_bootstrap.c" "board_admission.c" "board_settings.c" "board_report.c" "board_resources.c" "board_resources_esp.c" "board_stats_worker.c" "board_stats_window.c" "board_capture.c" "board_handoff.c" "board_window_freeze.c" "board_handoff_capture_check.c" "board_shared_capture.c" "board_small_queue.c" "board_capabilities.c" "board_runtime.c" "board_runtime_adapters.c" "board_coordinator.c" "board_budget.c"
         "../flash_queue/flash_queue.c" "../flash_queue/nvs_store/nvs_store.c"
         "../flash_queue/write_budget/write_budget.c" "../identity/identity.c" "../history/local_guard.c"
    INCLUDE_DIRS "." "../../components/cp_v3_stats/include" "../../components/cp_v3_capture/include" "../../components/cp_v3_temporal/include" "../flash_queue" "../flash_queue/nvs_store" "../flash_queue/write_budget" "../identity" "../history"
    REQUIRES cp_v3_capture cp_v3_budget cp_v3_small_results cp_v3_stats cp_v3_temporal cp_settings cp_v3_evidence cp_v3_control cp_v3_queue cp_v3_transport
             bt nvs_flash json bootloader_support esp_timer esp_psram esp_partition mbedtls)
