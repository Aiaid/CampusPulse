#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#define TE_HANDOFF_SNAPSHOT_MAX 4096u
#define TE_HANDOFF_BODY_MAX 8192u
#define TE_HANDOFF_IDENTITY_MAX 512u
#define TE_HANDOFF_HASH_BYTES 32u
/* One worker owns this object and callback lifetimes. Allocate outside the task
 * stack, preferably in verified PSRAM. Neither this object nor a peek is durable. */
typedef enum { TE_HANDOFF_EMPTY,TE_HANDOFF_STAGED,TE_HANDOFF_FROZEN,TE_HANDOFF_DURABLE,TE_HANDOFF_FAULT } te_handoff_state_t;
typedef enum { TE_PEEK_EMPTY,TE_PEEK_ITEM,TE_PEEK_ERROR } te_handoff_peek_result_t;
typedef enum { TE_STORE_DURABLE,TE_STORE_FULL,TE_STORE_ERROR } te_handoff_store_result_t;
typedef enum { TE_STEP_IDLE,TE_STEP_PROGRESS,TE_STEP_BACKPRESSURE,TE_STEP_FAULT } te_handoff_step_t;
typedef struct {
    bool (*admit)(void *);
    /* ITEM copies the current snapshot without releasing it; EMPTY has none.
     * ERROR is ambiguous and permanently stops this instance. */
    te_handoff_peek_result_t (*peek)(void *,void *dst,size_t cap,size_t *length);
    /* Must encode full immutable identity/scope, not pointers, in identity.
     * Production callback must validate actual body/record limits of the chosen
     * backend; these staging maxima are not an NVS capacity guarantee. */
    bool (*freeze)(void *,const void *snapshot,size_t snapshot_len,
        void *body,size_t body_cap,size_t *body_len,void *identity,size_t identity_cap,size_t *identity_len);
    /* Production binding must be SHA-256; test doubles are not cryptography. */
    bool (*hash)(void *,const void *,size_t,uint8_t out[TE_HANDOFF_HASH_BYTES]);
    /* DURABLE means committed and readback-verified exact bytes/identity, not
     * HTTP/MQTT ACK, a queued write, or mere acceptance by an API. ERROR may
     * be an uncertain commit: retries must reconcile exact bytes idempotently. */
    te_handoff_store_result_t (*store)(void *,const void *body,size_t body_len,
        const void *identity,size_t identity_len,const uint8_t body_hash[TE_HANDOFF_HASH_BYTES]);
    /* Exact release only after durable store. False never authorizes forgetting;
     * retries must be safe for that exact generation/identity and never release
     * a later item. Ambiguous outcomes require collector-side reconciliation. */
    bool (*release)(void *,const void *snapshot,size_t snapshot_len);
    void *context;
} te_handoff_ops_t;
typedef struct {
    te_handoff_state_t state;
    bool peek_uncertain;
    uint64_t peeked,committed,released,backpressure,store_failures,freeze_failures,release_failures;
    size_t snapshot_len,body_len,identity_len;
    uint8_t snapshot[TE_HANDOFF_SNAPSHOT_MAX],body[TE_HANDOFF_BODY_MAX],identity[TE_HANDOFF_IDENTITY_MAX];
    uint8_t snapshot_hash[TE_HANDOFF_HASH_BYTES],body_hash[TE_HANDOFF_HASH_BYTES],identity_hash[TE_HANDOFF_HASH_BYTES];
} te_handoff_t;
/* All-zero init only before use. On FAULT preserve the instance for diagnosis;
 * do not reset it or peek a different record. Counters are boot-local and lost on power failure. */
te_handoff_step_t te_handoff_step(te_handoff_t *,const te_handoff_ops_t *);
/* Returns one for any unresolved in-memory handoff, including durable records
 * awaiting collector release. This and boot-local counts disappear on power
 * loss; exact losses before durable storage cannot be reconstructed from RAM.
 * Inspect state and peek_uncertain to distinguish confirmed durability. */
unsigned te_handoff_volatile_pending(const te_handoff_t *);
