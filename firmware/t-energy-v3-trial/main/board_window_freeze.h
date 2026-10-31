#pragma once
#include "cp_v3_capture.h"
#include "cp_v3_small_results.h"
/* 1024 body bytes, excluding the serializer's terminating NUL. */
#define TE_WINDOW_BODY_MAX 1024u
/* One context per staged item. Caller provides fixed batch UUID/seq and hash;
 * it owns this context until the frozen handoff completes. No ID is generated. */
typedef struct {
    char batch_id[37];
    uint32_t seq;
    cp_v3_sha256_fn sha256;
    void *sha_context;
    cp_v3_capture_window_t scratch;
} te_v3_window_freeze_t;
/* Same signature as board_handoff.freeze; identity is a byte-for-byte copy of
 * cp_v3_expected_t. Does not write a durable record or grant lease permission. */
bool te_v3_window_freeze(void *ctx,const void *snapshot,size_t snapshot_len,
    void *body,size_t body_cap,size_t *body_len,void *identity,size_t identity_cap,size_t *identity_len);
