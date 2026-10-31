#include "board_capture.h"
#include <stddef.h>
#include <limits.h>
void te_v3_capture_reset(te_v3_capture_state_t *s) { if(s)*s=(te_v3_capture_state_t){.accounting_known=true}; }
bool te_v3_capture_loss(te_v3_capture_state_t *s,te_v3_loss_kind_t kind) {
    if(!s || !s->accounting_known)return false;
    uint32_t *p;
    switch(kind) {
        case TE_LOSS_QUEUE_FULL:p=&s->queue_full;break;
        case TE_LOSS_ENQUEUE_FAILED:p=&s->enqueue_failed;break;
        case TE_LOSS_OVERSIZE:p=&s->oversize;break;
        case TE_LOSS_INVALID:p=&s->invalid;break;
        case TE_LOSS_RETURN_FAILED:p=&s->return_failed;break;
        default:s->accounting_known=false;return false;
    }
    if(*p==UINT32_MAX){s->accounting_known=false;return false;}
    ++*p;
    if(*p==UINT32_MAX){s->accounting_known=false;return false;}
    return kind!=TE_LOSS_RETURN_FAILED;
}
void te_v3_capture_scan_end(te_v3_capture_state_t *s,uint64_t t) {
    if(s && (!s->scan_ended || t<s->scan_end_us)){s->scan_ended=true;s->scan_end_us=t;}
}
bool te_v3_capture_cut(const te_v3_capture_state_t *s,uint64_t start,uint64_t end,
                       uint64_t now,uint64_t *cut,bool *interrupted) {
    if(!s || !cut || !interrupted || start>end || now<start)return false;
    uint64_t t=now<end?now:end;
    if(s->scan_ended && s->scan_end_us<t)t=s->scan_end_us;
    if(t<start)return false;
    *cut=t;*interrupted=s->scan_ended && s->scan_end_us<end;return true;
}
