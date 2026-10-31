#include "flash_queue.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
static unsigned char media[TE_FLASH_QUEUE_BYTES];
static int fail_op, op, partial;
int esp_partition_read(const esp_partition_t *p,size_t o,void *b,size_t n) {
    if (o+n>p->size) return -1;
    if (fail_op && ++op==fail_op) return -1;
    memcpy(b,media+o,n); return 0;
}
int esp_partition_write(const esp_partition_t *p,size_t o,const void *b,size_t n) {
    if(o+n>p->size) return -1;
    bool fail=fail_op && ++op==fail_op; if(fail) n=partial ? n/2 : 0;
    for(size_t i=0;i<n;i++) { unsigned char v=((const unsigned char *)b)[i]; assert((media[o+i]&v)==v); media[o+i]&=v; }
    return fail ? -1 : 0;
}
int esp_partition_erase_range(const esp_partition_t *p,size_t o,size_t n) {
    if(o+n>p->size || o%4096 || n%4096) return -1;
    bool fail=fail_op && ++op==fail_op; if(fail) n=partial?n/2:0;
    memset(media+o,0xff,n); return fail?-1:0;
}
static esp_partition_t part={.type=1,.subtype=0x40,.address=0x800000,.size=TE_FLASH_QUEUE_BYTES,.erase_size=4096,.label="v3queue"};
static te_flash_queue_t state; static cp_v3_queue_store_t q; static unsigned char data[6144], out[6144];
static void prepare(void) { assert(te_flash_queue_prepare(&state,&part,&q)); }
static int load(void) { size_t n; return q.load(q.context,0,out,sizeof out,&n); }
int main(void) {
    for(size_t i=0;i<sizeof data;i++) data[i]=(unsigned char)(i*13);
    memset(media,0xff,sizeof media); prepare(); assert(load()==0);
    assert(q.store(q.context,0,data,sizeof data)); assert(load()==1 && !memcmp(data,out,sizeof data));
    assert(!q.store(q.context,0,data,sizeof data)); data[0]^=1; assert(!q.reclaim(q.context,0,data,sizeof data)); data[0]^=1;
    assert(q.reclaim(q.context,0,data,sizeof data)); assert(load()==0);
    assert(q.store(q.context,0,data,sizeof data)); media[100]^=1; assert(load()==2);
    memset(media,0xff,sizeof media); media[7000]=0; assert(load()==2);
    memset(media,0xff,sizeof media); part.encrypted=true; assert(!te_flash_queue_prepare(&state,&part,&q)); part.encrypted=false;
    part.subtype=0x41; assert(!te_flash_queue_prepare(&state,&part,&q)); part.subtype=0x40;
    /* Fault each I/O through a store; reboot, observe only absent, intact, or occupied. */
    for(int f=1;f<75;f++) for(int torn=0;torn<2;torn++) {
        memset(media,0xff,sizeof media); fail_op=0; prepare(); op=0; fail_op=f; partial=torn;
        bool ok=q.store(q.context,0,data,sizeof data); fail_op=0;
        if(!ok && (state.uncertain&1)) assert(load()==2);
        prepare(); int v=load(); assert(v==0 || v==2 || (v==1 && !memcmp(data,out,sizeof data)));
        if(ok) assert(v==1);
    }
    /* Fault every stage of reclaim: any absent record followed receipt match. */
    for(int f=1;f<80;f++) for(int torn=0;torn<2;torn++) {
        memset(media,0xff,sizeof media); fail_op=0; prepare(); assert(q.store(q.context,0,data,sizeof data));
        op=0; fail_op=f; partial=torn; bool ok=q.reclaim(q.context,0,data,sizeof data); fail_op=0;
        if(!ok && (state.uncertain&1)) assert(load()==2);
        prepare(); int v=load(); assert(v==0 || v==2 || (v==1 && !memcmp(data,out,sizeof data)));
        if(ok) assert(v==0);
    }
    puts("flash queue tests passed");
}
