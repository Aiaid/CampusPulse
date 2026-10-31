#define main capability_test_main
#include "test_board_capabilities.c"
#undef main
static te_v3_capability_evidence_t evidence;
static cp_v3_temporal_config_t temporal_fixture;
void control_capability_fixture(te_v3_capability_request_t *r) {
    temporal_fixture=cp_v3_temporal_default_config();
    evidence=(te_v3_capability_evidence_t){.measured_at_utc_ms=ISSUED,.valid_until_utc_ms=ISSUED+3600000,
        .external=external,.arenas_initialized_verified=true,.report_slots=16,
        .psram_free_bytes=4194304,.psram_headroom_bytes=524288,.internal_free_bytes=262144,.internal_headroom_bytes=131072,
        .storage_write_budget_bytes_per_day=1048576,.cpu_profile_verified=true,.scanner_profile_verified=true,
        .measured_cpu_us_per_window=100000,.cpu_budget_us_per_window=1000000,.queue_recovery_verified=true,
        .queue_power_loss_verified=true,.queue_budget_is_not_physical_reservation=true,.free_queue_slots=3,
        .queue_body_budget_bytes=3072,.queue_item_budget=3,.available_nvs_entries=332,.working_budget_bytes=4194304};
    evidence.allocated.reports=evidence.report_slots*sizeof(te_v3_report_t);
    evidence.allocated.stats=cp_v3_stats_memory_bytes(512);
    evidence.allocated.temporal=cp_v3_temporal_memory_bytes(&temporal_fixture);
    evidence.pools.reports=calloc(1,evidence.allocated.reports); evidence.pools.stats=malloc(evidence.allocated.stats);
    evidence.pools.temporal=malloc(evidence.allocated.temporal); assert(evidence.pools.reports&&evidence.pools.stats&&evidence.pools.temporal);
    evidence.external_context=&evidence.pools;
    cp_v3_stats_config_t stats={.capacity=512,.window_ms=60000,.bin_ms=5000,.rules_version="unclassified-v1"};
    assert(cp_v3_stats_init(evidence.pools.stats,evidence.allocated.stats,&stats));
    cp_v3_temporal_t *local; const cp_v3_temporal_context_t context={1,1,1};
    cp_v3_temporal_time_t time={.mono_ms=60000,.utc_ms=ISSUED+60000,.clock_epoch=1,.uncertainty_ms=10,.utc_known=true};
    assert(cp_v3_temporal_init(evidence.pools.temporal,evidence.allocated.temporal,&temporal_fixture,&context,time,entropy,NULL,&local)==CP_V3_TEMPORAL_OK);
    *r=(te_v3_capability_request_t){.node_id="synthetic-te-notregister",.capability_id="synthetic-te-caps",
      .boot_id="11111111-1111-4111-8111-111111111111",.issued_at_utc_ms=ISSUED,.expires_at_utc_ms=ISSUED+3600000,
      .max_addresses=512,.max_bins=12,.max_window_ms=60000,.min_scan_interval_units=4,.max_scan_interval_units=16384,
      .temporal=&temporal_fixture,.evidence=&evidence};
}
const char *control_offer_fixture(void) { return backend_response; }
void control_capability_fixture_free(void) { free(evidence.pools.reports);free(evidence.pools.stats);free(evidence.pools.temporal); }
