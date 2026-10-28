#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include "cpu_math.h"
int main(void)
{
    probe_cpu_point_t a={.at_us=100,.main_run=10,.main_id=1,.main_present=true,
        .mqtt_run=30,.mqtt_id=5,.mqtt_present=true},b=a;
    b.at_us=300;b.main_run=50;b.mqtt_run=80;
    probe_cpu_delta_t d=probe_cpu_delta(&a,&b,true,false);
    assert(d.known==3&&d.main_us==40&&d.mqtt_us==50&&d.interval_us==200&&!d.mqtt_new);
    b.mqtt_id=6;d=probe_cpu_delta(&a,&b,true,false);assert(d.known==1&&d.mqtt_reason==2);
    b.mqtt_id=5;b.mqtt_run=0;d=probe_cpu_delta(&a,&b,true,false);assert(d.known==1&&d.mqtt_reason==3);
    b=a;b.at_us=99;d=probe_cpu_delta(&a,&b,true,false);assert(!d.known&&d.main_reason==4);
    b=a;b.at_us=100;d=probe_cpu_delta(&a,&b,true,false);assert(!d.known);
    b=a;b.at_us=300;b.main_run=0;d=probe_cpu_delta(&a,&b,false,false);assert(!d.known&&d.main_reason==3);
    b=a;b.at_us=300;b.main_present=false;d=probe_cpu_delta(&a,&b,true,false);assert(d.known==2&&d.main_reason==1);
    a.mqtt_present=false;b=a;b.at_us=300;b.mqtt_present=true;b.mqtt_id=9;b.mqtt_run=70;
    d=probe_cpu_delta(&a,&b,true,true);assert(d.known==3&&d.mqtt_new&&d.mqtt_us==70);
    d=probe_cpu_delta(&a,&b,true,false);assert(d.known==1&&d.mqtt_reason==1);
    a.main_run=UINT64_MAX-1;b=a;b.at_us=500;b.main_run=2;
    d=probe_cpu_delta(&a,&b,false,false);assert(!d.known&&d.main_reason==3);
    puts("CPU counter deltas, absent/recreated tasks, new MQTT task and clock/counter wrap rejection pass");
}
