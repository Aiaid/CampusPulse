#include "raw_ingress.h"
#include <stddef.h>
#include <string.h>

_Static_assert(__atomic_always_lock_free(sizeof(uint32_t), 0), "32-bit atomic operations must be lock-free");
static void increment(uint32_t *p) { (void)__atomic_fetch_add(p,1u,__ATOMIC_RELAXED); }
bool te_raw_ingress_init(te_raw_ingress_t *q,te_raw_report_t *slots,uint32_t capacity) {
    /* Power-of-two capacity ensures indexing remains correct at uint32 wrap. */
    if (!q || !slots || !capacity || capacity > (1u<<30) || (capacity & (capacity-1u))) return false;
    memset(q,0,sizeof *q); q->slots=slots; q->capacity=capacity; return true;
}
te_raw_result_t te_raw_ingress_push(te_raw_ingress_t *q,const te_raw_report_t *meta,const uint8_t *data,size_t len) {
    if (!q || !q->slots) return TE_RAW_INVALID;
    increment(&q->received);
    /* Single producer owns next_seq. Never wrap to a previously used sequence. */
    if (q->next_seq==UINT64_MAX) { increment(&q->dropped_invalid); return TE_RAW_INVALID; }
    uint64_t seq=++q->next_seq;
    if (!meta || (len && !data)) { increment(&q->dropped_invalid); return TE_RAW_INVALID; }
    if (len>TE_RAW_PAYLOAD_MAX) { increment(&q->dropped_oversize); return TE_RAW_OVERSIZE; }
    uint32_t head=__atomic_load_n(&q->head,__ATOMIC_RELAXED);
    uint32_t tail=__atomic_load_n(&q->tail,__ATOMIC_ACQUIRE);
    if ((uint32_t)(head-tail)>=q->capacity) { increment(&q->dropped_full); return TE_RAW_FULL; }
    te_raw_report_t *slot=&q->slots[head & (q->capacity-1u)];
    memcpy(slot,meta,offsetof(te_raw_report_t,payload));
    slot->seq=seq; slot->length=(uint16_t)len;
    if (len) memcpy(slot->payload,data,len);
    increment(&q->enqueued);
    __atomic_store_n(&q->head,head+1u,__ATOMIC_RELEASE);
    return TE_RAW_OK;
}
te_raw_result_t te_raw_ingress_pop(te_raw_ingress_t *q,te_raw_report_t *out) {
    if (!q || !q->slots || !out) return TE_RAW_INVALID;
    uint32_t tail=__atomic_load_n(&q->tail,__ATOMIC_RELAXED);
    uint32_t head=__atomic_load_n(&q->head,__ATOMIC_ACQUIRE);
    if (tail==head) return TE_RAW_EMPTY;
    te_raw_report_t *slot=&q->slots[tail & (q->capacity-1u)];
    memcpy(out,slot,offsetof(te_raw_report_t,payload));
    if (slot->length) memcpy(out->payload,slot->payload,slot->length);
    __atomic_store_n(&q->tail,tail+1u,__ATOMIC_RELEASE);
    return TE_RAW_OK;
}
void te_raw_ingress_stats(const te_raw_ingress_t *q,te_raw_ingress_stats_t *s) {
    if (!q || !s) return;
    s->received=__atomic_load_n(&q->received,__ATOMIC_RELAXED);
    s->enqueued=__atomic_load_n(&q->enqueued,__ATOMIC_RELAXED);
    s->dropped_full=__atomic_load_n(&q->dropped_full,__ATOMIC_RELAXED);
    s->dropped_oversize=__atomic_load_n(&q->dropped_oversize,__ATOMIC_RELAXED);
    s->dropped_invalid=__atomic_load_n(&q->dropped_invalid,__ATOMIC_RELAXED);
}
