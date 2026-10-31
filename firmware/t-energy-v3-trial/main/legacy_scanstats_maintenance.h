#pragma once
#include "nvs.h"
#include <stdbool.h>
#include <stddef.h>
/* The human authorization covers this one identified legacy cache only.
 * No caller-supplied namespace/key or general deletion API is exposed. */
#define TE_LEGACY_SCANSTATS_NAMESPACE "scanstats"
#define TE_LEGACY_SCANSTATS_KEY "devs"
#define TE_LEGACY_SCANSTATS_BYTES 12300u
typedef enum {
    TE_LEGACY_MAINT_CLEARED, TE_LEGACY_MAINT_ALREADY_ABSENT,
    TE_LEGACY_MAINT_REJECTED, TE_LEGACY_MAINT_UNCERTAIN
} te_legacy_maintenance_result_t;
typedef enum {
    TE_LEGACY_STAGE_INIT, TE_LEGACY_STAGE_STATS_BEFORE,
    TE_LEGACY_STAGE_READONLY_OPEN, TE_LEGACY_STAGE_READONLY_TYPE,
    TE_LEGACY_STAGE_READONLY_LENGTH, TE_LEGACY_STAGE_WRITE_OPEN,
    TE_LEGACY_STAGE_WRITE_TYPE, TE_LEGACY_STAGE_WRITE_LENGTH,
    TE_LEGACY_STAGE_ERASE_KEY, TE_LEGACY_STAGE_COMMIT,
    TE_LEGACY_STAGE_VERIFY_OPEN, TE_LEGACY_STAGE_VERIFY_ABSENT,
    TE_LEGACY_STAGE_STATS_AFTER, TE_LEGACY_STAGE_DONE
} te_legacy_maintenance_stage_t;
typedef struct {
    te_legacy_maintenance_result_t result;
    te_legacy_maintenance_stage_t stage;
    esp_err_t error;
    nvs_stats_t before,after;
    size_t blob_bytes;
    bool before_known,after_known,erase_attempted,commit_ok,absent_verified;
} te_legacy_maintenance_report_t;
/* Calls nvs_flash_init with no erase/reinitialization fallback. Reads only type
 * and length, never the cache contents. Rechecks the existing key after opening
 * it for writing. One erase_key and one commit at most; ambiguous failures are
 * retained as UNCERTAIN even if later reads report absence. Caller is the only
 * application NVS owner; no radio/queue/other subsystem may be running. */
te_legacy_maintenance_result_t te_legacy_scanstats_clear(te_legacy_maintenance_report_t *);
