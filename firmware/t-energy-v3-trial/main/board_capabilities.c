#include "board_capabilities.h"
#include "board_report.h"
#include "cp_v3_control.h"
#include "cp_v3_stats.h"
#include <stdio.h>
#include <string.h>

#define BYTES_MAX UINT64_C(1099511627776)
#define DATE_MAX UINT64_C(253402300799999)
/* Same conservative floor as the NVS adapter, with all three maximum-size
 * records (2048 bytes each), blob overhead and GC headroom. Not a reservation. */
#define NVS_PROFILE_ENTRIES (128u + 3u * (2048u / 32u + 4u))

static bool id(const char *s,size_t capacity) {
    const char *end=memchr(s,0,capacity);
    if(!end || end==s || (size_t)(end-s)>64) return false;
    for(size_t i=0;i<(size_t)(end-s);i++)
        if(!((s[i]>='a'&&s[i]<='z')||(s[i]>='0'&&s[i]<='9')||
             (i&&(s[i]=='_'||s[i]=='-')))) return false;
    return true;
}
static bool uuid(const char s[37]) {
    if(s[36] || s[14]!='4' || !strchr("89ab",s[19]) || !s[19]) return false;
    for(unsigned i=0;i<36;i++) {
        if(i==8||i==13||i==18||i==23) { if(s[i]!='-') return false; }
        else if(!s[i] || !strchr("0123456789abcdef",s[i])) return false;
    }
    return true;
}
static bool leap(unsigned y) { return !(y%4)&&(y%100||!(y%400)); }
static bool date(uint64_t ms,char out[25]) {
    if(ms>DATE_MAX) return false;
    uint64_t days=ms/86400000u; unsigned y=1970,m=1;
    while(days>=(uint64_t)(leap(y)?366:365)) { days-=leap(y)?366u:365u; y++; }
    const unsigned md[]={31,28,31,30,31,30,31,31,30,31,30,31};
    while(days>=md[m-1]+(unsigned)(m==2&&leap(y))) { days-=md[m-1]+(unsigned)(m==2&&leap(y)); m++; }
    unsigned remainder=(unsigned)(ms%86400000u);
    return snprintf(out,25,"%04u-%02u-%02uT%02u:%02u:%02u.%03uZ",y,m,
        (unsigned)days+1,remainder/3600000u,(remainder/60000u)%60u,
        (remainder/1000u)%60u,remainder%1000u)==24;
}
static bool arena(const void *p,size_t bytes,size_t required,size_t alignment,
                  const te_v3_capability_evidence_t *e) {
    return p && required && bytes>=required && !((uintptr_t)p%alignment) &&
        e->external(p,e->external_context);
}
static bool separate(const void *a,size_t an,const void *b,size_t bn) {
    uintptr_t x=(uintptr_t)a,y=(uintptr_t)b;
    if(an>UINTPTR_MAX-x || bn>UINTPTR_MAX-y) return false;
    return x+an<=y || y+bn<=x;
}
static bool evidence(const te_v3_capability_request_t *r,uint64_t lower,uint64_t upper) {
    const te_v3_capability_evidence_t *e=r->evidence;
    if(!e || !e->external || !e->arenas_initialized_verified || e->measured_at_utc_ms>lower ||
       e->measured_at_utc_ms>r->issued_at_utc_ms ||
       e->valid_until_utc_ms<r->expires_at_utc_ms || upper>=e->valid_until_utc_ms ||
       !e->cpu_profile_verified || !e->scanner_profile_verified ||
       !e->measured_cpu_us_per_window || !e->cpu_budget_us_per_window ||
       e->measured_cpu_us_per_window>e->cpu_budget_us_per_window ||
       e->cpu_budget_us_per_window>(uint64_t)r->max_window_ms*1000u ||
       !e->queue_recovery_verified || !e->queue_power_loss_verified || !e->queue_budget_is_not_physical_reservation ||
       e->free_queue_slots<TE_V3_CAPABILITY_QUEUE_ITEMS ||
       e->queue_body_budget_bytes<TE_V3_CAPABILITY_QUEUE_BYTES ||
       e->queue_item_budget<TE_V3_CAPABILITY_QUEUE_ITEMS ||
       e->available_nvs_entries<NVS_PROFILE_ENTRIES ||
       !e->working_budget_bytes || e->working_budget_bytes>BYTES_MAX ||
       !e->storage_write_budget_bytes_per_day || e->storage_write_budget_bytes_per_day>BYTES_MAX ||
       !e->internal_headroom_bytes || e->internal_free_bytes<e->internal_headroom_bytes ||
       !e->psram_headroom_bytes || e->psram_free_bytes<e->psram_headroom_bytes) return false;
    if(!e->report_slots || e->report_slots>SIZE_MAX/sizeof(te_v3_report_t)) return false;
    size_t reports=e->report_slots*sizeof(te_v3_report_t),stats=cp_v3_stats_memory_bytes(r->max_addresses);
    if(!arena(e->pools.reports,e->allocated.reports,reports,_Alignof(te_v3_report_t),e) ||
       !arena(e->pools.stats,e->allocated.stats,stats,cp_v3_stats_memory_alignment(),e) ||
       !separate(e->pools.reports,e->allocated.reports,e->pools.stats,e->allocated.stats)) return false;
    size_t temporal=0;
    if(r->temporal) {
        cp_v3_temporal_memory_t layout;
        if(!r->temporal->max_open_events || r->temporal->max_open_events>r->temporal->max_tracks) return false;
        if(!cp_v3_temporal_memory_layout(r->temporal,&layout)) return false;
        temporal=layout.total_bytes;
        if(!arena(e->pools.temporal,e->allocated.temporal,temporal,cp_v3_temporal_memory_alignment(),e) ||
           !separate(e->pools.temporal,e->allocated.temporal,e->pools.reports,e->allocated.reports) ||
           !separate(e->pools.temporal,e->allocated.temporal,e->pools.stats,e->allocated.stats)) return false;
        /* The backend/shared control's conservative cross-ABI policy floor is
         * intentionally independent of the exact local ABI arena query. */
        uint64_t floor=(uint64_t)r->temporal->max_tracks*
            ((uint64_t)(r->temporal->history_ms/r->temporal->slice_ms)*24u+64u)+
            (uint64_t)r->temporal->max_open_events*128u;
        if(e->working_budget_bytes<floor) return false;
    } else if(e->pools.temporal || e->allocated.temporal) return false;
    if(e->allocated.reports>SIZE_MAX-e->allocated.stats ||
       e->allocated.reports+e->allocated.stats>SIZE_MAX-e->allocated.temporal) return false;
    uint64_t allocated=(uint64_t)e->allocated.reports+e->allocated.stats+e->allocated.temporal;
    uint64_t extra=e->psram_free_bytes-e->psram_headroom_bytes;
    return e->working_budget_bytes>=allocated && e->working_budget_bytes-allocated<=extra;
}

te_v3_capability_result_t te_v3_capabilities_build(const te_v3_capability_request_t *r,
    uint64_t lower,uint64_t upper,char *out,size_t capacity,size_t *length) {
    if(length) *length=0;
    if(out&&capacity) out[0]=0;
    if(!r || !out || !capacity || !length || lower>upper || upper>DATE_MAX ||
       !id(r->node_id,sizeof r->node_id) || !id(r->capability_id,sizeof r->capability_id) || !uuid(r->boot_id) ||
       r->issued_at_utc_ms>lower || upper>=r->expires_at_utc_ms ||
       r->issued_at_utc_ms>=r->expires_at_utc_ms || r->expires_at_utc_ms>DATE_MAX ||
       !r->max_addresses || r->max_addresses>512 || !r->max_bins || r->max_bins>12 ||
       (r->max_window_ms!=30000 && r->max_window_ms!=60000) || r->max_bins<r->max_window_ms/5000u ||
       r->min_scan_interval_units<4 || r->max_scan_interval_units>16384 ||
       r->min_scan_interval_units>r->max_scan_interval_units) return TE_V3_CAPABILITIES_INVALID;
    if(!evidence(r,lower,upper)) return TE_V3_CAPABILITIES_UNPROVEN;
    char issued[25],expires[25],temporal[384]="";
    if(!date(r->issued_at_utc_ms,issued)||!date(r->expires_at_utc_ms,expires)) return TE_V3_CAPABILITIES_INVALID;
    if(r->temporal) {
        const cp_v3_temporal_config_t *t=r->temporal;
        int n=snprintf(temporal,sizeof temporal,",\"temporal\":{\"slice_ms\":[%u],\"max_history_ms\":%u,"
            "\"max_tracks\":%u,\"max_open_events\":%u,\"max_event_ms\":%u,"
            "\"event_schemas\":[\"candidate-event/1\"],\"report_modes\":[\"off\"]}",
            (unsigned)t->slice_ms,(unsigned)t->history_ms,(unsigned)t->max_tracks,
            (unsigned)t->max_open_events,(unsigned)t->max_event_ms);
        if(n<0 || (size_t)n>=sizeof temporal) return TE_V3_CAPABILITIES_NO_SPACE;
    }
    int n=snprintf(out,capacity,"{\"schema\":\"device-capabilities/1\",\"capability_id\":\"%s\","
        "\"node_id\":\"%s\",\"boot_id\":\"%s\",\"producer_version\":\"%s\",\"policy_schemas\":[\"device-config/3\"],"
        "\"issued_at\":\"%s\",\"expires_at\":\"%s\",\"scanner\":{\"modes\":[\"passive\"],\"phys\":[\"1m\"],"
        "\"duplicate_filter\":[false],\"min_interval_units\":%u,\"max_interval_units\":%u},"
        "\"summary\":{\"max_addresses\":%u,\"max_bins\":%u,\"max_window_ms\":%u},"
        "\"statistics\":{\"schemas\":[\"window-statistics/1\"],\"extractor_versions\":[\"cp-v3-stats/1\"],"
        "\"ruleset_versions\":[\"unclassified-v1\"]}%s,\"local_raw\":null,"
        "\"uplink\":{\"transports\":[\"https\"],\"streams\":[\"window_statistics\",\"node_status\"],\"max_batch_items\":1,"
        "\"max_body_bytes\":1024,\"max_sample_reports_per_window\":0,\"cpraw_archive\":false},"
        "\"queue\":{\"media\":[{\"medium\":\"flash_journal\",\"usable_bytes\":3072,\"max_items\":3,\"power_loss_recovery\":true}]},"
        "\"resources\":{\"max_working_bytes\":%llu,\"max_storage_write_bytes_per_day\":%llu,\"tf_usable_bytes\":null}}",
        r->capability_id,r->node_id,r->boot_id,CP_V3_SMALL_PRODUCER,issued,expires,
        (unsigned)r->min_scan_interval_units,(unsigned)r->max_scan_interval_units,
        (unsigned)r->max_addresses,(unsigned)r->max_bins,(unsigned)r->max_window_ms,temporal,
        (unsigned long long)r->evidence->working_budget_bytes,
        (unsigned long long)r->evidence->storage_write_budget_bytes_per_day);
    if(n<0 || (size_t)n>=capacity || (size_t)n>=CP_V3_CONTROL_CAP_MAX) {
        out[0]=0; return TE_V3_CAPABILITIES_NO_SPACE;
    }
    *length=(size_t)n;
    return TE_V3_CAPABILITIES_OK;
}
