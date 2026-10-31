#pragma once
#include <stdbool.h>
#include <stddef.h>

/* Total fixed report-pool size. No allocation is attempted on overflow. */
bool te_v3_report_pool_bytes(size_t slots, size_t slot_bytes, size_t *bytes);
/* Deliberately closed until the shared statistics schema, admission policy,
 * and a compatible durable queue are integrated and validated together. */
bool te_v3_runtime_ready(void);
/* Allocator and placement predicate must be task-safe. A failed placement check
 * is freed immediately; the caller owns the returned pool on success. */
typedef void *(*te_v3_pool_alloc_t)(size_t bytes, void *context);
typedef bool (*te_v3_pool_external_t)(const void *pool, void *context);
typedef void (*te_v3_pool_free_t)(void *pool, void *context);
void *te_v3_pool_acquire(size_t slots, size_t slot_bytes, te_v3_pool_alloc_t alloc,
                         te_v3_pool_external_t external, te_v3_pool_free_t release,
                         void *context);
/* Allocate three independent PSRAM regions as one transaction. The caller
 * supplies actual core-reported sizes; reserve is budgeted from a free-memory
 * snapshot, not guaranteed against allocation overhead or concurrent work.
 * No partial ownership escapes on any failure. */
typedef struct { void *reports, *stats, *temporal; } te_v3_pools_t;
bool te_v3_pools_acquire(te_v3_pools_t *out, size_t report_bytes, size_t stats_bytes,
    size_t temporal_bytes, size_t free_external, size_t reserve,
    te_v3_pool_alloc_t alloc, te_v3_pool_external_t external,
    te_v3_pool_free_t release, void *context);
void te_v3_pools_release(te_v3_pools_t *pools, te_v3_pool_free_t release, void *context);
