/* Reuse deterministic IO boundaries, but exercise the actual S3 PSRAM branch. */
#define main baseline_pipeline_main
#include "test_pipeline_memory.c"
#undef main

typedef struct { void *pointer; size_t bytes; bool external, upload; } psram_block_t;
static psram_block_t psram_blocks[8];
static unsigned psram_live, psram_calls, psram_frees;
static bool psram_fail, psram_wrong_placement, psram_upload_phase;

void *heap_caps_malloc(size_t bytes, uint32_t caps) {
    assert(caps == (MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
    assert(memory_owned && !http_active && !store_owned && !capture_depth);
    if (!psram_upload_phase) assert(!s_initialized && !persistence_pending());
    ++psram_calls;
    if (psram_fail) return NULL;
    void *p = malloc(bytes); assert(p);
    for (unsigned i = 0; i < 8; ++i) if (!psram_blocks[i].pointer) {
        psram_blocks[i] = (psram_block_t){p, bytes, !psram_wrong_placement, psram_upload_phase};
        ++psram_live;
        if (psram_upload_phase) ++upload_live;
        return p;
    }
    abort();
}
void heap_caps_free(void *p) {
    if (!p) return;
    for (unsigned i = 0; i < 8; ++i) if (psram_blocks[i].pointer == p) {
        if (psram_blocks[i].upload) { assert(upload_live); --upload_live; }
        memset(&psram_blocks[i], 0, sizeof psram_blocks[i]);
        assert(psram_live); --psram_live; ++psram_frees; free(p); return;
    }
    abort();
}
bool esp_ptr_external_ram(const void *p) {
    uintptr_t address = (uintptr_t)p;
    for (unsigned i = 0; i < 8; ++i) {
        uintptr_t start = (uintptr_t)psram_blocks[i].pointer;
        if (start && address >= start && address - start < psram_blocks[i].bytes)
            return psram_blocks[i].external;
    }
    return false;
}
static size_t owner_bytes(void) {
    for (unsigned i = 0; i < 8; ++i)
        if (psram_blocks[i].pointer == s_collect_bank_owner) return psram_blocks[i].bytes;
    return 0;
}
static void test_psram_resize_swap_oom_and_stop(void) {
    reset();
    assert(psram_live == 1 && !seal_live);
    s_policy.max_addresses = 512;
    s_policy.summary_window_ms = 120000;
    s_policy.summary_bin_ms = 10000;
    s_policy.max_items = 64;
    s_policy.raw_enabled = false;
    memory_owned = true;
    assert(reserve_seal_bank(512, 12));
    memory_owned = false;
    assert(owner_bytes() == 2 * 512 * (sizeof(cp_address_core_t) + 12 * sizeof(uint32_t)));
    assert(psram_live == 1 && esp_ptr_external_ram(s_window.addresses) &&
           esp_ptr_external_ram(s_sealed.addresses) && esp_ptr_external_ram(s_window.bins) &&
           esp_ptr_external_ram(s_sealed.bins));
    assert(cp_collect_compact_begin(&s_window, 1000, 120000, 10000, 1, 512, false));
    for (unsigned bin = 0; bin < 12; ++bin) for (unsigned i = 0; i < 512; ++i) {
        cp_report_t r = {.mono_ms = 1001 + bin * 10000 + i, .report_seq = bin * 512 + i + 1,
            .address = {2,0,0,0,(uint8_t)(i >> 8),(uint8_t)i}, .raw = CP_RAW_OFF, .rssi = -50};
        assert(cp_collect_compact_observe(&s_window, &r));
    }
    assert(s_window.address_count == 512 && s_window.reports_seen == 6144);
    cp_address_core_t *active = s_window.addresses;
    unsigned allocated = psram_calls;
    close_window(120000);
    assert(next_window() && s_sealed.window.cores == active && s_window.addresses != active);
    assert(s_sealed.window.address_count == 512 && s_sealed.window.bins[511 * 12 + 11] == 1);
    assert(persist_pending(0));
    assert(s_health.summaries_committed == 512 && s_health.windows_committed == 1 &&
           !s_health.summary_drops && !s_health.windows_dropped && !s_health.seal_overflows);
    unsigned batches = cp_journal_pending(&s_journal);
    printf("PSRAM 512/120s/10s: core_bytes=%zu bin_bytes=%zu frozen_batches=%u\n",
        2 * 512 * sizeof(cp_address_core_t), 2 * 512 * 12 * sizeof(uint32_t), batches);
    assert(batches > 1 && psram_calls == allocated);
    void *owner = s_collect_bank_owner;
    cp_address_core_t *old_active = s_window.addresses, *old_sealed = s_sealed.addresses;
    uint32_t *old_active_bins = s_window.bins, *old_sealed_bins = s_sealed.bins;
    cp_address_core_t saved_core = old_sealed[511];
    unsigned calls = psram_calls;
    memory_owned = true;
    assert(reserve_seal_bank(512, 12) && psram_calls == calls); /* swapped-bank reuse */
    psram_fail = true;
    assert(!reserve_seal_bank(512, 16));
    psram_fail = false; psram_wrong_placement = true;
    assert(!reserve_seal_bank(512, 16));
    psram_wrong_placement = false;
    assert(psram_live == 1 && owner == s_collect_bank_owner && old_active == s_window.addresses &&
           old_sealed == s_sealed.addresses && old_active_bins == s_window.bins &&
           old_sealed_bins == s_sealed.bins && !memcmp(&saved_core, &old_sealed[511], sizeof saved_core));
    assert(reserve_seal_bank(512, 16) && psram_live == 1 && s_collect_bank_owner != owner);
    memory_owned = false;
    s_accept = false; s_initialized = true; s_capture_started = false;
    assert(cp_pipeline_stop() == ESP_OK && !psram_live && !s_collect_bank_owner &&
           !s_window.addresses && !s_sealed.addresses);
}
static void test_psram_upload_read_and_failure(void) {
    reset();
    observe(1); close_window(30000); assert(next_window()); assert(persist_pending(0));
    unsigned slot = 0; assert(s_journal.slots[slot].state == CP_SLOT_PENDING);
    size_t length;
    psram_upload_phase = true;
    unsigned char *body = read_upload_body((uint16_t)slot, &length);
    assert(body && length == s_journal.slots[slot].length && esp_ptr_external_ram(body));
    assert(psram_live == 2 && upload_live == 1 && !memory_owned && !store_owned);
    release_upload_body(body); assert(psram_live == 1 && !upload_live);
    psram_fail = true; assert(!read_upload_body((uint16_t)slot, &length)); psram_fail = false;
    psram_wrong_placement = true; assert(!read_upload_body((uint16_t)slot, &length));
    psram_wrong_placement = false; psram_upload_phase = false;
    assert(psram_live == 1 && !upload_live && s_journal.slots[slot].state == CP_SLOT_PENDING);
    release_seal_bank(); assert(!psram_live);
}
static void test_psram_start_and_failed_stop_retention(void) {
    reset(); release_seal_bank();
    memory_owned = true; psram_fail = true;
    assert(!reserve_seal_bank(512, 12) && !s_collect_bank_owner && !psram_live);
    psram_fail = false; memory_owned = false;
    for (unsigned failure = 0; failure < 3; ++failure) {
        reset();
        void *owner = s_collect_bank_owner;
        cp_address_core_t *bank = s_sealed.addresses;
        s_initialized = true;
        s_worker = failure == 0 ? &worker_task : NULL;
        stop_join_times_out = failure == 0;
        apply_startup_test = true;
        s_host = failure == 1 ? &host_task_handle : NULL;
        host_stop_fails = failure == 1;
        host_deinit_fails = failure == 2;
        unsigned frees = psram_frees, calls = psram_calls;
        assert(cp_pipeline_stop() != ESP_OK);
        assert(s_stop_failed && s_initialized && psram_live == 1 &&
               s_collect_bank_owner == owner && s_sealed.addresses == bank && psram_frees == frees);
        assert(cp_pipeline_stop() == ESP_ERR_INVALID_STATE);
        memory_owned = true; assert(!reserve_seal_bank(512, 12)); memory_owned = false;
        assert(psram_calls == calls && s_collect_bank_owner == owner);
    }
    /* Simulate teardown at process reset only, after failed ownership was tested. */
    s_initialized = false; release_seal_bank(); assert(!psram_live);
}
int main(void) {
    /* Baseline allocator functions belong to the included regression harness. */
    (void)upload_alloc; (void)upload_free; (void)seal_alloc; (void)seal_free;
    _Static_assert(CP_COLLECT_ADDRESSES == 512, "PSRAM trial must exercise 512 addresses");
    cJSON_Hooks hooks = {.malloc_fn = checked_malloc, .free_fn = checked_free};
    cJSON_InitHooks(&hooks);
    test_psram_resize_swap_oom_and_stop();
    test_psram_upload_read_and_failure();
    test_psram_start_and_failed_stop_retention();
    assert_released(); assert(!psram_live && psram_calls && psram_frees);
    cJSON_InitHooks(NULL);
    puts("PSRAM pipeline: placement/no-fallback, 512-address swaps, transactional OOM, reuse, stop and frozen read passed");
    return 0;
}
