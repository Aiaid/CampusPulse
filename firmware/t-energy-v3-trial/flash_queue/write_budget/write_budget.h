#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#define TE_BUDGET_RECORD_SIZE 32u
/* load: 1 = record, 0 = absent, -1 = I/O/corrupt. save returns true only
 * when new record is durable; any uncertain result is false. See README for
 * required backend recovery/anti-rollback semantics. No actual backend supplied. */
typedef struct { void *context; int (*load)(void *, uint8_t [TE_BUDGET_RECORD_SIZE]); bool (*save)(void *, const uint8_t [TE_BUDGET_RECORD_SIZE]); } te_budget_store_t;
typedef struct { te_budget_store_t store; uint64_t last_utc; uint32_t used, limit; bool ready, blocked; } te_budget_t;
typedef enum { TE_BUDGET_OK, TE_BUDGET_INVALID, TE_BUDGET_ABSENT, TE_BUDGET_IO, TE_BUDGET_TIME, TE_BUDGET_EXHAUSTED, TE_BUDGET_CORRUPT } te_budget_result_t;
/* Explicitly provision only after backend ownership and empty state verified.
 * This persists a full record; a failed save must not be retried blindly. */
te_budget_result_t te_budget_provision(te_budget_t *,te_budget_store_t,uint32_t limit,bool time_known,uint64_t utc_seconds);
te_budget_result_t te_budget_open(te_budget_t *,te_budget_store_t,uint32_t expected_limit);
/* Reserve before each mutation. One reservation is consumed even if later work
 * fails. UTC must be externally trustworthy; rollback/unknown time rejects. */
te_budget_result_t te_budget_reserve(te_budget_t *,bool time_known,uint64_t utc_seconds,uint32_t units);
