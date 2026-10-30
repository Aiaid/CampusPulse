#include "raw_panel.h"
#include <assert.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

typedef struct { char kind; unsigned value; size_t length; uint8_t data[5000]; } event_t;
typedef struct { event_t events[600]; unsigned count, calls, fail_at; } trace_t;
static event_t *add(trace_t *t, char kind) {
    assert(t->count < sizeof t->events / sizeof t->events[0]);
    event_t *e = &t->events[t->count++]; memset(e, 0, sizeof *e); e->kind = kind; return e;
}
static int fail(trace_t *t) { return ++t->calls == t->fail_at ? 77 : 0; }
static int cmd(void *ctx, uint8_t v) { trace_t *t = ctx; add(t,'C')->value = v; return fail(t); }
static int data(void *ctx, const uint8_t *p, size_t n) {
    trace_t *t = ctx; event_t *e = add(t,'D'); assert(n <= sizeof e->data);
    e->length = n; memcpy(e->data,p,n); return fail(t);
}
static int wait(void *ctx, uint32_t ms) { trace_t *t = ctx; add(t,'W')->value = ms; return fail(t); }
static void reset(void *ctx) { add(ctx,'R'); }
static void power(void *ctx, bool on) { add(ctx,'P')->value = on; }
static void delay(void *ctx, uint32_t ms) { add(ctx,'T')->value = ms; }
static raw_panel_io_t interface(trace_t *t) { return (raw_panel_io_t){t,cmd,data,wait,reset,power,delay}; }
static int find_cmd(trace_t *t, unsigned value, int start) {
    for (unsigned i = (unsigned)start; i < t->count; ++i)
        if (t->events[i].kind == 'C' && t->events[i].value == value) return (int)i;
    return -1;
}
static void expect_data(trace_t *t, int i, const uint8_t *p, size_t n) {
    assert(i >= 0 && t->events[i+1].kind == 'D');
    assert(t->events[i+1].length == n && memcmp(t->events[i+1].data, p, n) == 0);
}
int main(void) {
    static trace_t t;
    uint8_t frame[5000];
    for (size_t i = 0; i < sizeof frame; i++) frame[i] = (uint8_t)(i * 17u);
    raw_panel_io_t io = interface(&t);
    raw_refresh_plan_t plan = {RAW_REFRESH_PARTIAL, 3, 5, 17, 19};
    assert(raw_panel_partial(&io, frame, &plan) == 0);
    assert(t.events[0].kind == 'R');
    for (unsigned i = 0; i < t.count; i++) assert(t.events[i].kind != 'P');
    const uint8_t lut[153] = {[1]=0x40,[12]=0x80,[13]=0x80,[24]=0x40,[25]=0x40,[37]=0x80,
        [60]=0x0f,[67]=1,[68]=1,[144]=0x22,[145]=0x22,[146]=0x22,[147]=0x22,[148]=0x22,[149]=0x22};
    int i = find_cmd(&t,0x32,0); expect_data(&t,i,lut,sizeof lut);
    const uint8_t a[]={2}, b[]={0x17}, c[]={0x41,0xb0,0x32}, d[]={0x28};
    int j = find_cmd(&t,0x3f,i+1); expect_data(&t,j,a,sizeof a);
    i = find_cmd(&t,0x03,j+1); expect_data(&t,i,b,sizeof b);
    j = find_cmd(&t,0x04,i+1); expect_data(&t,j,c,sizeof c);
    i = find_cmd(&t,0x2c,j+1); expect_data(&t,i,d,sizeof d);
    const uint8_t ping[]={0,0,0,0,0,0x40,0,0,0,0};
    j=find_cmd(&t,0x37,i+1); expect_data(&t,j,ping,sizeof ping);
    const uint8_t border[]={0x80}, pre[]={0xc0}, mode[]={3}, xx[]={3,5}, yy[]={17,0,19,0}, ptrx[]={3}, ptry[]={17,0}, upd[]={0xcf};
    i=find_cmd(&t,0x3c,j+1); expect_data(&t,i,border,1);
    j=find_cmd(&t,0x22,i+1); expect_data(&t,j,pre,1);
    assert(t.events[j+2].kind=='C' && t.events[j+2].value==0x20 && t.events[j+3].kind=='W');
    i=find_cmd(&t,0x11,j+1); expect_data(&t,i,mode,1);
    j=find_cmd(&t,0x44,i+1); expect_data(&t,j,xx,2);
    i=find_cmd(&t,0x45,j+1); expect_data(&t,i,yy,4);
    j=find_cmd(&t,0x4e,i+1); expect_data(&t,j,ptrx,1);
    i=find_cmd(&t,0x4f,j+1); expect_data(&t,i,ptry,2);
    j=find_cmd(&t,0x24,i+1); assert(j>=0);
    for (int row=0; row<3; row++) {
        event_t *e=&t.events[j+1+row]; assert(e->kind=='D' && e->length==3);
        assert(!memcmp(e->data,frame+(17+row)*25+3,3));
    }
    assert(find_cmd(&t,0x26,0)<0);
    i=find_cmd(&t,0x22,j+1); expect_data(&t,i,upd,1);
    assert(t.events[i+2].kind=='C' && t.events[i+2].value==0x20 && t.events[i+3].kind=='W');
    unsigned partial_calls=t.calls;
    for (unsigned n=1; n<=partial_calls; n++) {
        memset(&t,0,sizeof t); t.fail_at=n;
        assert(raw_panel_partial(&io,frame,&plan)==77); assert(t.calls==n);
    }
    memset(&t,0,sizeof t); plan.x1=25;
    assert(raw_panel_partial(&io,frame,&plan)!=0 && t.count==0); plan.x1=5;
    plan.y0=20; plan.y1=19; assert(raw_panel_partial(&io,frame,&plan)!=0 && t.count==0);
    memset(&t,0,sizeof t);
    assert(raw_panel_full(&io,frame)==0);
    assert(t.events[0].kind=='P' && t.events[0].value==1);
    i=find_cmd(&t,0x26,0); expect_data(&t,i,frame,sizeof frame);
    j=find_cmd(&t,0x24,i+1); expect_data(&t,j,frame,sizeof frame);
    const uint8_t full[]={0xf7}; i=find_cmd(&t,0x22,j+1); expect_data(&t,i,full,1);
    assert(t.events[i+2].kind=='C' && t.events[i+2].value==0x20 && t.events[i+3].kind=='W');
    unsigned full_calls=t.calls;
    for (unsigned n=1; n<=full_calls; n++) {
        memset(&t,0,sizeof t); t.fail_at=n;
        assert(raw_panel_full(&io,frame)==77 && t.calls==n);
    }
    memset(&t,0,sizeof t); assert(raw_panel_off(&io)==0);
    const uint8_t off[]={0x83}; expect_data(&t,0,off,1);
    assert(t.events[2].kind=='C' && t.events[2].value==0x20 && t.events[3].kind=='W');
    assert(t.events[4].kind=='P' && !t.events[4].value);
    memset(&t,0,sizeof t); t.fail_at=2;
    assert(raw_panel_off(&io)==77 && t.calls==2 && t.events[t.count-1].kind=='P' && !t.events[t.count-1].value);
    return 0;
}
