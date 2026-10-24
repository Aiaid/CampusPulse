#include "cJSON.h"
#include "cp_codec.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
static unsigned ids;
static const char *output_directory;
static void uuid(char out[37]) { snprintf(out, 37, "22222222-2222-4222-8222-%012u", ++ids); }
static bool sink(void *ctx, const char *body, size_t len, const char *stream, unsigned count,
                 bool control) {
    (void)ctx;
    (void)count;
    (void)control;
    char p[256];
    const char *file = !strcmp(stream, "ble_windows")         ? "ble-windows-v2.request.json"
                       : !strcmp(stream, "address_summaries") ? "address-summaries-v2.request.json"
                                                              : "node-status-v2.request.json";
    int path_length = snprintf(p, sizeof p, "%s/%s", output_directory, file);
    assert(path_length > 0 && (size_t)path_length < sizeof p);
    FILE *f = fopen(p, "wb");
    assert(f);
    assert(fwrite(body, 1, len, f) == len);
    assert(fclose(f) == 0);
    cJSON *j = cJSON_ParseWithLength(body, len);
    assert(j);
    cJSON_Delete(j);
    return true;
}
int main(int argc, char **argv) {
    if (argc != 2) {
        fprintf(stderr, "Usage: %s EXISTING_OUTPUT_DIRECTORY\n", argv[0]);
        return 2;
    }
    output_directory = argv[1];
    cp_collect_t *w = malloc(sizeof *w);
    assert(w && cp_collect_begin(w, 1000, 30000, 5000, 1, 64, false));
    cp_report_t r = {.mono_ms = 1001,
                     .report_seq = 1,
                     .address = {2, 0, 0, 0, 0, 1},
                     .address_type = 0,
                     .rssi = -50};
    for (unsigned i = 0; i < 12; i++) {
        r.report_seq = i + 1;
        r.mono_ms = 1001 + i * 2000;
        r.address[5] = (i % 3) + 1;
        assert(cp_collect_observe(w, &r));
    }
    uint32_t seq = 0;
    cp_codec_t c = {.node_id = "cp_020000000001",
                    .boot_id = "11111111-1111-4111-8111-111111111111",
                    .placement_id = "fixture-placement-v2",
                    .config_id = "fixture-config-v2",
                    .dataset = "demo",
                    .firmware_version = "campuspulse-passport-v2",
                    .max_items = 16,
                    .max_body_bytes = 8192,
                    .uncertainty_ms = UINT32_MAX,
                    .summary_sequence = &seq,
                    .uuid = uuid,
                    .sink = sink};
    assert(cp_codec_window(&c, w, 30000) && c.windows_committed == 1 && c.summaries_committed == 3);
    cp_codec_status_t status = {.mono_ms = 31001,
                                .collecting = true,
                                .connected = true,
                                .free_heap = 100000,
                                .slots = 341,
                                .free_slots = 339,
                                .queue_pending = {1, 1, 0, 0},
                                .warn_pct = 60,
                                .raw_pause_pct = 80,
                                .critical_pct = 95};
    assert(cp_codec_status(&c, &status, 1));
    free(w);
    puts("Actual firmware codec window/summary/status fixtures: PASS");
    return 0;
}
