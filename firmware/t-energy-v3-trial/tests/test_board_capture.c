#include "board_capture.h"
#include <assert.h>
#include <limits.h>
#include <stdio.h>
int main(void) {
    te_v3_capture_state_t s;te_v3_capture_reset(&s);
    assert(s.accounting_known);
    assert(te_v3_capture_loss(&s,TE_LOSS_QUEUE_FULL));
    assert(te_v3_capture_loss(&s,TE_LOSS_ENQUEUE_FAILED));
    assert(te_v3_capture_loss(&s,TE_LOSS_OVERSIZE));
    assert(te_v3_capture_loss(&s,TE_LOSS_INVALID));
    assert(s.queue_full==1&&s.enqueue_failed==1&&s.oversize==1&&s.invalid==1);
    assert(!te_v3_capture_loss(&s,TE_LOSS_RETURN_FAILED)&&s.return_failed==1);
    uint64_t cut=0;bool interrupted=false;
    assert(te_v3_capture_cut(&s,100,200,250,&cut,&interrupted)&&cut==200&&!interrupted);
    te_v3_capture_scan_end(&s,150);te_v3_capture_scan_end(&s,180);
    assert(te_v3_capture_cut(&s,100,200,250,&cut,&interrupted)&&cut==150&&interrupted);
    assert(te_v3_capture_cut(&s,100,200,130,&cut,&interrupted)&&cut==130&&interrupted);
    te_v3_capture_scan_end(&s,90);
    assert(!te_v3_capture_cut(&s,100,200,250,&cut,&interrupted));
    te_v3_capture_reset(&s);s.queue_full=UINT32_MAX-1;
    assert(!te_v3_capture_loss(&s,TE_LOSS_QUEUE_FULL)&&s.queue_full==UINT32_MAX&&!s.accounting_known);
    assert(!te_v3_capture_loss(&s,TE_LOSS_OVERSIZE)&&s.oversize==0);
    assert(!te_v3_capture_cut(&s,100,200,99,&cut,&interrupted));
    puts("board capture tests passed");
}
