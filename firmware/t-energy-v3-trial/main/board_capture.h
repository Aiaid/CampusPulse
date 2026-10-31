#pragma once
#include <stdbool.h>
#include <stdint.h>
/* Caller serializes callback/worker access with the board ingress lock. */
typedef enum { TE_LOSS_QUEUE_FULL,TE_LOSS_ENQUEUE_FAILED,TE_LOSS_OVERSIZE,
               TE_LOSS_INVALID,TE_LOSS_RETURN_FAILED } te_v3_loss_kind_t;
typedef struct {
    uint32_t queue_full,enqueue_failed,oversize,invalid,return_failed;
    bool accounting_known,scan_ended;
    uint64_t scan_end_us;
} te_v3_capture_state_t;
void te_v3_capture_reset(te_v3_capture_state_t *);
/* False means loss accounting cannot remain exact or slot ownership failed. */
bool te_v3_capture_loss(te_v3_capture_state_t *,te_v3_loss_kind_t);
void te_v3_capture_scan_end(te_v3_capture_state_t *,uint64_t mono_us);
/* First observed scanner end is authoritative; never count later time active. */
bool te_v3_capture_cut(const te_v3_capture_state_t *,uint64_t start,uint64_t end,
                       uint64_t now,uint64_t *cut,bool *interrupted);
