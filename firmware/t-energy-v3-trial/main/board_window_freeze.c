#include "board_window_freeze.h"
#include "board_handoff.h"
#include <string.h>
_Static_assert(sizeof(cp_v3_expected_t)<=TE_HANDOFF_IDENTITY_MAX,"expected identity exceeds handoff capacity");
static void wipe(void *p,size_t n) {volatile unsigned char *v=p;while(n--)*v++=0;}
bool te_v3_window_freeze(void *context,const void *snapshot,size_t snapshot_len,
    void *body,size_t body_cap,size_t *body_len,void *identity,size_t identity_cap,size_t *identity_len) {
    if(body_len)*body_len=0;
    if(identity_len)*identity_len=0;
    if(body && body_cap)((char *)body)[0]=0;
    if(!context || !snapshot || snapshot_len!=sizeof(cp_v3_capture_window_t) || !body || !body_len ||
       !identity || !identity_len || identity_cap<sizeof(cp_v3_expected_t) || !body_cap) return false;
    te_v3_window_freeze_t *c=context;
    if(!c->sha256 || !c->seq || !memchr(c->batch_id,0,sizeof c->batch_id))return false;
    memcpy(&c->scratch,snapshot,sizeof c->scratch);
    cp_v3_capture_window_t *w=&c->scratch;
    cp_v3_expected_t expected={0};size_t length=0;
    bool consistent=w->window_seq && w->scope.window_seq==w->window_seq && w->statistics.source_consistent;
    size_t cap=body_cap<TE_WINDOW_BODY_MAX+1u?body_cap:TE_WINDOW_BODY_MAX+1u;
    cp_v3_result_t result=consistent?cp_v3_small_window_body(&w->scope,&w->statistics,w->end_time,
        c->batch_id,c->seq,c->sha256,c->sha_context,body,cap,&length,&expected):CP_V3_INVALID;
    wipe(&c->scratch,sizeof c->scratch);
    if(result!=CP_V3_OK || !length || length>TE_WINDOW_BODY_MAX || expected.body_bytes!=length) {
        wipe(body,cap);wipe(&expected,sizeof expected);return false;
    }
    memcpy(identity,&expected,sizeof expected);*identity_len=sizeof expected;*body_len=length;
    wipe(&expected,sizeof expected);return true;
}
