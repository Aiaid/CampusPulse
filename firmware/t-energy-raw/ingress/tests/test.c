#include "raw_ingress.h"
#include <assert.h>
#include <pthread.h>
#include <sched.h>
#include <stdio.h>
#include <string.h>
#define N 100000u
static te_raw_ingress_t q;
static te_raw_report_t slots[8];
static void *producer(void *unused) {
    (void)unused; te_raw_report_t meta={0}; meta.kind=1; meta.rssi=-52; meta.sid=7; meta.props=19; meta.data_status=2;
    for(uint32_t i=0;i<N;i++) {
        meta.mono_us=i; memcpy(meta.addr,&i,sizeof i);
        while(te_raw_ingress_push(&q,&meta,(uint8_t *)&i,sizeof i)==TE_RAW_FULL) sched_yield();
    }
    return NULL;
}
static void *consumer(void *unused) {
    (void)unused; te_raw_report_t out; uint64_t last=0;
    for(uint32_t i=0;i<N;i++) {
        while(te_raw_ingress_pop(&q,&out)==TE_RAW_EMPTY) sched_yield();
        uint32_t v=0,a=0; memcpy(&v,out.payload,sizeof v); memcpy(&a,out.addr,sizeof a);
        assert(out.length==sizeof v && v==i && a==i && out.mono_us==i && out.seq>last);
        assert(out.kind==1 && out.rssi==-52 && out.sid==7 && out.props==19 && out.data_status==2);
        last=out.seq;
    }
    return NULL;
}
int main(void) {
    assert(!te_raw_ingress_init(&q,slots,3)); assert(te_raw_ingress_init(&q,slots,8));
    te_raw_report_t m={0},o; uint8_t bytes[TE_RAW_PAYLOAD_MAX]; memset(bytes,0xa5,sizeof bytes);
    m.kind=0; m.event_type=4; m.primary_phy=1; m.addr_type=2; m.addr[0]=0x41; m.direct_addr[5]=0x68; m.rssi=-77;
    assert(te_raw_ingress_push(&q,&m,bytes,sizeof bytes)==TE_RAW_OK);
    memset(bytes,0,sizeof bytes);
    assert(te_raw_ingress_pop(&q,&o)==TE_RAW_OK); assert(o.payload[0]==0xa5 && o.payload[sizeof bytes-1]==0xa5);
    assert(o.seq==1 && o.kind==0 && o.event_type==4 && o.addr[0]==0x41 && o.direct_addr[5]==0x68 && o.rssi==-77);
    assert(te_raw_ingress_push(&q,&m,bytes,sizeof bytes+1)==TE_RAW_OVERSIZE);
    assert(te_raw_ingress_push(&q,&m,NULL,1)==TE_RAW_INVALID);
    for(int i=0;i<8;i++) assert(te_raw_ingress_push(&q,&m,NULL,0)==TE_RAW_OK);
    assert(te_raw_ingress_push(&q,&m,NULL,0)==TE_RAW_FULL);
    for(int i=0;i<8;i++) assert(te_raw_ingress_pop(&q,&o)==TE_RAW_OK);
    assert(te_raw_ingress_pop(&q,&o)==TE_RAW_EMPTY);
    assert(te_raw_ingress_push(&q,&m,NULL,0)==TE_RAW_OK); assert(te_raw_ingress_pop(&q,&o)==TE_RAW_OK); assert(o.seq==13);
    te_raw_ingress_stats_t s; te_raw_ingress_stats(&q,&s);
    assert(s.received==13 && s.enqueued==10 && s.dropped_oversize==1 && s.dropped_invalid==1 && s.dropped_full==1);
    /* Exercise counters and ring indices across uint32 wrap. */
    assert(te_raw_ingress_init(&q,slots,8)); q.head=q.tail=UINT32_MAX-2;
    for(int i=0;i<8;i++) assert(te_raw_ingress_push(&q,&m,NULL,0)==TE_RAW_OK);
    for(int i=0;i<8;i++) assert(te_raw_ingress_pop(&q,&o)==TE_RAW_OK && o.seq==(uint64_t)i+1);
    assert(te_raw_ingress_init(&q,slots,8)); pthread_t p,c;
    assert(!pthread_create(&p,NULL,producer,NULL)); assert(!pthread_create(&c,NULL,consumer,NULL));
    assert(!pthread_join(p,NULL) && !pthread_join(c,NULL)); te_raw_ingress_stats(&q,&s);
    assert(s.enqueued==N && s.received==N+s.dropped_full && !s.dropped_invalid && !s.dropped_oversize);
    puts("raw ingress tests passed");
}
