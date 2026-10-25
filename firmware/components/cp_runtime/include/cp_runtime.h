#pragma once
#include "cp_core.h"
#include "cp_network.h"
#include "cp_pipeline.h"
#include "cp_provision.h"
typedef struct {
    cp_network_snapshot_t network;
    cp_pipeline_snapshot_t pipeline;
    cp_provision_snapshot_t provision;
    cp_collection_state_t collection;
    bool enrolled,testing_candidate,prepared;
    char reason[80];
} cp_runtime_snapshot_t;
/* Early boot, before ADC or RF: NVS/proof/boot entropy and journal recovery. */
esp_err_t cp_runtime_prepare(const char *node,const cp_board_profile_t *profile);
esp_err_t cp_runtime_start(void);
/* Queue-only entry points, safe for supervisor input processing. */
bool cp_runtime_request_setup(cp_provision_mode_t mode);
bool cp_runtime_request_resume(void);
void cp_runtime_snapshot(cp_runtime_snapshot_t *out);
