#include <assert.h>
#include <stddef.h>
#include <stdio.h>
#include "mqtt_lifetime.h"
static unsigned stops,destroys,deletes,callbacks;
static int stop_result,destroy_result;
static int stop(void *p){assert(p);stops++;return stop_result;}
static int destroy(void *p){assert(p);destroys++;return destroy_result;}
static void delete_queue(void *p){assert(p);deletes++;}
static const probe_mqtt_lifetime_ops_t ops={stop,destroy,delete_queue};
static struct { unsigned alive; } callback_state;
static void late_callback(void){assert(callback_state.alive);callbacks++;}
static void reset(void){stops=destroys=deletes=callbacks=0;stop_result=destroy_result=0;callback_state.alive=1;}
int main(void)
{
    reset();probe_mqtt_lease_t a={.client=&callback_state,.queue=&callbacks,.started=true};
    stop_result=0x101;assert(probe_mqtt_release(&a,&ops)==0x101);
    assert(stops==1&&!destroys&&!deletes&&a.started&&a.retained&&a.client&&a.queue);
    late_callback();assert(callbacks==1);assert(probe_mqtt_release(&a,&ops)==-1);assert(stops==1);
    reset();probe_mqtt_lease_t b={.client=&callback_state,.queue=&callbacks,.started=true};
    assert(!probe_mqtt_release(&b,&ops));assert(stops==1&&destroys==1&&deletes==1&&!b.client&&!b.queue&&!b.started);
    reset();probe_mqtt_lease_t c={.client=&callback_state,.queue=&callbacks,.started=false};
    assert(!probe_mqtt_release(&c,&ops));assert(!stops&&destroys==1&&deletes==1);
    reset();probe_mqtt_lease_t d={.client=&callback_state,.queue=&callbacks,.started=true};
    destroy_result=0x102;assert(probe_mqtt_release(&d,&ops)==0x102);
    assert(stops==1&&destroys==1&&!deletes&&!d.started&&d.retained&&d.client&&d.queue);
    reset();probe_mqtt_lease_t e={.queue=&callbacks};assert(!probe_mqtt_release(&e,&ops));
    assert(!stops&&!destroys&&deletes==1);
    puts("MQTT stop-failure retention, no premature destroy/free, late callback and successful release pass");
}
