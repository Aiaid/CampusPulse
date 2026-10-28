#pragma once
#include <stdbool.h>
#include <stdint.h>
typedef struct {
    uint64_t at_us,main_run,mqtt_run,snapshot_wall_us,snapshot_read_us;
    uint32_t main_id,mqtt_id;
    bool main_present,mqtt_present;
} probe_cpu_point_t;
typedef struct {
    uint64_t main_us,mqtt_us,interval_us;
    unsigned known,main_reason,mqtt_reason;
    bool mqtt_new;
} probe_cpu_delta_t;
/* Reasons: 0 known; 1 absent; 2 identity changed; 3 counter backwards;
 * 4 clock invalid. U64 is required: do not infer modulo/wrapped CPU time. */
static inline unsigned probe_cpu_counter(bool before_present,bool after_present,
    uint32_t before_id,uint32_t after_id,uint64_t before,uint64_t after,uint64_t *delta)
{
    if(!before_present||!after_present)return 1;
    if(before_id!=after_id)return 2;
    if(after<before)return 3;
    *delta=after-before;return 0;
}
static inline probe_cpu_delta_t probe_cpu_delta(const probe_cpu_point_t *before,
    const probe_cpu_point_t *after,bool mqtt,bool new_mqtt_allowed)
{
    probe_cpu_delta_t d={0};
    if(after->at_us<=before->at_us){d.main_reason=d.mqtt_reason=4;return d;}
    d.interval_us=after->at_us-before->at_us;
    d.main_reason=probe_cpu_counter(before->main_present,after->main_present,
        before->main_id,after->main_id,before->main_run,after->main_run,&d.main_us);
    if(!d.main_reason)d.known|=1;
    d.mqtt_reason=1;
    if(mqtt){
        if(new_mqtt_allowed&&!before->mqtt_present&&after->mqtt_present){
            d.mqtt_us=after->mqtt_run;d.mqtt_new=true;d.mqtt_reason=0;
        }else d.mqtt_reason=probe_cpu_counter(before->mqtt_present,after->mqtt_present,
            before->mqtt_id,after->mqtt_id,before->mqtt_run,after->mqtt_run,&d.mqtt_us);
        if(!d.mqtt_reason)d.known|=2;
    }
    return d;
}
