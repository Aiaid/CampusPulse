#include "cp_v3_temporal.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
    cp_v3_temporal_t *s;
    void *arena;
    size_t size;
    uint64_t random;
    cp_v3_temporal_config_t config;
} fixture_t;
static const cp_v3_temporal_context_t context={1,1,1};
static cp_v3_temporal_time_t time_at(uint64_t ms) {
    return(cp_v3_temporal_time_t){.mono_ms=ms,.utc_ms=1793318400000ULL+ms,.clock_epoch=1,.uncertainty_ms=10,.utc_known=true};
}
static bool entropy(void *ctx,uint8_t out[16]) {
    uint64_t *state=ctx;
    for(unsigned i=0;i<16;++i){*state^=*state<<13;*state^=*state>>7;*state^=*state<<17;out[i]=(uint8_t)*state;}
    return true;
}
static void create(fixture_t *f,cp_v3_temporal_config_t c) {
    memset(f,0,sizeof *f);f->config=c;f->random=UINT64_C(0x123456789abcdef);f->size=cp_v3_temporal_memory_bytes(&c);assert(f->size);
    f->arena=malloc(f->size+32);assert(f->arena);memset((uint8_t *)f->arena+f->size,0xa5,32);
    assert(cp_v3_temporal_init(f->arena,f->size-1,&c,&context,time_at(0),entropy,&f->random,&f->s)==CP_V3_TEMPORAL_NO_MEMORY);
    assert(cp_v3_temporal_init(f->arena,f->size,&c,&context,time_at(0),entropy,&f->random,&f->s)==CP_V3_TEMPORAL_OK);
    assert(cp_v3_temporal_set_coverage(f->s,time_at(0),true)==CP_V3_TEMPORAL_OK);
}
static void destroy(fixture_t *f) {
    for(unsigned i=0;i<32;++i)assert(((uint8_t *)f->arena)[f->size+i]==0xa5);
    cp_v3_temporal_clear(f->s);for(size_t i=0;i<f->size;++i)assert(!((uint8_t *)f->arena)[i]);free(f->arena);
}
static cp_v3_temporal_result_t report(fixture_t *f,uint64_t ms,unsigned key,int rssi,cp_v3_temporal_track_t *handle) {
    uint8_t address[6]={(uint8_t)key,(uint8_t)(key>>8),2,3,4,5};
    return cp_v3_temporal_report(f->s,time_at(ms),0,address,rssi!=127,(int16_t)rssi,handle);
}
static cp_v3_temporal_event_t open_event(fixture_t *f) {
    cp_v3_temporal_event_t e;
    for(uint16_t i=0;i<f->config.max_open_events;++i)if(cp_v3_temporal_event_at(f->s,i,&e)==CP_V3_TEMPORAL_OK&&e.state==CP_V3_TEMPORAL_OPEN)return e;
    assert(!"missing open event");return e;
}
static cp_v3_temporal_event_t publish_event(fixture_t *f) {
    cp_v3_temporal_event_t e;
    for(uint16_t i=0;i<f->config.max_open_events;++i)if(cp_v3_temporal_event_publish(f->s,i,&e)==CP_V3_TEMPORAL_OK)return e;
    assert(!"missing publishable event");return e;
}
static cp_v3_temporal_event_t terminal(fixture_t *f) {
    cp_v3_temporal_event_t e;assert(cp_v3_temporal_terminal_peek(f->s,&e)==CP_V3_TEMPORAL_OK);return e;
}
static void release(fixture_t *f,cp_v3_temporal_event_t e) {
    assert(cp_v3_temporal_terminal_release(f->s,e.event_id,e.event_seq,e.revision)==CP_V3_TEMPORAL_OK);
}
static cp_v3_temporal_config_t small(void) {
    cp_v3_temporal_config_t c=cp_v3_temporal_default_config();c.max_tracks=8;c.max_open_events=8;c.max_terminal_events=16;return c;
}
static void memory_and_widths(void) {
    cp_v3_temporal_config_t c=cp_v3_temporal_default_config();cp_v3_temporal_memory_t m;
    assert(cp_v3_temporal_memory_layout(&c,&m)&&m.cell_bytes==12&&m.history_slices==300&&m.history_bytes==512u*300u*12u);
    printf("temporal default: total=%zu history=%zu tracks=%zu active=%zu terminal=%zu cell=%u\n",
        m.total_bytes,m.history_bytes,m.tracks_bytes,m.active_events_bytes,m.terminal_events_bytes,m.cell_bytes);
    const uint16_t slices[]={1000,2000,5000};
    for(unsigned k=0;k<3;++k){c.slice_ms=slices[k];c.max_open_events=c.max_terminal_events=0;fixture_t f;create(&f,c);
        cp_v3_temporal_track_t last={0};for(unsigned i=0;i<512;++i)assert(report(&f,0,i,-40,&last)==CP_V3_TEMPORAL_OK);
        assert(last.slot==511);cp_v3_temporal_status_t s;cp_v3_temporal_status(f.s,&s);assert(s.tracks==512&&s.reports==512);
        assert(cp_v3_temporal_advance(f.s,time_at(600000))==CP_V3_TEMPORAL_OK);assert(cp_v3_temporal_history_count(f.s)==600000/slices[k]);
        cp_v3_temporal_history_t h;assert(cp_v3_temporal_history_at(f.s,last,0,&h)==CP_V3_TEMPORAL_OK&&h.presence==CP_V3_TEMPORAL_ABSENT);
        destroy(&f);}
    c.max_tracks=513;assert(!cp_v3_temporal_memory_bytes(&c));c.max_tracks=512;c.slice_ms=3000;assert(!cp_v3_temporal_memory_bytes(&c));
}
static void ordered_presence_and_gap(void) {
    fixture_t f;create(&f,small());cp_v3_temporal_track_t h;
    assert(report(&f,0,1,-40,&h)==CP_V3_TEMPORAL_OK);assert(report(&f,500,1,127,NULL)==CP_V3_TEMPORAL_OK);
    assert(cp_v3_temporal_advance(f.s,time_at(4000))==CP_V3_TEMPORAL_OK);
    cp_v3_temporal_history_t a,b;assert(cp_v3_temporal_history_at(f.s,h,0,&a)==CP_V3_TEMPORAL_OK);
    assert(a.presence==CP_V3_TEMPORAL_PRESENT&&a.reports==2&&a.rssi_n==1&&a.rssi_sum==-40&&a.rssi_min==-40&&a.rssi_max==-40&&a.coverage_ms==2000);
    assert(cp_v3_temporal_history_at(f.s,h,1,&b)==CP_V3_TEMPORAL_OK&&b.presence==CP_V3_TEMPORAL_ABSENT&&b.coverage_ms==2000);
    assert(cp_v3_temporal_set_coverage(f.s,time_at(4000),false)==CP_V3_TEMPORAL_OK);
    cp_v3_temporal_event_t e=terminal(&f);assert(e.state==CP_V3_TEMPORAL_CENSORED&&e.reason==CP_V3_TEMPORAL_SCAN_GAP&&e.absent_slices==1&&e.present_slices==1&&e.reports==2&&e.coverage_ms==4000);
    assert(cp_v3_temporal_advance(f.s,time_at(6000))==CP_V3_TEMPORAL_OK);
    assert(cp_v3_temporal_history_at(f.s,h,2,&b)==CP_V3_TEMPORAL_OK&&b.presence==CP_V3_TEMPORAL_UNKNOWN&&b.gap_ms==2000);
    assert(cp_v3_temporal_set_coverage(f.s,time_at(6000),true)==CP_V3_TEMPORAL_OK);assert(report(&f,6000,1,-80,NULL)==CP_V3_TEMPORAL_OK);
    cp_v3_temporal_event_t next=open_event(&f);assert(memcmp(e.event_id,next.event_id,16)&&next.event_seq>e.event_seq);
    release(&f,e);destroy(&f);
}
static void spans_uploads_and_history(void) {
    fixture_t f;create(&f,small());cp_v3_temporal_track_t h;cp_v3_temporal_event_t first={0},previous={0};
    for(unsigned sec=0;sec<=700;++sec){assert(report(&f,(uint64_t)sec*1000,1,-45,&h)==CP_V3_TEMPORAL_OK);
        if(!sec)first=open_event(&f);
        if(sec&&!(sec%30)){cp_v3_temporal_event_t e=open_event(&f);uint16_t count=cp_v3_temporal_history_count(f.s);
            assert(!memcmp(first.event_id,e.event_id,16)&&e.start.mono_ms==0&&e.reports==sec+1);
            e=publish_event(&f);assert(e.revision==previous.revision+1);previous=e;cp_v3_temporal_event_t again=publish_event(&f);
            assert(!memcmp(&again,&e,sizeof e)&&cp_v3_temporal_history_count(f.s)==count);}}
    cp_v3_temporal_event_t e=open_event(&f);assert(e.reports==701&&e.present_slices==351&&e.coverage_ms==700000);
    assert(e.quality_mask&CP_V3_TEMPORAL_HISTORY_TRUNCATED);assert(cp_v3_temporal_history_count(f.s)==300);
    cp_v3_temporal_history_t row;assert(cp_v3_temporal_history_at(f.s,h,0,&row)==CP_V3_TEMPORAL_OK);
    assert(row.slice_start_mono_ms==102000&&row.reports==2&&row.rssi_sum==-90);
    assert(cp_v3_temporal_advance(f.s,time_at(710000))==CP_V3_TEMPORAL_OK);e=terminal(&f);
    assert(e.state==CP_V3_TEMPORAL_CLOSED&&e.reason==CP_V3_TEMPORAL_OBSERVED_GAP&&e.start.mono_ms==0&&e.last_seen.mono_ms==700000&&e.end.mono_ms==710000);
    assert(e.reports==701&&e.rssi_n==701&&e.rssi_sum==-45*701&&e.absent_slices==4&&e.coverage_ms==710000&&e.revision==24);
    uint16_t count=cp_v3_temporal_history_count(f.s);release(&f,e);assert(cp_v3_temporal_history_count(f.s)==count);
    assert(cp_v3_temporal_advance(f.s,time_at(UINT64_C(3000000000)))==CP_V3_TEMPORAL_OK);assert(cp_v3_temporal_history_count(f.s)==300);
    destroy(&f);
}
static void timeout_and_context(void) {
    cp_v3_temporal_config_t c=small();c.gap_ms=4000;c.max_event_ms=20000;fixture_t f;create(&f,c);
    for(unsigned sec=0;sec<20;++sec)assert(report(&f,sec*1000,1,-50,NULL)==CP_V3_TEMPORAL_OK);
    assert(cp_v3_temporal_advance(f.s,time_at(20000))==CP_V3_TEMPORAL_OK);cp_v3_temporal_event_t e=terminal(&f);
    assert(e.state==CP_V3_TEMPORAL_CENSORED&&e.reason==CP_V3_TEMPORAL_TIMEOUT&&e.revision==1&&(e.quality_mask&CP_V3_TEMPORAL_IS_CENSORED));destroy(&f);
    const cp_v3_temporal_reason_t reasons[]={CP_V3_TEMPORAL_CONFIG_CHANGE,CP_V3_TEMPORAL_PLACEMENT_CHANGE,CP_V3_TEMPORAL_REBOOT,CP_V3_TEMPORAL_LEASE_EXPIRED};
    for(unsigned i=0;i<sizeof reasons/sizeof *reasons;++i){create(&f,small());cp_v3_temporal_track_t old;
        assert(report(&f,1000,1,-50,&old)==CP_V3_TEMPORAL_OK);cp_v3_temporal_context_t next=context;
        if(reasons[i]==CP_V3_TEMPORAL_CONFIG_CHANGE)++next.config_generation;
        if(reasons[i]==CP_V3_TEMPORAL_PLACEMENT_CHANGE)++next.placement_generation;
        if(reasons[i]==CP_V3_TEMPORAL_REBOOT)++next.boot_generation;
        assert(cp_v3_temporal_boundary(f.s,time_at(reasons[i]==CP_V3_TEMPORAL_REBOOT?0:2000),&next,reasons[i])==CP_V3_TEMPORAL_OK);
        e=terminal(&f);assert(e.state==CP_V3_TEMPORAL_CENSORED&&e.reason==reasons[i]&&e.context.boot_generation==1);
        cp_v3_temporal_history_t row;assert(cp_v3_temporal_history_at(f.s,old,0,&row)==CP_V3_TEMPORAL_NOT_FOUND);
        destroy(&f);}
    create(&f,small());assert(report(&f,1000,1,-50,NULL)==CP_V3_TEMPORAL_OK);cp_v3_temporal_time_t changed=time_at(2000);changed.clock_epoch=2;
    assert(cp_v3_temporal_advance(f.s,changed)==CP_V3_TEMPORAL_OK);e=terminal(&f);assert(e.reason==CP_V3_TEMPORAL_CLOCK_CHANGE&&e.end.clock_epoch==1);
    cp_v3_temporal_status_t status;cp_v3_temporal_status(f.s,&status);assert(!status.coverage_known&&status.tracks==0);destroy(&f);
    create(&f,small());assert(report(&f,1000,1,-50,NULL)==CP_V3_TEMPORAL_OK);changed=time_at(2000);changed.utc_ms+=1000;
    assert(cp_v3_temporal_advance(f.s,changed)==CP_V3_TEMPORAL_OK);e=terminal(&f);assert(e.reason==CP_V3_TEMPORAL_CLOCK_CHANGE);destroy(&f);
}
static void late_and_capacity(void) {
    fixture_t f;create(&f,small());cp_v3_temporal_track_t h;assert(report(&f,0,1,-50,&h)==CP_V3_TEMPORAL_OK);
    assert(cp_v3_temporal_advance(f.s,time_at(4000))==CP_V3_TEMPORAL_OK);assert(report(&f,1000,1,-50,NULL)==CP_V3_TEMPORAL_LATE);
    cp_v3_temporal_event_t e=terminal(&f);assert(e.state==CP_V3_TEMPORAL_CENSORED&&e.reason==CP_V3_TEMPORAL_LATE_REPORT);
    cp_v3_temporal_history_t row;assert(cp_v3_temporal_history_at(f.s,h,1,&row)==CP_V3_TEMPORAL_OK&&row.presence==CP_V3_TEMPORAL_UNKNOWN);
    cp_v3_temporal_status_t st;cp_v3_temporal_status(f.s,&st);assert(st.late_reports==1&&st.rejected_reports==1);destroy(&f);
    create(&f,small());assert(report(&f,0,1,-50,NULL)==CP_V3_TEMPORAL_OK);assert(cp_v3_temporal_advance(f.s,time_at(10000))==CP_V3_TEMPORAL_OK);
    cp_v3_temporal_event_t before=terminal(&f);assert(before.state==CP_V3_TEMPORAL_CLOSED);assert(report(&f,1000,1,-50,NULL)==CP_V3_TEMPORAL_LATE);
    e=terminal(&f);assert(e.state==CP_V3_TEMPORAL_CENSORED&&e.revision>before.revision);
    assert(cp_v3_temporal_terminal_release(f.s,before.event_id,before.event_seq,before.revision)==CP_V3_TEMPORAL_INVALID);destroy(&f);
    cp_v3_temporal_config_t c=small();c.max_tracks=2;create(&f,c);cp_v3_temporal_track_t old;
    assert(report(&f,0,1,-50,&old)==CP_V3_TEMPORAL_OK);assert(report(&f,1000,2,-50,NULL)==CP_V3_TEMPORAL_OK);assert(report(&f,2000,3,-50,NULL)==CP_V3_TEMPORAL_OK);
    e=terminal(&f);assert(e.state==CP_V3_TEMPORAL_CENSORED&&e.reason==CP_V3_TEMPORAL_CAPACITY&&(e.quality_mask&CP_V3_TEMPORAL_TABLE_LOSS));
    assert(cp_v3_temporal_history_at(f.s,old,0,&row)==CP_V3_TEMPORAL_NOT_FOUND);cp_v3_temporal_status(f.s,&st);assert(st.identity_evictions==1&&st.tracks==2);destroy(&f);
    c=small();c.max_open_events=1;create(&f,c);assert(report(&f,0,1,-50,NULL)==CP_V3_TEMPORAL_OK);assert(report(&f,1000,2,-50,NULL)==CP_V3_TEMPORAL_OK);
    e=terminal(&f);assert(e.reason==CP_V3_TEMPORAL_CAPACITY);cp_v3_temporal_status(f.s,&st);assert(st.event_evictions==1&&st.tracks==2&&st.open_events==1);destroy(&f);
}
static void output_backpressure(void) {
    cp_v3_temporal_config_t c=small();c.max_open_events=2;c.max_terminal_events=1;fixture_t f;create(&f,c);
    assert(report(&f,0,1,-50,NULL)==CP_V3_TEMPORAL_OK);assert(report(&f,0,2,-50,NULL)==CP_V3_TEMPORAL_OK);
    assert(cp_v3_temporal_set_coverage(f.s,time_at(1000),false)==CP_V3_TEMPORAL_BACKPRESSURE);
    cp_v3_temporal_status_t st;cp_v3_temporal_status(f.s,&st);assert(st.blocked&&st.pending_terminals==1&&st.terminal_events==1);
    assert(report(&f,2000,3,-50,NULL)==CP_V3_TEMPORAL_BACKPRESSURE);cp_v3_temporal_event_t first=terminal(&f);release(&f,first);
    cp_v3_temporal_event_t second=terminal(&f);assert(memcmp(first.event_id,second.event_id,16));release(&f,second);
    cp_v3_temporal_status(f.s,&st);assert(!st.blocked&&!st.pending_terminals&&!st.terminal_events&&!st.coverage_known&&st.rejected_reports==1);
    assert(cp_v3_temporal_set_coverage(f.s,time_at(2000),true)==CP_V3_TEMPORAL_OK);assert(report(&f,2000,3,-50,NULL)==CP_V3_TEMPORAL_OK);destroy(&f);
}
static bool failing_entropy(void *ctx,uint8_t bytes[16]) {(void)ctx;(void)bytes;return false;}
static void isolation_and_entropy(void) {
    fixture_t f;create(&f,small());uint8_t address[6]={1,2,3,4,5,6};
    assert(cp_v3_temporal_report(f.s,time_at(0),0,address,true,-50,NULL)==CP_V3_TEMPORAL_OK);
    assert(cp_v3_temporal_report(f.s,time_at(0),1,address,true,-50,NULL)==CP_V3_TEMPORAL_OK);
    cp_v3_temporal_status_t st;cp_v3_temporal_status(f.s,&st);assert(st.tracks==2&&st.open_events==2);
    assert(cp_v3_temporal_report(f.s,time_at(0),1,address,true,127,NULL)==CP_V3_TEMPORAL_INVALID);destroy(&f);
    create(&f,small());assert(cp_v3_temporal_init(f.arena,f.size,&f.config,&context,time_at(0),failing_entropy,NULL,&f.s)==CP_V3_TEMPORAL_OK);
    assert(cp_v3_temporal_set_coverage(f.s,time_at(0),true)==CP_V3_TEMPORAL_OK);assert(report(&f,0,1,-50,NULL)==CP_V3_TEMPORAL_ENTROPY_FAILED);
    cp_v3_temporal_status(f.s,&st);assert(st.entropy_failures==1&&st.open_events==0&&st.reports==1);destroy(&f);
}
static void reference_history_replay(void) {
    typedef struct { unsigned coverage,gaps,reports,n;int sum,min,max; } reference_t;
    const uint16_t widths[]={1000,2000,5000};
    for(unsigned width=0;width<3;++width){
        reference_t reference[1301]={0};cp_v3_temporal_config_t c=small();c.slice_ms=widths[width];c.max_tracks=2;c.max_open_events=c.max_terminal_events=0;
        fixture_t f;create(&f,c);cp_v3_temporal_track_t handle={0};bool known=true;
        for(unsigned step=0;step<=2400;++step){uint64_t ms=(uint64_t)step*500;
            if(step){reference_t *r=&reference[(ms-500)/c.slice_ms];if(known)r->coverage+=500;else r->gaps+=500;}
            assert(cp_v3_temporal_advance(f.s,time_at(ms))==CP_V3_TEMPORAL_OK);
            bool next=(step%34)<30;
            if(next!=known){assert(cp_v3_temporal_set_coverage(f.s,time_at(ms),next)==CP_V3_TEMPORAL_OK);known=next;}
            if(!(step%3)){int value=step%10? -100+(int)(step%80):127;assert(report(&f,ms,1,value,&handle)==CP_V3_TEMPORAL_OK);
                reference_t *r=&reference[ms/c.slice_ms];++r->reports;
                if(value!=127){if(!r->n)r->min=r->max=value;if(value<r->min)r->min=value;if(value>r->max)r->max=value;++r->n;r->sum+=value;}}
        }
        uint16_t count=cp_v3_temporal_history_count(f.s);uint64_t oldest=1200000/c.slice_ms-count+1;
        for(uint16_t i=0;i<count;++i){cp_v3_temporal_history_t row;assert(cp_v3_temporal_history_at(f.s,handle,i,&row)==CP_V3_TEMPORAL_OK);
            reference_t *r=&reference[oldest+i];assert(row.slice_start_mono_ms==(oldest+i)*c.slice_ms);
            assert(row.coverage_ms==r->coverage&&row.gap_ms==r->gaps&&row.reports==r->reports&&row.rssi_n==r->n&&row.rssi_sum==r->sum);
            if(r->n)assert(row.rssi_min==r->min&&row.rssi_max==r->max);
            cp_v3_temporal_presence_t expected=r->reports?CP_V3_TEMPORAL_PRESENT:(i+1<count&&r->coverage==c.slice_ms?CP_V3_TEMPORAL_ABSENT:CP_V3_TEMPORAL_UNKNOWN);
            assert(row.presence==expected);}
        destroy(&f);
    }
}
static void pause_preserves_history(void) {
    fixture_t f;create(&f,small());cp_v3_temporal_track_t track;
    assert(report(&f,0,1,-60,&track)==CP_V3_TEMPORAL_OK);
    assert(report(&f,2000,1,-62,&track)==CP_V3_TEMPORAL_OK);
    uint16_t before=cp_v3_temporal_history_count(f.s);
    assert(cp_v3_temporal_censor(f.s,time_at(3000),CP_V3_TEMPORAL_LEASE_EXPIRED)==CP_V3_TEMPORAL_OK);
    assert(cp_v3_temporal_history_count(f.s)>=before);
    cp_v3_temporal_history_t row;
    assert(cp_v3_temporal_history_at(f.s,track,0,&row)==CP_V3_TEMPORAL_OK&&row.reports==1);
    cp_v3_temporal_event_t e=terminal(&f);
    assert(e.state==CP_V3_TEMPORAL_CENSORED&&e.reason==CP_V3_TEMPORAL_LEASE_EXPIRED);
    assert(e.last_seen.mono_ms==2000&&e.observed_until.mono_ms==2000&&e.end.mono_ms==3000&&e.coverage_ms==2000);
    release(&f,e);
    assert(cp_v3_temporal_set_coverage(f.s,time_at(5000),true)==CP_V3_TEMPORAL_OK);
    assert(report(&f,6000,1,-65,&track)==CP_V3_TEMPORAL_OK);
    assert(cp_v3_temporal_history_count(f.s)>=4);
    assert(cp_v3_temporal_history_at(f.s,track,0,&row)==CP_V3_TEMPORAL_OK&&row.reports==1);
    destroy(&f);
}
int main(void) {
    memory_and_widths();ordered_presence_and_gap();spans_uploads_and_history();timeout_and_context();
    late_and_capacity();output_backpressure();isolation_and_entropy();reference_history_replay();pause_preserves_history();
    puts("temporal replay: rolling history, cross-window episodes, gaps, boundaries, capacity and backpressure passed");return 0;
}
