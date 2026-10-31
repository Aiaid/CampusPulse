#include "cp_v3_temporal.h"
#include <limits.h>
#include <string.h>

#define NONE UINT16_MAX
#define SAFE UINT64_C(9007199254740991)
#define MAGIC UINT32_C(0x43505431)
#define EVENT_REPORT_LIMIT UINT64_C(1000000000)
typedef struct {
    int32_t sum;
    uint16_t reports, rssi_n;
    int8_t min, max;
    uint16_t generation;
} cell_t;
_Static_assert(sizeof(cell_t)==12, "history cell budget changed");
typedef struct {
    uint64_t number;
    uint16_t coverage_ms, gap_ms;
} slice_t;
typedef struct {
    uint64_t born_slice, last_seen;
    uint32_t generation;
    uint16_t event_slot;
    uint8_t address[6], type;
    bool used;
} track_t;
typedef struct {
    cp_v3_temporal_event_t value;
    uint64_t last_present_slice, last_absent_slice;
    uint16_t track_slot;
    uint32_t track_generation;
    bool used, pending, dirty;
} active_t;
struct cp_v3_temporal {
    uint32_t magic, next_event_seq;
    size_t arena_bytes;
    cp_v3_temporal_config_t config;
    cp_v3_temporal_context_t context;
    cp_v3_temporal_time_t now;
    cp_v3_temporal_status_t counters;
    cp_v3_temporal_entropy_fn entropy;
    void *entropy_context;
    track_t *tracks;
    slice_t *slices;
    cell_t *cells;
    active_t *active;
    cp_v3_temporal_event_t *terminal;
    uint64_t current_slice;
    uint16_t slice_count, retained, terminal_head, terminal_count;
    bool known, blocked;
};
typedef struct { size_t tracks,slices,cells,active,terminal,total; } offsets_t;
static bool config_valid(const cp_v3_temporal_config_t *c) {
    return c&&c->max_tracks&&c->max_tracks<=CP_V3_TEMPORAL_MAX_TRACKS&&
        c->max_open_events<=CP_V3_TEMPORAL_MAX_TRACKS&&c->max_terminal_events<=CP_V3_TEMPORAL_MAX_TRACKS&&
        ((!c->max_open_events&&!c->max_terminal_events)||(c->max_open_events&&c->max_terminal_events))&&
        (c->slice_ms==1000||c->slice_ms==2000||c->slice_ms==5000)&&
        c->history_ms>=c->slice_ms&&c->history_ms<=CP_V3_TEMPORAL_HISTORY_MS&&!(c->history_ms%c->slice_ms)&&
        c->gap_ms>=c->slice_ms&&c->gap_ms<=CP_V3_TEMPORAL_HISTORY_MS&&
        c->max_event_ms>c->gap_ms&&c->max_event_ms<=86400000u;
}
static bool context_valid(const cp_v3_temporal_context_t *c) {
    return c&&c->boot_generation&&c->config_generation&&c->placement_generation;
}
static bool time_valid(cp_v3_temporal_time_t t) {
    return t.clock_epoch&&t.mono_ms<=SAFE&&
        (t.utc_known?(t.uncertainty_ms<=5000&&t.utc_ms>=t.uncertainty_ms&&t.utc_ms<=UINT64_C(8640000000000000)):
        (!t.utc_ms&&!t.uncertainty_ms));
}
static bool valid(const cp_v3_temporal_t *s) { return s&&s->magic==MAGIC; }
static size_t align_up(size_t n,size_t a) { return (n+a-1)/a*a; }
static size_t block(size_t *n,size_t count,size_t width,size_t alignment) {
    *n=align_up(*n,alignment);size_t at=*n;*n+=count*width;return at;
}
static bool layout(const cp_v3_temporal_config_t *c,offsets_t *o,cp_v3_temporal_memory_t *m) {
    if(!config_valid(c))return false;
    size_t n=sizeof(cp_v3_temporal_t),slices=c->history_ms/c->slice_ms;
    o->tracks=block(&n,c->max_tracks,sizeof(track_t),_Alignof(track_t));
    o->slices=block(&n,slices,sizeof(slice_t),_Alignof(slice_t));
    o->cells=block(&n,slices*c->max_tracks,sizeof(cell_t),_Alignof(cell_t));
    o->active=block(&n,c->max_open_events,sizeof(active_t),_Alignof(active_t));
    o->terminal=block(&n,c->max_terminal_events,sizeof(cp_v3_temporal_event_t),_Alignof(cp_v3_temporal_event_t));
    o->total=align_up(n,_Alignof(max_align_t));
    if(m)*m=(cp_v3_temporal_memory_t){.total_bytes=o->total,.state_bytes=sizeof(cp_v3_temporal_t),
        .tracks_bytes=c->max_tracks*sizeof(track_t),.slices_bytes=slices*sizeof(slice_t),
        .history_bytes=slices*c->max_tracks*sizeof(cell_t),.active_events_bytes=c->max_open_events*sizeof(active_t),
        .terminal_events_bytes=c->max_terminal_events*sizeof(cp_v3_temporal_event_t),.history_slices=(uint16_t)slices,.cell_bytes=sizeof(cell_t)};
    return true;
}
cp_v3_temporal_config_t cp_v3_temporal_default_config(void) {
    return(cp_v3_temporal_config_t){.max_tracks=512,.max_open_events=64,.max_terminal_events=64,
        .slice_ms=2000,.history_ms=600000,.gap_ms=10000,.max_event_ms=3600000};
}
size_t cp_v3_temporal_memory_alignment(void) { return _Alignof(max_align_t); }
size_t cp_v3_temporal_memory_bytes(const cp_v3_temporal_config_t *c) { offsets_t o;return layout(c,&o,NULL)?o.total:0; }
bool cp_v3_temporal_memory_layout(const cp_v3_temporal_config_t *c,cp_v3_temporal_memory_t *out) {
    if(!out)return false;
    memset(out,0,sizeof *out);offsets_t o;return layout(c,&o,out);
}
static slice_t *current(cp_v3_temporal_t *s) { return &s->slices[s->current_slice%s->slice_count]; }
static cell_t *cell(cp_v3_temporal_t *s,uint64_t number,uint16_t track) {
    return &s->cells[(number%s->slice_count)*s->config.max_tracks+track];
}
static uint16_t token(const track_t *t) { return (uint16_t)((t->generation-1)%UINT16_MAX+1); }
static void revision(cp_v3_temporal_t *s,active_t *a) {
    (void)s;a->dirty=true;
}
static void emit_revision(cp_v3_temporal_t *s,active_t *a) {
    if(a->value.revision<UINT32_MAX)++a->value.revision;
    else { a->value.quality_mask|=CP_V3_TEMPORAL_REVISION_GAP; ++s->counters.counter_overflows; }
    a->dirty=false;
}
static void reset_history(cp_v3_temporal_t *s,cp_v3_temporal_time_t now) {
    /* Preserve generation counters so stale handles cannot alias across resets. */
    for(uint16_t i=0;i<s->config.max_tracks;++i){uint32_t generation=s->tracks[i].generation;
        memset(&s->tracks[i],0,sizeof s->tracks[i]);s->tracks[i].generation=generation;s->tracks[i].event_slot=NONE;}
    memset(s->slices,0,s->slice_count*sizeof *s->slices);
    memset(s->cells,0,(size_t)s->slice_count*s->config.max_tracks*sizeof *s->cells);
    s->current_slice=now.mono_ms/s->config.slice_ms;s->retained=1;s->now=now;s->known=false;
    *current(s)=(slice_t){.number=s->current_slice,.gap_ms=(uint16_t)(now.mono_ms%s->config.slice_ms)};
}
cp_v3_temporal_result_t cp_v3_temporal_init(void *arena,size_t bytes,const cp_v3_temporal_config_t *c,
    const cp_v3_temporal_context_t *context,cp_v3_temporal_time_t now,cp_v3_temporal_entropy_fn entropy,
    void *entropy_context,cp_v3_temporal_t **out) {
    if(out)*out=NULL;
    offsets_t o;
    if(!out||!arena||(uintptr_t)arena%_Alignof(max_align_t)||!layout(c,&o,NULL)||!context_valid(context)||
        !time_valid(now)||(c->max_open_events&&!entropy))return CP_V3_TEMPORAL_INVALID;
    if(bytes<o.total)return CP_V3_TEMPORAL_NO_MEMORY;
    memset(arena,0,o.total);cp_v3_temporal_t *s=arena;uint8_t *p=arena;
    s->magic=MAGIC;s->next_event_seq=1;s->arena_bytes=o.total;s->config=*c;s->context=*context;
    s->entropy=entropy;s->entropy_context=entropy_context;s->slice_count=(uint16_t)(c->history_ms/c->slice_ms);
    s->tracks=(track_t *)(p+o.tracks);s->slices=(slice_t *)(p+o.slices);s->cells=(cell_t *)(p+o.cells);
    s->active=(active_t *)(p+o.active);s->terminal=(cp_v3_temporal_event_t *)(p+o.terminal);
    reset_history(s,now);*out=s;return CP_V3_TEMPORAL_OK;
}
static cp_v3_temporal_time_t at_time(cp_v3_temporal_time_t end,uint64_t mono) {
    uint64_t delta=end.mono_ms-mono;end.mono_ms=mono;
    if(end.utc_known){if(end.utc_ms<delta){end.utc_known=false;end.utc_ms=end.uncertainty_ms=0;}else end.utc_ms-=delta;}
    return end;
}
static void detach(cp_v3_temporal_t *s,active_t *a) {
    if(a->track_slot<s->config.max_tracks){track_t *t=&s->tracks[a->track_slot];
        if(t->used&&t->generation==a->track_generation&&t->event_slot==(uint16_t)(a-s->active))t->event_slot=NONE;}
}
static bool enqueue_terminal(cp_v3_temporal_t *s,active_t *a) {
    if(s->terminal_count==s->config.max_terminal_events)return false;
    uint16_t at=(uint16_t)((s->terminal_head+s->terminal_count)%s->config.max_terminal_events);
    s->terminal[at]=a->value;++s->terminal_count;detach(s,a);memset(a,0,sizeof *a);return true;
}
static void finish(cp_v3_temporal_t *s,active_t *a,cp_v3_temporal_time_t at,cp_v3_temporal_reason_t reason) {
    if(!a->used||a->pending)return;
    a->value.end=at;a->value.reason=reason;
    a->value.state=reason==CP_V3_TEMPORAL_OBSERVED_GAP?CP_V3_TEMPORAL_CLOSED:CP_V3_TEMPORAL_CENSORED;
    if(a->value.state==CP_V3_TEMPORAL_CENSORED)a->value.quality_mask|=CP_V3_TEMPORAL_IS_CENSORED;
    if(reason==CP_V3_TEMPORAL_SCAN_GAP||reason==CP_V3_TEMPORAL_LATE_REPORT)a->value.quality_mask|=CP_V3_TEMPORAL_SCAN_GAPS;
    if(reason==CP_V3_TEMPORAL_CAPACITY||reason==CP_V3_TEMPORAL_LATE_REPORT)a->value.quality_mask|=CP_V3_TEMPORAL_TABLE_LOSS;
    emit_revision(s,a);detach(s,a);a->pending=true;
    if(!enqueue_terminal(s,a)){if(!s->blocked)++s->counters.backpressure_occurrences;s->blocked=true;s->known=false;}
}
static void censor_all(cp_v3_temporal_t *s,cp_v3_temporal_time_t at,cp_v3_temporal_reason_t reason) {
    for(uint16_t i=0;i<s->config.max_open_events;++i)finish(s,&s->active[i],at,reason);
}
static bool any_open(const cp_v3_temporal_t *s) {
    for(uint16_t i=0;i<s->config.max_open_events;++i)if(s->active[i].used&&!s->active[i].pending)return true;
    return false;
}
static void roll_slice(cp_v3_temporal_t *s) {
    slice_t *old=current(s);
    for(uint16_t i=0;i<s->config.max_open_events;++i){active_t *a=&s->active[i];
        if(!a->used||a->pending)continue;
        if(old->coverage_ms==s->config.slice_ms&&!old->gap_ms&&a->last_present_slice!=s->current_slice&&
            a->last_absent_slice!=s->current_slice&&a->value.start.mono_ms<=s->current_slice*s->config.slice_ms){
            ++a->value.absent_slices;a->last_absent_slice=s->current_slice;revision(s,a);}
    }
    ++s->current_slice;if(s->retained<s->slice_count)++s->retained;
    *current(s)=(slice_t){.number=s->current_slice};
    memset(cell(s,s->current_slice,0),0,(size_t)s->config.max_tracks*sizeof(cell_t));
    uint64_t oldest=(s->current_slice-s->retained+1)*s->config.slice_ms;
    for(uint16_t i=0;i<s->config.max_open_events;++i){active_t *a=&s->active[i];
        if(a->used&&!a->pending&&a->value.start.mono_ms<oldest&&!(a->value.quality_mask&CP_V3_TEMPORAL_HISTORY_TRUNCATED)){
            a->value.quality_mask|=CP_V3_TEMPORAL_HISTORY_TRUNCATED;revision(s,a);}}
}
static bool clock_changed(cp_v3_temporal_time_t old,cp_v3_temporal_time_t now) {
    if(old.clock_epoch!=now.clock_epoch||old.utc_known!=now.utc_known)return true;
    if(!now.utc_known)return false;
    uint64_t delta=now.mono_ms-old.mono_ms;
    if(now.utc_ms<old.utc_ms)return old.utc_ms-now.utc_ms+delta>(uint64_t)old.uncertainty_ms+now.uncertainty_ms;
    uint64_t utc=now.utc_ms-old.utc_ms,difference=utc>delta?utc-delta:delta-utc;
    return difference>(uint64_t)old.uncertainty_ms+now.uncertainty_ms;
}
static void late_gap(cp_v3_temporal_t *s,uint64_t from) {
    uint64_t oldest=s->current_slice-s->retained+1;
    for(uint16_t i=0;i<s->retained;++i){uint64_t number=oldest+i;
        if((number+1)*s->config.slice_ms<=from)continue;
        slice_t *p=&s->slices[number%s->slice_count];p->coverage_ms=0;
        p->gap_ms=(uint16_t)(number==s->current_slice?s->now.mono_ms%s->config.slice_ms:s->config.slice_ms);}
    /* Not-yet-released terminals can still be corrected. A consumer holding an
     * older copy must fail exact revision release and fetch the censored one. */
    for(uint16_t i=0;i<s->terminal_count;++i){cp_v3_temporal_event_t *e=&s->terminal[(s->terminal_head+i)%s->config.max_terminal_events];
        if(e->end.mono_ms<from||e->end.clock_epoch!=s->now.clock_epoch||
            (e->state==CP_V3_TEMPORAL_CENSORED&&e->reason==CP_V3_TEMPORAL_LATE_REPORT))continue;
        e->state=CP_V3_TEMPORAL_CENSORED;e->reason=CP_V3_TEMPORAL_LATE_REPORT;
        e->quality_mask|=CP_V3_TEMPORAL_SCAN_GAPS|CP_V3_TEMPORAL_TABLE_LOSS|CP_V3_TEMPORAL_IS_CENSORED;
        if(e->revision<UINT32_MAX)++e->revision;else e->quality_mask|=CP_V3_TEMPORAL_REVISION_GAP;
    }
    for(uint16_t i=0;i<s->config.max_open_events;++i){active_t *a=&s->active[i];cp_v3_temporal_event_t *e=&a->value;
        if(!a->used||!a->pending||e->end.mono_ms<from||e->end.clock_epoch!=s->now.clock_epoch||
            (e->state==CP_V3_TEMPORAL_CENSORED&&e->reason==CP_V3_TEMPORAL_LATE_REPORT))continue;
        e->state=CP_V3_TEMPORAL_CENSORED;e->reason=CP_V3_TEMPORAL_LATE_REPORT;
        e->quality_mask|=CP_V3_TEMPORAL_SCAN_GAPS|CP_V3_TEMPORAL_TABLE_LOSS|CP_V3_TEMPORAL_IS_CENSORED;emit_revision(s,a);
    }
    s->known=false;censor_all(s,s->now,CP_V3_TEMPORAL_LATE_REPORT);
}
cp_v3_temporal_result_t cp_v3_temporal_advance(cp_v3_temporal_t *s,cp_v3_temporal_time_t target) {
    if(!valid(s)||!time_valid(target))return CP_V3_TEMPORAL_INVALID;
    if(target.mono_ms<s->now.mono_ms){late_gap(s,target.mono_ms);return CP_V3_TEMPORAL_LATE;}
    if(clock_changed(s->now,target))return cp_v3_temporal_boundary(s,target,&s->context,CP_V3_TEMPORAL_CLOCK_CHANGE);
    while(s->now.mono_ms<target.mono_ms){
        /* Once no episode needs cumulative accounting, skip discarded history
         * in O(1). Work remains bounded to retained slices plus event closure. */
        if(!any_open(s)&&target.mono_ms-s->now.mono_ms>s->config.history_ms){
            bool known=s->known;cp_v3_temporal_time_t skip=at_time(target,target.mono_ms-s->config.history_ms);
            s->current_slice=skip.mono_ms/s->config.slice_ms;s->retained=1;s->now=skip;
            memset(s->slices,0,s->slice_count*sizeof *s->slices);memset(s->cells,0,(size_t)s->slice_count*s->config.max_tracks*sizeof *s->cells);
            *current(s)=(slice_t){.number=s->current_slice,.coverage_ms=known?(uint16_t)(skip.mono_ms%s->config.slice_ms):0,
                .gap_ms=known?0:(uint16_t)(skip.mono_ms%s->config.slice_ms)};
        }
        uint64_t next=(s->current_slice+1)*s->config.slice_ms;
        if(next>target.mono_ms)next=target.mono_ms;
        for(uint16_t i=0;i<s->config.max_open_events;++i){active_t *a=&s->active[i];if(!a->used||a->pending)continue;
            uint64_t deadline=a->value.start.mono_ms+s->config.max_event_ms;
            if(s->known&&a->value.last_seen.mono_ms+s->config.gap_ms<deadline)deadline=a->value.last_seen.mono_ms+s->config.gap_ms;
            if(deadline<next)next=deadline;}
        uint64_t delta=next-s->now.mono_ms;slice_t *p=current(s);
        if(s->known)p->coverage_ms+=(uint16_t)delta;else p->gap_ms+=(uint16_t)delta;
        for(uint16_t i=0;i<s->config.max_open_events;++i){active_t *a=&s->active[i];
            if(a->used&&!a->pending&&s->known&&delta){a->value.coverage_ms+=delta;
                a->value.observed_until=at_time(target,next);revision(s,a);}}
        s->now=at_time(target,next);
        /* Count completed slices before terminal closure at the same boundary. */
        if(next==(s->current_slice+1)*s->config.slice_ms)roll_slice(s);
        for(uint16_t i=0;i<s->config.max_open_events;++i){active_t *a=&s->active[i];if(!a->used||a->pending)continue;
            if(next>=a->value.start.mono_ms+s->config.max_event_ms)finish(s,a,s->now,CP_V3_TEMPORAL_TIMEOUT);
            else if(s->known&&next>=a->value.last_seen.mono_ms+s->config.gap_ms)finish(s,a,s->now,CP_V3_TEMPORAL_OBSERVED_GAP);}
        if(s->blocked)censor_all(s,s->now,CP_V3_TEMPORAL_CAPACITY);
    }
    s->now=target;return s->blocked?CP_V3_TEMPORAL_BACKPRESSURE:CP_V3_TEMPORAL_OK;
}
cp_v3_temporal_result_t cp_v3_temporal_set_coverage(cp_v3_temporal_t *s,cp_v3_temporal_time_t at,bool known) {
    cp_v3_temporal_result_t result=cp_v3_temporal_advance(s,at);
    if(result!=CP_V3_TEMPORAL_OK)return result;
    if(!known)censor_all(s,s->now,CP_V3_TEMPORAL_SCAN_GAP);
    s->known=known&&!s->blocked;return s->blocked?CP_V3_TEMPORAL_BACKPRESSURE:CP_V3_TEMPORAL_OK;
}
cp_v3_temporal_result_t cp_v3_temporal_censor(cp_v3_temporal_t *s,cp_v3_temporal_time_t at,cp_v3_temporal_reason_t reason) {
    if(!valid(s)||!time_valid(at)||at.mono_ms<s->now.mono_ms||clock_changed(s->now,at)||
        (reason!=CP_V3_TEMPORAL_TIMEOUT&&reason!=CP_V3_TEMPORAL_CAPACITY&&reason!=CP_V3_TEMPORAL_LEASE_EXPIRED&&
         reason!=CP_V3_TEMPORAL_SCAN_GAP&&reason!=CP_V3_TEMPORAL_LATE_REPORT))return CP_V3_TEMPORAL_INVALID;
    censor_all(s,at,reason);s->known=false;
    return cp_v3_temporal_advance(s,at);
}
static bool key_equal(const track_t *t,uint8_t type,const uint8_t address[6]) {
    return t->used&&t->type==type&&!memcmp(t->address,address,6);
}
bool cp_v3_temporal_lookup(const cp_v3_temporal_t *s,uint8_t type,const uint8_t address[6],cp_v3_temporal_track_t *out) {
    if(!valid(s)||!address||!out)return false;
    for(uint16_t i=0;i<s->config.max_tracks;++i)if(key_equal(&s->tracks[i],type,address)){
        *out=(cp_v3_temporal_track_t){i,s->tracks[i].generation};return true;}
    return false;
}
static bool id_unique(const cp_v3_temporal_t *s,const uint8_t id[16]) {
    for(uint16_t i=0;i<s->config.max_open_events;++i)if(s->active[i].used&&!memcmp(s->active[i].value.event_id,id,16))return false;
    for(uint16_t i=0;i<s->terminal_count;++i)if(!memcmp(s->terminal[(s->terminal_head+i)%s->config.max_terminal_events].event_id,id,16))return false;
    return true;
}
static cp_v3_temporal_result_t start_event(cp_v3_temporal_t *s,uint16_t track) {
    if(!s->config.max_open_events||!s->known){++s->counters.event_suppressed_reports;return CP_V3_TEMPORAL_OK;}
    uint16_t at=NONE,oldest=NONE;
    for(uint16_t i=0;i<s->config.max_open_events;++i){active_t *a=&s->active[i];
        if(!a->used){at=i;break;}if(!a->pending&&(oldest==NONE||a->value.last_seen.mono_ms<s->active[oldest].value.last_seen.mono_ms))oldest=i;}
    if(at==NONE&&oldest!=NONE){++s->counters.event_evictions;finish(s,&s->active[oldest],s->now,CP_V3_TEMPORAL_CAPACITY);if(!s->active[oldest].used)at=oldest;}
    if(s->blocked||at==NONE)return CP_V3_TEMPORAL_BACKPRESSURE;
    if(!s->next_event_seq)return CP_V3_TEMPORAL_EXHAUSTED;
    uint8_t id[16];bool unique=false;
    for(unsigned attempt=0;attempt<4;++attempt){if(!s->entropy(s->entropy_context,id))break;
        id[6]=(id[6]&15)|64;id[8]=(id[8]&63)|128;if(id_unique(s,id)){unique=true;break;}}
    if(!unique){++s->counters.entropy_failures;return CP_V3_TEMPORAL_ENTROPY_FAILED;}
    active_t *a=&s->active[at];memset(a,0,sizeof *a);a->used=true;a->track_slot=track;a->track_generation=s->tracks[track].generation;
    a->last_present_slice=a->last_absent_slice=UINT64_MAX;a->value.event_seq=s->next_event_seq++;
    a->dirty=true;a->value.context=s->context;a->value.state=CP_V3_TEMPORAL_OPEN;a->value.reason=CP_V3_TEMPORAL_SNAPSHOT;
    a->value.start=a->value.last_seen=a->value.observed_until=s->now;memcpy(a->value.event_id,id,16);s->tracks[track].event_slot=at;
    return CP_V3_TEMPORAL_OK;
}
cp_v3_temporal_result_t cp_v3_temporal_report(cp_v3_temporal_t *s,cp_v3_temporal_time_t at,uint8_t type,
    const uint8_t address[6],bool rssi_known,int16_t rssi,cp_v3_temporal_track_t *out) {
    if(out)*out=(cp_v3_temporal_track_t){.slot=NONE};
    if(!valid(s))return CP_V3_TEMPORAL_INVALID;
    if(!address||type>3||!time_valid(at)||(rssi_known&&(rssi< -127||rssi>20))){++s->counters.invalid_reports;return CP_V3_TEMPORAL_INVALID;}
    cp_v3_temporal_result_t result=cp_v3_temporal_advance(s,at);
    if(result!=CP_V3_TEMPORAL_OK){++s->counters.rejected_reports;if(result==CP_V3_TEMPORAL_LATE)++s->counters.late_reports;return result;}
    uint16_t slot=NONE,free_slot=NONE,oldest=NONE;
    for(uint16_t i=0;i<s->config.max_tracks;++i){track_t *t=&s->tracks[i];
        if(key_equal(t,type,address)){slot=i;break;}
        if(!t->used&&free_slot==NONE)free_slot=i;
        if(t->used&&(oldest==NONE||t->last_seen<s->tracks[oldest].last_seen))oldest=i;}
    if(slot==NONE){slot=free_slot==NONE?oldest:free_slot;track_t *t=&s->tracks[slot];
        if(t->generation==UINT32_MAX){++s->counters.rejected_reports;return CP_V3_TEMPORAL_EXHAUSTED;}
        if(t->used){++s->counters.identity_evictions;if(t->event_slot!=NONE)finish(s,&s->active[t->event_slot],s->now,CP_V3_TEMPORAL_CAPACITY);}
        if(s->blocked){++s->counters.rejected_reports;censor_all(s,s->now,CP_V3_TEMPORAL_CAPACITY);return CP_V3_TEMPORAL_BACKPRESSURE;}
        uint32_t generation=t->generation+1;memset(t,0,sizeof *t);t->generation=generation;t->used=true;t->type=type;
        t->event_slot=NONE;t->born_slice=s->current_slice;memcpy(t->address,address,6);
        for(uint16_t i=0;i<s->slice_count;++i)memset(&s->cells[(size_t)i*s->config.max_tracks+slot],0,sizeof(cell_t));
    }
    track_t *t=&s->tracks[slot];t->last_seen=at.mono_ms;
    cell_t *c=cell(s,s->current_slice,slot);if(c->generation!=token(t)){memset(c,0,sizeof *c);c->generation=token(t);}
    if(c->reports==UINT16_MAX){++s->counters.counter_overflows;++s->counters.rejected_reports;
        if(t->event_slot!=NONE)finish(s,&s->active[t->event_slot],s->now,CP_V3_TEMPORAL_CAPACITY);
        return CP_V3_TEMPORAL_EXHAUSTED;}
    ++c->reports;++s->counters.reports;
    if(rssi_known){if(!c->rssi_n)c->min=c->max=(int8_t)rssi;
        if(rssi<c->min)c->min=(int8_t)rssi;
        if(rssi>c->max)c->max=(int8_t)rssi;
        ++c->rssi_n;c->sum+=rssi;}
    if(out)*out=(cp_v3_temporal_track_t){slot,t->generation};
    if(t->event_slot==NONE){result=start_event(s,slot);if(result!=CP_V3_TEMPORAL_OK){++s->counters.event_suppressed_reports;
            if(s->blocked)censor_all(s,s->now,CP_V3_TEMPORAL_CAPACITY);
            return result;}}
    if(t->event_slot!=NONE){active_t *a=&s->active[t->event_slot];
        /* Keep report + millisecond coverage revisions below uint32 exhaustion
         * throughout the maximum one-day episode. Never wrap a wire revision. */
        if(a->value.reports>=EVENT_REPORT_LIMIT){++s->counters.counter_overflows;++s->counters.event_suppressed_reports;
            finish(s,a,s->now,CP_V3_TEMPORAL_CAPACITY);return CP_V3_TEMPORAL_EXHAUSTED;}
        ++a->value.reports;a->value.last_seen=at;a->value.observed_until=at;
        if(a->last_present_slice!=s->current_slice){++a->value.present_slices;a->last_present_slice=s->current_slice;}
        if(rssi_known){if(!a->value.rssi_n)a->value.rssi_min=a->value.rssi_max=(int8_t)rssi;
            if(rssi<a->value.rssi_min)a->value.rssi_min=(int8_t)rssi;
            if(rssi>a->value.rssi_max)a->value.rssi_max=(int8_t)rssi;
            ++a->value.rssi_n;a->value.rssi_sum+=rssi;}revision(s,a);}
    return CP_V3_TEMPORAL_OK;
}
cp_v3_temporal_result_t cp_v3_temporal_boundary(cp_v3_temporal_t *s,cp_v3_temporal_time_t at,
    const cp_v3_temporal_context_t *context,cp_v3_temporal_reason_t reason) {
    if(!valid(s)||!time_valid(at)||!context_valid(context)||reason<CP_V3_TEMPORAL_CLOCK_CHANGE||reason>CP_V3_TEMPORAL_LEASE_EXPIRED)return CP_V3_TEMPORAL_INVALID;
    if(at.mono_ms<s->now.mono_ms&&reason!=CP_V3_TEMPORAL_CLOCK_CHANGE&&reason!=CP_V3_TEMPORAL_REBOOT)return CP_V3_TEMPORAL_LATE;
    /* Boundaries censor BEFORE advancing, so an unobserved interval cannot be
     * turned into an ordinary completed gap by the act of changing context. */
    cp_v3_temporal_time_t end=s->now;
    if(reason!=CP_V3_TEMPORAL_CLOCK_CHANGE&&reason!=CP_V3_TEMPORAL_REBOOT&&at.clock_epoch==s->now.clock_epoch)end=at;
    censor_all(s,end,reason);s->context=*context;reset_history(s,at);
    return s->blocked?CP_V3_TEMPORAL_BACKPRESSURE:CP_V3_TEMPORAL_OK;
}
uint16_t cp_v3_temporal_history_count(const cp_v3_temporal_t *s) { return valid(s)?s->retained:0; }
cp_v3_temporal_result_t cp_v3_temporal_history_at(const cp_v3_temporal_t *s,cp_v3_temporal_track_t handle,
    uint16_t index,cp_v3_temporal_history_t *out) {
    if(!valid(s)||!out||handle.slot>=s->config.max_tracks||index>=s->retained)return CP_V3_TEMPORAL_INVALID;
    const track_t *t=&s->tracks[handle.slot];if(!t->used||t->generation!=handle.generation)return CP_V3_TEMPORAL_NOT_FOUND;
    memset(out,0,sizeof *out);uint64_t number=s->current_slice-s->retained+1+index;
    const slice_t *p=&s->slices[number%s->slice_count];const cell_t *c=&s->cells[(number%s->slice_count)*s->config.max_tracks+handle.slot];
    out->slice_start_mono_ms=number*s->config.slice_ms;out->slice_end_mono_ms=out->slice_start_mono_ms+s->config.slice_ms;
    out->coverage_ms=p->coverage_ms;out->gap_ms=p->gap_ms;out->finalized=number<s->current_slice;out->before_tracking=number<t->born_slice;
    if(!out->before_tracking&&c->generation==token(t)){out->reports=c->reports;out->rssi_n=c->rssi_n;out->rssi_sum=c->sum;out->rssi_min=c->min;out->rssi_max=c->max;out->counter_saturated=c->reports==UINT16_MAX;}
    out->presence=out->reports?CP_V3_TEMPORAL_PRESENT:(!out->before_tracking&&out->finalized&&p->coverage_ms==s->config.slice_ms&&!p->gap_ms?CP_V3_TEMPORAL_ABSENT:CP_V3_TEMPORAL_UNKNOWN);
    return CP_V3_TEMPORAL_OK;
}
cp_v3_temporal_result_t cp_v3_temporal_event_at(const cp_v3_temporal_t *s,uint16_t slot,cp_v3_temporal_event_t *out) {
    if(!valid(s)||!out||slot>=s->config.max_open_events)return CP_V3_TEMPORAL_INVALID;
    if(!s->active[slot].used)return CP_V3_TEMPORAL_NOT_FOUND;
    *out=s->active[slot].value;return CP_V3_TEMPORAL_OK;
}
cp_v3_temporal_result_t cp_v3_temporal_event_publish(cp_v3_temporal_t *s,uint16_t slot,cp_v3_temporal_event_t *out) {
    if(!valid(s)||!out||slot>=s->config.max_open_events)return CP_V3_TEMPORAL_INVALID;
    active_t *a=&s->active[slot];if(!a->used||a->pending)return CP_V3_TEMPORAL_NOT_FOUND;
    if(a->dirty||!a->value.revision)emit_revision(s,a);
    *out=a->value;return CP_V3_TEMPORAL_OK;
}
cp_v3_temporal_result_t cp_v3_temporal_terminal_peek(const cp_v3_temporal_t *s,cp_v3_temporal_event_t *out) {
    if(!valid(s)||!out)return CP_V3_TEMPORAL_INVALID;
    if(!s->terminal_count)return CP_V3_TEMPORAL_NOT_FOUND;
    *out=s->terminal[s->terminal_head];return CP_V3_TEMPORAL_OK;
}
cp_v3_temporal_result_t cp_v3_temporal_terminal_release(cp_v3_temporal_t *s,const uint8_t id[16],uint32_t seq,uint32_t rev) {
    if(!valid(s)||!id)return CP_V3_TEMPORAL_INVALID;
    if(!s->terminal_count)return CP_V3_TEMPORAL_NOT_FOUND;
    cp_v3_temporal_event_t *e=&s->terminal[s->terminal_head];
    if(memcmp(e->event_id,id,16)||e->event_seq!=seq||e->revision!=rev)return CP_V3_TEMPORAL_INVALID;
    memset(e,0,sizeof *e);s->terminal_head=(uint16_t)((s->terminal_head+1)%s->config.max_terminal_events);--s->terminal_count;
    s->blocked=false;
    for(uint16_t i=0;i<s->config.max_open_events;++i)if(s->active[i].used&&s->active[i].pending){
        if(!enqueue_terminal(s,&s->active[i]))s->blocked=true;}
    return CP_V3_TEMPORAL_OK;
}
void cp_v3_temporal_status(const cp_v3_temporal_t *s,cp_v3_temporal_status_t *out) {
    if(!out)return;
    memset(out,0,sizeof *out);if(!valid(s))return;*out=s->counters;
    for(uint16_t i=0;i<s->config.max_tracks;++i)if(s->tracks[i].used)++out->tracks;
    for(uint16_t i=0;i<s->config.max_open_events;++i)if(s->active[i].used){if(s->active[i].pending)++out->pending_terminals;else ++out->open_events;}
    out->terminal_events=s->terminal_count;out->history_slices=s->retained;out->coverage_known=s->known;out->blocked=s->blocked;
}
void cp_v3_temporal_clear(cp_v3_temporal_t *s) {
    if(!valid(s))return;
    size_t n=s->arena_bytes;volatile uint8_t *p=(volatile uint8_t *)s;while(n--)*p++=0;
}
