#pragma once
#include "cp_v3_control.h"
#include "cp_v3_temporal.h"
#include "cp_v3_queue.h"
#include "cp_settings.h"
#include <limits.h>
#include <string.h>
#define TE_SMALL_BODY 1024u
#define TE_SMALL_WORKING 4194304u
/* Logical accounting ceilings, not measured physical flash writes or network
 * traffic. Allow one 60-second window plus a 40-second lease cadence throughout
 * the day, including conservative NVS reservation overhead and restart room. */
#define TE_SMALL_STORAGE_DAY (192u * 1024u * 1024u)
#define TE_SMALL_UPLINK_DAY (8u * 1024u * 1024u)
#define TE_SMALL_REFRESH_MS 1200000u
/* ESP-IDF5.5.3 MQTT3.1.1 CONNACK4/5 are bad credentials/not authorized;
 * server-unavailable3 remains retryable. No client-provided status invents ACK. */
static inline bool te_small_identity_denied(int http_status,int mqtt_connect_code){
    return http_status==401||http_status==403||mqtt_connect_code==4||mqtt_connect_code==5;
}
/* Continuous application cycles stop the scanner after complete full windows,
 * avoiding a newly opened partial handoff at a planned real-boot boundary. */
static inline uint32_t te_small_capture_windows(unsigned requested,uint32_t window_ms){
    if(requested)return requested<=3?requested:0;
    return (window_ms==30000||window_ms==60000)?TE_SMALL_REFRESH_MS/window_ms:0;
}
static inline bool te_small_cycle_complete(unsigned requested,uint32_t current_acked,
    uint32_t planned_windows,bool status_acked,bool retry_verified){
    return status_acked&&current_acked==planned_windows&&planned_windows&&
        (requested?requested<=3&&planned_windows==requested&&retry_verified:true);
}
static inline bool te_small_restart_safe(bool network_stopped,bool capture_quiescent,
    unsigned handoffs,bool frozen_volatile,bool write_uncertain,unsigned corrupt,unsigned retired){
    return network_stopped&&capture_quiescent&&!handoffs&&!frozen_volatile&&!write_uncertain&&!corrupt&&!retired;
}
/* Same destination profile as the Waveshare runtime. This selects only the
 * configured deadline; shared transport still validates the origin and TLS. */
static inline uint32_t te_small_request_timeout_ms(const char *origin){
    return origin&&!strcmp(origin,CP_API_ORIGIN)?30000u:15000u;
}
/* Store load0 is positive absence; load3 is a fully validated committed
 * tombstone with no surviving old source. load2/4 and I/O are not free space. */
static inline bool te_small_slot_reusable(cp_v3_queue_state_t state,int loaded){
    return state==CP_V3_QUEUE_FREE&&(loaded==0||loaded==3);
}
static inline bool te_small_clock_at(cp_v3_time_t a,uint64_t mono,cp_v3_temporal_time_t *out) {
    if(!out||!a.clock_epoch||!a.utc_ms||mono<a.mono_ms)return false;
    uint64_t delta=mono-a.mono_ms;
    if(delta>UINT64_MAX-1999u)return false;
    uint64_t growth=(delta+1999u)/2000u;
    if(delta>UINT64_MAX-a.utc_ms||growth>UINT32_MAX-a.uncertainty_ms||a.uncertainty_ms+growth>5000u)return false;
    *out=(cp_v3_temporal_time_t){mono,a.utc_ms+delta,a.clock_epoch,(uint32_t)(a.uncertainty_ms+growth),true};return true;
}
static inline bool te_small_scope(const cp_v3_scope_t *a,const cp_v3_scope_t *b) {
    return a->assignment_generation==b->assignment_generation&&
        !strcmp(a->node_id,b->node_id)&&!strcmp(a->boot_id,b->boot_id)&&
        !strcmp(a->placement_id,b->placement_id)&&!strcmp(a->policy_id,b->policy_id)&&
        !strcmp(a->policy_sha256,b->policy_sha256)&&!strcmp(a->dataset,b->dataset);
}
static inline bool te_small_policy(const cp_v3_trial_policy_t *p) {
    return p&&p->statistics&&!p->tf_queue&&!p->local_raw.enabled&&!p->candidate_events&&
        p->stats_max_addresses&&p->stats_max_addresses<=512&&p->bin_ms==5000&&
        (p->window_ms==30000||p->window_ms==60000)&&p->max_body_bytes==TE_SMALL_BODY&&
        p->queue_max_bytes==3072&&p->queue_max_items==3&&p->window_reserve_items==1&&
        p->status_reserve_items==1&&p->control_reserve_items==1&&!p->event_reserve_items&&
        p->window_reserve_bytes==1024&&p->status_reserve_bytes==1024&&p->control_reserve_bytes==1024&&
        !p->event_reserve_bytes&&p->working_bytes<=TE_SMALL_WORKING&&
        p->storage_write_bytes_per_day<=TE_SMALL_STORAGE_DAY&&p->max_upload_bytes_per_day<=TE_SMALL_UPLINK_DAY&&
        p->retry_max_attempts>=2&&(!p->temporal.rolling||
        (p->temporal.slice_ms==2000&&p->temporal.history_ms<=600000&&p->temporal.max_tracks<=512&&
         p->temporal.max_open_events<=64&&p->temporal.max_event_ms<=3600000&&
         p->temporal.report_mode==CP_V3_TEMPORAL_REPORT_OFF));
}
static inline bool te_small_expiry(cp_v3_temporal_time_t end,uint32_t duration,uint32_t hours,
                                  uint64_t accept_until,uint64_t *expiry) {
    uint64_t age=(uint64_t)hours*3600000u;
    if(!expiry||!end.utc_known||!hours||end.utc_ms<(uint64_t)duration+end.uncertainty_ms)return false;
    uint64_t start=end.utc_ms-duration-end.uncertainty_ms;
    if(start>UINT64_MAX-age)return false;
    *expiry=start+age;if(*expiry>accept_until)*expiry=accept_until;return *expiry!=0;
}
