#include <inttypes.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include "cp_v3_stats.h"
#include "cp_v3_temporal.h"
#include "esp_flash.h"
#include "esp_heap_caps.h"
#include "esp_partition.h"
#include "esp_psram.h"

static void heap_report(const char *phase, uint32_t caps) {
    printf("%s total=%zu free=%zu minimum=%zu largest=%zu\n", phase,
        heap_caps_get_total_size(caps), heap_caps_get_free_size(caps),
        heap_caps_get_minimum_free_size(caps), heap_caps_get_largest_free_block(caps));
}
static void report(const char *phase) {
    puts(phase);
    heap_report("internal", MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    heap_report("external", MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
}
/* No reports are submitted, so this callback must never be called. */
static bool no_entropy(void *ctx, uint8_t id[16]) { (void)ctx; (void)id; return false; }
void app_main(void) {
    uint32_t flash = 0;
    esp_err_t err = esp_flash_get_size(NULL, &flash);
    printf("probe=memory-only flash_size_status=%d flash_bytes=%" PRIu32 " psram_bytes=%zu\n",
        (int)err, flash, esp_psram_get_size());
    const esp_partition_t *nvs = esp_partition_find_first(ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_DATA_NVS, "nvs");
    if (nvs) printf("nvs_partition_bytes=%" PRIu32 " nvs_free=unavailable\n", nvs->size);
    else puts("nvs_partition=unavailable nvs_free=unavailable");
    report("before");
    cp_v3_temporal_config_t cfg = cp_v3_temporal_default_config();
    cfg.max_tracks = 512; cfg.history_ms = 600000; cfg.slice_ms = 2000;
    cfg.max_open_events = 64; cfg.max_terminal_events = 64;
    cp_v3_temporal_memory_t layout = {0};
    bool layout_ok = cp_v3_temporal_memory_layout(&cfg, &layout);
    size_t stats_bytes = cp_v3_stats_memory_bytes(512);
    printf("layout_ok=%d stats=%zu temporal=%zu tracks=%zu slices=%zu history=%zu open=%zu terminal=%zu history_slices=%u cell_bytes=%u\n",
        layout_ok, stats_bytes, layout.total_bytes, layout.tracks_bytes, layout.slices_bytes,
        layout.history_bytes, layout.active_events_bytes, layout.terminal_events_bytes,
        layout.history_slices, layout.cell_bytes);
    void *stats_mem = stats_bytes ? heap_caps_aligned_alloc(cp_v3_stats_memory_alignment(), stats_bytes, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT) : NULL;
    void *temporal_mem = layout_ok ? heap_caps_aligned_alloc(cp_v3_temporal_memory_alignment(), layout.total_bytes, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT) : NULL;
    cp_v3_stats_config_t sc = {.capacity=512, .window_ms=60000, .bin_ms=5000, .rules_version=CP_V3_STATS_RULESET};
    cp_v3_stats_t *stats = stats_mem ? cp_v3_stats_init(stats_mem, stats_bytes, &sc) : NULL;
    cp_v3_temporal_t *temporal = NULL;
    cp_v3_temporal_context_t context = {.boot_generation=1, .config_generation=1, .placement_generation=1};
    cp_v3_temporal_time_t now = {0};
    cp_v3_temporal_result_t init = temporal_mem ? cp_v3_temporal_init(temporal_mem, layout.total_bytes, &cfg, &context, now, no_entropy, NULL, &temporal) : CP_V3_TEMPORAL_NO_MEMORY;
    printf("stats_alloc=%d stats_init=%d temporal_alloc=%d temporal_init=%d\n", stats_mem != NULL, stats != NULL, temporal_mem != NULL, (int)init);
    report("allocated");
    if (temporal) cp_v3_temporal_clear(temporal);
    free(temporal_mem); free(stats_mem);
    report("released");
    puts("probe_complete no_observations no_network nvs_free_unavailable");
}
