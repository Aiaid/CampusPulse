#include "page_status.h"
#include "ui_mini.h"
#include "font_zh.h"
#include <stddef.h>
#include <stdio.h>
#include <string.h>

/* One transient row projection, never a retained string/framebuffer cache.
 * Paint and damage comparison use exactly the same bounded, fitted text. */
typedef struct { char text[64]; int16_t x, y; uint16_t color; } text_projection_t;

static void fit_text(text_projection_t *p)
{
    size_t n = 0;
    while (n < sizeof p->text - 1 && p->text[n]) {
        unsigned char c = (unsigned char)p->text[n];
        p->text[n++] = c >= 32 && c <= 126 ? (char)c : '?';
    }
    p->text[n] = 0;
    if (!n) { memcpy(p->text, "--", 3); return; }
    const int width = UI_W - 12 - p->x;
    if (ui_text_width(p->text) > width) {
        while (n && ui_text_width(p->text) + ui_text_width("...") > width)
            p->text[--n] = 0;
        memcpy(p->text + n, "...", 4);
    }
}

static void bounded_value(text_projection_t *p, const char *value, size_t capacity)
{
    size_t n = 0;
    p->x = 24;
    p->color = UI_COL_FG;
    while (n < capacity && n < 31 && value[n]) {
        p->text[n] = value[n];
        n++;
    }
    p->text[n] = 0;
}

static const char *upload_result(cp_debug_upload_result_t result)
{
    switch (result) {
    case CP_DEBUG_UPLOAD_ACKED: return "ACK verified";
    case CP_DEBUG_UPLOAD_RETRY: return "retry failed";
    case CP_DEBUG_UPLOAD_REJECTED: return "rejected";
    case CP_DEBUG_UPLOAD_AUTH: return "auth failed";
    case CP_DEBUG_UPLOAD_POLICY: return "policy failed";
    case CP_DEBUG_UPLOAD_BAD_ACK: return "bad ACK";
    default: return "idle / no result";
    }
}

static unsigned chart_bins(const cp_debug_domain_t *d)
{
    return d->bin_count > CP_DEBUG_DOMAIN_BINS ? CP_DEBUG_DOMAIN_BINS : d->bin_count;
}
static uint32_t chart_peak(const cp_debug_domain_t *d)
{
    uint32_t peak = 0;
    if (d->known)
        for (unsigned i = 0; i < chart_bins(d); i++)
            if (d->bin_reports[i] > peak) peak = d->bin_reports[i];
    return peak;
}
static unsigned chart_height(uint32_t count, uint32_t peak)
{
    if (!count || !peak) return 0;
    unsigned height = (unsigned)(((uint64_t)count * 34) / peak);
    return height ? height : 1;
}

static bool setup_row(const cp_status_view_t *v, unsigned row, text_projection_t *p)
{
#define TEXT(y_, color_, ...) do { p->y=(y_); p->color=(color_); \
    snprintf(p->text,sizeof p->text,__VA_ARGS__); } while (0)
    switch (row) {
    case 0: TEXT(6, UI_COL_TEAL, "USB setup"); break;
    case 1: TEXT(36, UI_COL_MUTED, "Node"); break;
    case 2: p->y=56; bounded_value(p,v->node_id,sizeof v->node_id); break;
    case 3: TEXT(92, UI_COL_FG, "Connect USB cable"); break;
    case 4: TEXT(120, UI_COL_FG, "Open setup in admin"); break;
    case 5: TEXT(176, UI_COL_MUTED, "State"); break;
    case 6: p->y=196; bounded_value(p,v->setup_state,sizeof v->setup_state); break;
    case 7: TEXT(282, UI_COL_MUTED, "Hold OK: resume"); break;
    default: return false;
    }
    return true;
}

/* Clamp inconsistent telemetry before subtraction; unknown totals stay unknown. */
static uint32_t heap_used(const cp_debug_snapshot_t *d)
{
    return d->heap_internal_total > d->heap_internal_free
        ? d->heap_internal_total - d->heap_internal_free : 0;
}
#define HEAP_BAR_X 116
#define HEAP_BAR_SPAN (UI_W - 12 - HEAP_BAR_X)

static bool debug_row(const cp_status_view_t *v, unsigned row, text_projection_t *p)
{
    const cp_debug_snapshot_t *d=&v->debug;
    const cp_debug_upload_t *u=&d->upload;
    switch (row) {
    case 0: TEXT(4, UI_COL_TEAL, "1/4 DEBUG UP/DOWN"); break;
    case 1:
        if (d->wifi_connected) TEXT(26, UI_COL_FG, "SSID: %.32s",d->wifi_ssid);
        else TEXT(26, UI_COL_ORANGE, "Wi-Fi disconnected");
        break;
    case 2:
        if (d->wifi_connected && d->wifi_rssi_known)
            TEXT(48, UI_COL_SOFT, "%ddBm PHY:%.20s",(int)d->wifi_rssi_dbm,
                 d->wifi_phy_known?d->wifi_phy:"--");
        else TEXT(48, UI_COL_SOFT, "--dBm PHY:%.20s",
                  d->wifi_connected&&d->wifi_phy_known?d->wifi_phy:"--");
        break;
    case 3:
        if (d->wifi_connected && d->wifi_mbps_known)
            TEXT(70, UI_COL_MUTED, "Link %lu Mb/s",(unsigned long)d->wifi_mbps);
        else TEXT(70, UI_COL_MUTED, "Link -- Mb/s");
        break;
    case 4:
        if (d->heap_known) TEXT(92, UI_COL_FG, "Heap free %lu/%lu KiB",
            (unsigned long)(d->heap_internal_free/1024),(unsigned long)(d->heap_internal_total/1024));
        else TEXT(92, UI_COL_FG, "Heap free --/-- KiB");
        break;
    case 5:
        if (d->heap_known && d->heap_internal_total)
            TEXT(114, UI_COL_SOFT, "Used %lu%%",
                 (unsigned long)((uint64_t)heap_used(d)*100/d->heap_internal_total));
        else TEXT(114, UI_COL_SOFT, "Used --%%");
        break;
    case 6:
        if (d->heap_known) TEXT(136, UI_COL_MUTED, "Blk%luK BootMin%luK",
            (unsigned long)(d->heap_internal_largest/1024),(unsigned long)(d->heap_boot_min_8bit/1024));
        else TEXT(136, UI_COL_MUTED, "Blk--K BootMin--K");
        break;
    case 7:
        if (d->queue_known) TEXT(158, UI_COL_FG, "Q %lu/%lu slots%s",
            (unsigned long)d->queue_pending,(unsigned long)d->queue_capacity,d->queue_quarantined?" !":"");
        else TEXT(158, UI_COL_FG, "Q --/-- slots");
        if (d->queue_quarantined) p->color=UI_COL_ORANGE;
        break;
    case 8:
        TEXT(186, UI_COL_FG, "UP %s",u->in_flight?"sending":u->known?upload_result(u->result):"idle / no result");
        if (u->known && u->result!=CP_DEBUG_UPLOAD_ACKED && u->result!=CP_DEBUG_UPLOAD_NONE)
            p->color=UI_COL_ORANGE;
        break;
    case 9:
        if (u->known && u->goodput_known && u->result==CP_DEBUG_UPLOAD_ACKED) {
            unsigned long tenths=(unsigned long)(((uint64_t)u->goodput_bytes_per_sec*10)/1024);
            TEXT(208, UI_COL_SOFT, "%s %lu.%luKiB/s %lus%s",!d->wifi_connected?"Off":u->last_age_ms>30000?"Old":"Last",
                tenths/10,tenths%10,(unsigned long)(u->last_age_ms/1000>999?999:u->last_age_ms/1000),
                u->last_age_ms/1000>999?"+":"");
        } else if (u->known) TEXT(208, UI_COL_SOFT, "Last -- KiB/s %lus%s",
            (unsigned long)(u->last_age_ms/1000>999?999:u->last_age_ms/1000),u->last_age_ms/1000>999?"+":"");
        else TEXT(208, UI_COL_SOFT, "Last -- KiB/s age --");
        break;
    case 10:
        if (u->known) TEXT(230, UI_COL_MUTED, "HTTP %ld Err %ld",(long)u->last_http_status,(long)u->last_error);
        else TEXT(230, UI_COL_MUTED, "HTTP -- Err --");
        break;
    case 11:
        TEXT(252, UI_COL_SOFT, "BLE %s A%lu S%lu R%lu",d->ble_memory_paused?"mem":d->ble_pressure_paused?"hold":
            d->ble_raw_paused?"raw":d->ble_collecting?"on":"off",(unsigned long)d->aggregation_drops,
            (unsigned long)d->summary_drops,(unsigned long)d->raw_drops);
        if (d->aggregation_drops||d->summary_drops||d->raw_drops||d->storage_drops||d->windows_dropped)
            p->color=UI_COL_ORANGE;
        break;
    case 12: TEXT(274, UI_COL_SOFT, "Auth: %.24s",v->authentication); break;
    case 13: TEXT(296, UI_COL_SOFT, "Collect: %.24s",v->collection); break;
    default: return false;
    }
    return true;
}

static void slice_projection(const cp_debug_domain_t *d, text_projection_t *p)
{
    if (d->known) TEXT(48, UI_COL_MUTED, "Slice %lu %s",(unsigned long)d->window_seq,d->window_partial?"partial":"sealed");
    else TEXT(48, UI_COL_MUTED, "Slice unavailable");
}
static void count_projection(text_projection_t *p, int y, const char *label, uint32_t count, bool known)
{
    if (known) TEXT(y, UI_COL_FG, "%s %lu",label,(unsigned long)count);
    else TEXT(y, UI_COL_FG, "%s --",label);
}
static bool footer_row(const cp_status_view_t *v, unsigned row, text_projection_t *p)
{
    switch (row) {
    case 0: TEXT(246, UI_COL_SOFT, "State: %.24s",v->collection); break;
    case 1: TEXT(268, UI_COL_MUTED, "UP/DOWN: pages"); break;
    case 2: TEXT(290, UI_COL_MUTED, "Hold OK: setup"); break;
    default: return false;
    }
    return true;
}
static void age_projection(const cp_debug_domain_t *d, text_projection_t *p, int y)
{
    if (d->known) TEXT(y, UI_COL_MUTED, "Age %lus Window %lus",(unsigned long)(d->age_ms/1000),(unsigned long)(d->window_ms/1000));
    else TEXT(y, UI_COL_MUTED, "Age -- Window --");
}
static bool activity_row(const cp_status_view_t *v, unsigned row, text_projection_t *p)
{
    const cp_debug_snapshot_t *debug=&v->debug;
    const cp_debug_domain_t *d=&debug->domain;
    switch (row) {
    case 0: TEXT(4, UI_COL_TEAL, "2/4 BLE activity"); break;
    case 1: TEXT(26, UI_COL_ORANGE, "Reports, not people"); break;
    case 2: slice_projection(d,p); break;
    case 3: age_projection(d,p,70); break;
    case 4:
        if (d->known) TEXT(92, UI_COL_FG, "Seen %lu Agg %lu",(unsigned long)d->reports_seen,(unsigned long)d->reports_aggregated);
        else TEXT(92, UI_COL_FG, "Seen -- Agg --");
        break;
    case 5:
        if (d->known) TEXT(114, UI_COL_SOFT, "Addr %lu%s",(unsigned long)d->addresses,d->address_overflow?" OVERFLOW":"");
        else TEXT(114, UI_COL_SOFT, "Addr --");
        if (d->address_overflow) p->color=UI_COL_ORANGE;
        break;
    case 6:
        if (d->known && chart_bins(d)) TEXT(136, UI_COL_MUTED, "Bins %lums Peak %lu",(unsigned long)d->bin_ms,(unsigned long)chart_peak(d));
        else TEXT(136, UI_COL_MUTED, "Report bins --");
        break;
    case 7:
        if (d->known) TEXT(202, UI_COL_MUTED, "Loss A%lu S%lu",(unsigned long)d->aggregation_drops,(unsigned long)d->summary_drops);
        else TEXT(202, UI_COL_MUTED, "Loss A-- S--");
        break;
    case 8: TEXT(224, UI_COL_SOFT, "Boot RX%lu W%lu",(unsigned long)debug->reports_total,(unsigned long)debug->windows_total); break;
    default: return row>=9 ? footer_row(v,row-9,p) : false;
    }
    return true;
}
static bool vehicle_row(const cp_status_view_t *v, unsigned row, text_projection_t *p)
{
    const cp_debug_domain_t *d=&v->debug.domain;
    switch (row) {
    case 0: TEXT(4, UI_COL_TEAL, "3/4 E-bike evidence"); break;
    case 1: TEXT(26, UI_COL_ORANGE, "Candidates, not truth"); break;
    case 2: slice_projection(d,p); break;
    case 3:
        if (d->known) TEXT(70, UI_COL_MUTED, "Age%lus Addr%lu%s",(unsigned long)(d->age_ms/1000),(unsigned long)d->addresses,d->address_overflow?" OVF":"");
        else TEXT(70, UI_COL_MUTED, "Age -- Addr --");
        break;
    case 4: count_projection(p,92,"Candidates",d->vehicle_candidates,d->known); break;
    case 5: count_projection(p,114,"Brand names",d->vehicle_name_addresses,d->known); break;
    case 6: count_projection(p,136,"Ecosystem",d->vehicle_ecosystem_addresses,d->known); break;
    case 7: count_projection(p,158,"Excluded",d->vehicle_excluded_addresses,d->known); break;
    case 8: count_projection(p,180,"Parsed reports",d->vehicle_parsed_reports,d->known); break;
    case 9: count_projection(p,202,"Malformed",d->vehicle_malformed_reports,d->known); break;
    case 10: TEXT(224, UI_COL_ORANGE, "No local classifier"); break;
    default: return row>=11 ? footer_row(v,row-11,p) : false;
    }
    return true;
}
static bool elevator_row(const cp_status_view_t *v, unsigned row, text_projection_t *p)
{
    const cp_debug_snapshot_t *debug=&v->debug;
    const cp_debug_domain_t *d=&debug->domain;
    switch (row) {
    case 0: TEXT(4, UI_COL_TEAL, "4/4 Elevator debug"); break;
    case 1: TEXT(26, UI_COL_ORANGE, "Wait: -- (no model)"); break;
    case 2: TEXT(48, UI_COL_MUTED, "RSSI slice inputs"); break;
    case 3: TEXT(70, UI_COL_MUTED, "dBm min / avg / max"); break;
    case 4:
        if (d->known && d->rssi_samples) TEXT(92, UI_COL_FG, "%d / %d / %d",d->rssi_min,d->rssi_mean,d->rssi_max);
        else TEXT(92, UI_COL_FG, "-- / -- / --");
        break;
    case 5: count_projection(p,114,"Samples",d->rssi_samples,d->known); break;
    case 6: age_projection(d,p,136); break;
    case 7: TEXT(158, UI_COL_FG, "%s",!debug->clock_trusted?"Clock unknown":debug->clock_estimated?"Clock estimated":"Clock trusted"); break;
    case 8:
        if (debug->clock_trusted) TEXT(180, UI_COL_MUTED, "Epoch %lu Est%lums",(unsigned long)debug->clock_epoch,(unsigned long)debug->clock_uncertainty_ms);
        else TEXT(180, UI_COL_MUTED, "Epoch -- Est --");
        break;
    case 9: count_projection(p,202,"Boot summaries",debug->summaries_total,true); break;
    case 10: TEXT(224, UI_COL_SOFT, "UP %s",debug->upload.in_flight?"sending":debug->upload.known?upload_result(debug->upload.result):"idle / no result"); break;
    default: return row>=11 ? footer_row(v,row-11,p) : false;
    }
    return true;
}
#undef TEXT

static bool project_row(const cp_status_view_t *v, unsigned row, text_projection_t *p)
{
    p->x=12;
    bool exists;
    if (v->setup_active) exists=setup_row(v,row,p);
    else switch (v->page) {
    case CP_DEVICE_PAGE_ACTIVITY: exists=activity_row(v,row,p); break;
    case CP_DEVICE_PAGE_VEHICLE: exists=vehicle_row(v,row,p); break;
    case CP_DEVICE_PAGE_ELEVATOR: exists=elevator_row(v,row,p); break;
    default: exists=debug_row(v,row,p); break;
    }
    if (exists) fit_text(p);
    return exists;
}

/* -1 is the neutral unknown-denominator track; all other values are the exact
 * filled pixel width. Equal rounded widths do not damage a bar. */
static int bar_width(uint32_t used, uint32_t capacity, bool known, int span)
{
    if (!known || !capacity) return -1;
    if (used>capacity) used=capacity;
    return (int)(((uint64_t)used*span)/capacity);
}
static void usage_bar(int x0, int y, int span, int width, uint16_t color)
{
    ui_fill(x0,y,span,4,UI_COL_LINE);
    if (width<0) {
        for (int x=x0;x<x0+span;x+=8) ui_fill(x,y+1,4,2,UI_COL_MUTED);
    } else if (width) ui_fill(x0,y,width,4,color);
}
static bool debug_page(const cp_status_view_t *v)
{
    return !v->setup_active && v->page!=CP_DEVICE_PAGE_ACTIVITY &&
        v->page!=CP_DEVICE_PAGE_VEHICLE && v->page!=CP_DEVICE_PAGE_ELEVATOR;
}
static void paint_status(void *arg)
{
    const cp_status_view_t *v=arg;
    ui_clear(UI_COL_BG);
    text_projection_t row;
    for (unsigned i=0;project_row(v,i,&row);i++) ui_text(row.x,row.y,row.text,row.color);
    const cp_debug_snapshot_t *d=&v->debug;
    if (debug_page(v)) {
        usage_bar(HEAP_BAR_X,122,HEAP_BAR_SPAN,bar_width(heap_used(d),d->heap_internal_total,d->heap_known,HEAP_BAR_SPAN),UI_COL_TEAL);
        usage_bar(12,180,UI_W-24,bar_width(d->queue_pending,d->queue_capacity,d->queue_known,UI_W-24),UI_COL_YELLOW);
    } else if (!v->setup_active && v->page==CP_DEVICE_PAGE_ACTIVITY) {
        const cp_debug_domain_t *slice=&d->domain;
        const unsigned bins=chart_bins(slice);
        const uint32_t peak=chart_peak(slice);
        ui_fill(12,194,UI_W-24,1,UI_COL_LINE);
        if (bins && peak) {
            const int pitch=(UI_W-24)/(int)bins;
            for (unsigned i=0;i<bins;i++) {
                unsigned height=chart_height(slice->bin_reports[i],peak);
                if (height) ui_fill(12+(int)i*pitch,194-(int)height,pitch-2,(int)height,UI_COL_TEAL);
            }
        }
    }
}

void status_page_render(const cp_status_view_t *snapshot)
{
    if (snapshot) ui_render((ui_rect_t){0,0,UI_W,UI_H},paint_status,(void *)snapshot);
}

/* Damage is an 80-band bitset (12 bytes), not a row-string or pixel cache.
 * Two transient projections + plan are 152 bytes; merging needs no rect array. */
typedef struct { uint32_t bands[3]; } damage_t;
_Static_assert(sizeof(damage_t)+2*sizeof(text_projection_t)<=192,"bounded damage plan");
static void damage_rows(damage_t *damage, int y, int height)
{
    int first=y/4,last=(y+height+3)/4;
    if (first<0) first=0;
    if (last>UI_H/4) last=UI_H/4;
    for (int band=first;band<last;band++) damage->bands[band/32]|=UINT32_C(1)<<(band%32);
}
static bool damaged(const damage_t *d,unsigned band)
{
    return (d->bands[band/32]&(UINT32_C(1)<<(band%32)))!=0;
}
static bool same_chart(const cp_debug_domain_t *a,const cp_debug_domain_t *b)
{
    uint32_t ap=chart_peak(a),bp=chart_peak(b);
    if (!ap || !bp) return ap==bp; // Both empty/unknown draw only the baseline.
    if (chart_bins(a)!=chart_bins(b)) return false;
    for (unsigned i=0;i<chart_bins(a);i++)
        if (chart_height(a->bin_reports[i],ap)!=chart_height(b->bin_reports[i],bp)) return false;
    return true;
}
static unsigned setup_mode(const cp_status_view_t *v)
{
    return v->setup_active ? 1 : 0;
}
void status_page_render_diff(const cp_status_view_t *next,const cp_status_view_t *previous)
{
    if (!next) return;
    if (!previous || setup_mode(next)!=setup_mode(previous) ||
        (!next->setup_active && next->page!=previous->page)) {
        status_page_render(next);
        return;
    }
    if (!memcmp(next,previous,sizeof *next)) return;
    damage_t damage={{0}};
    text_projection_t before,after;
    for (unsigned i=0;project_row(next,i,&after);i++) {
        if (!project_row(previous,i,&before) || after.x!=before.x || after.y!=before.y ||
            after.color!=before.color || strcmp(after.text,before.text))
            damage_rows(&damage,after.y,FONT_ZH_CELL);
    }
    if (debug_page(next)) {
        const cp_debug_snapshot_t *a=&next->debug,*b=&previous->debug;
        if (bar_width(heap_used(a),a->heap_internal_total,a->heap_known,HEAP_BAR_SPAN)!=
            bar_width(heap_used(b),b->heap_internal_total,b->heap_known,HEAP_BAR_SPAN)) damage_rows(&damage,122,4);
        if (bar_width(a->queue_pending,a->queue_capacity,a->queue_known,UI_W-24)!=
            bar_width(b->queue_pending,b->queue_capacity,b->queue_known,UI_W-24)) damage_rows(&damage,180,4);
    } else if (!next->setup_active && next->page==CP_DEVICE_PAGE_ACTIVITY &&
               !same_chart(&next->debug.domain,&previous->debug.domain)) damage_rows(&damage,160,35);
    for (unsigned band=0;band<UI_H/4;) {
        if (!damaged(&damage,band)) { band++; continue; }
        unsigned first=band++;
        while (band<UI_H/4 && damaged(&damage,band)) band++;
        ui_render((ui_rect_t){0,(int16_t)(first*4),UI_W,(int16_t)((band-first)*4)},paint_status,(void *)next);
    }
}
