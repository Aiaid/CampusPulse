#pragma once
#include "cp_v3_budget.h"
#include "cp_v3_budget_nvs.h"
#include "cp_v3_control.h"

#define TE_BUDGET_STORAGE_NAMESPACE "te_v3_storage"
#define TE_BUDGET_UPLINK_NAMESPACE "te_v3_uplink"
typedef enum { TE_BUDGET_STORAGE, TE_BUDGET_UPLINK } te_board_budget_domain_t;
typedef enum {
    TE_BOARD_BUDGET_OK=CP_V3_BUDGET_OK,
    TE_BOARD_BUDGET_INVALID=CP_V3_BUDGET_INVALID,
    TE_BOARD_BUDGET_IO=CP_V3_BUDGET_IO,
    TE_BOARD_BUDGET_CORRUPT=CP_V3_BUDGET_CORRUPT,
    TE_BOARD_BUDGET_OWNER_MISMATCH=CP_V3_BUDGET_OWNER_MISMATCH,
    TE_BOARD_BUDGET_NOT_READY=CP_V3_BUDGET_NOT_READY,
    TE_BOARD_BUDGET_LIMIT=CP_V3_BUDGET_LIMIT,
    TE_BOARD_BUDGET_CLOCK_UNKNOWN=CP_V3_BUDGET_CLOCK_UNKNOWN,
    TE_BOARD_BUDGET_DAY_AMBIGUOUS=CP_V3_BUDGET_DAY_AMBIGUOUS,
    TE_BOARD_BUDGET_DAY_REGRESSION=CP_V3_BUDGET_DAY_REGRESSION,
    TE_BOARD_BUDGET_LATCHED=CP_V3_BUDGET_LATCHED,
    TE_BOARD_BUDGET_EXHAUSTED=CP_V3_BUDGET_EXHAUSTED,
    TE_BOARD_BUDGET_BUSY=100, TE_BOARD_BUDGET_STATE, TE_BOARD_BUDGET_HASH,
    TE_BOARD_BUDGET_NVS, TE_BOARD_BUDGET_AUTHORIZATION, TE_BOARD_BUDGET_TIME_REGRESSION
} te_board_budget_result_t;
typedef enum { TE_BUDGET_NEW, TE_BUDGET_OPENING, TE_BUDGET_OPEN,
    TE_BUDGET_CONFIGURED, TE_BUDGET_FAILED } te_board_budget_state_t;
typedef struct {
    cp_v3_sha256_fn sha256;
    void *hash_context;
    bool (*try_lock)(void *); /* One nonblocking mutex for ALL writers to NVS. */
    void (*unlock)(void *);
    void *lock_context;
    bool (*trusted_utc)(void *,uint64_t *lower_ms,uint64_t *upper_ms);
    void *clock_context;
} te_board_budget_config_t;
/* Explicit local trial authorization, never a built-in/prepolicy default.
 * The owner must obtain actual acceptance before constructing this value.
 * It authorizes only local trial budget expenditure, not collection/upload
 * content. Once policy-bound it cannot be reapplied, even with smaller limits. */
#define TE_BUDGET_EXPLICIT_LOCAL_TEST UINT32_C(0x54454c31)
typedef struct {
    uint32_t authorization;
    char node_id[65];
    uint64_t storage_limit, uplink_limit, storage_quantum, uplink_quantum;
} te_board_budget_local_test_t;
typedef struct {
    te_board_budget_state_t state;
    te_board_budget_config_t config;
    char node_id[65], policy_hash[65];
    uint64_t policy_generation, trusted_lower_ms;
    bool lock_held, have_clock, local_test_bound, policy_bound;
    cp_v3_budget_t storage, uplink;
    cp_v3_budget_nvs_t storage_nvs, uplink_nvs;
    cp_v3_budget_store_t storage_backend, uplink_backend;
    cp_v3_budget_result_t last_core_result;
    esp_err_t last_nvs_error; /* Last provider-open error; stores expose bool only. */
} te_board_budget_t;

/* One zero-initialized, boot-lifetime owner; do not memcpy/reset/reinitialize a
 * live or failed owner. A fresh boot object reopens exact persisted reservations
 * and burns all unused RAM credit. open is read-only and never initializes,
 * formats/erases NVS, creates a namespace, or changes a partition table.
 * Namespace identity and SHA-256("campuspulse/3\\0t-energy-budget/1\\0" +
 * domain + "\\0" + node) stay stable across boot and policy changes.
 * Hash failure, partial open, corrupt/foreign state latch this owner closed. */
te_board_budget_result_t te_board_budget_open(te_board_budget_t *,const char *node,
    const te_board_budget_config_t *);
te_board_budget_result_t te_board_budget_accept_local_test(te_board_budget_t *,
    const te_board_budget_local_test_t *);
/* Only a real shared-control-validated offered/applied policy may be supplied.
 * Limits only tighten within this owner; policy binding never resets usage or
 * raises an accepted local cap. A subsequent local-test binding is prohibited.
 * Before this or explicit local acceptance, both core budgets are unconfigured. */
te_board_budget_result_t te_board_budget_bind_policy(te_board_budget_t *,const cp_v3_control_t *);
te_board_budget_result_t te_board_budget_charge(te_board_budget_t *,te_board_budget_domain_t,uint64_t bytes);
/* Integration callbacks for small_queue/runtime's existing raw core APIs.
 * Callers must use these callbacks with this owner, pass trusted UTC to the
 * shared charge, and hold the lock across charge + protected NVS mutation.
 * Never use the raw providers or change core limits outside this adapter.
 * Uplink checkpoint writes are also charged to storage before NVS mutation.
 * The two checkpoints are individually committed, not a cross-domain atomic
 * transaction: interruption can burn extra storage reservation, never return
 * an uplink allowance before its own committed readback. Reboot recovers no
 * unused RAM credit. Same-day historical clock rollback cannot be reconstructed
 * after reboot, but cannot reset the persisted day reservation either.
 * The shared uplink core additionally charges its conservative metadata cost
 * to uplink; this overcounts network bytes, never undercounts the local limit. */
bool te_board_budget_try_lock(void *);
void te_board_budget_unlock(void *);
/* Logical reservation accounting only: not NVS physical endurance, GC/wear,
 * power-loss acceptance, or protection against externally erased storage.
 * Reviewed storage API:
 * https://docs.espressif.com/projects/esp-idf/en/v5.5.3/esp32s3/api-reference/storage/nvs_flash.html
 */
