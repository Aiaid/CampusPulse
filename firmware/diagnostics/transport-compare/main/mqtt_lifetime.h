#pragma once
#include <stdbool.h>
#include <stddef.h>
#define PROBE_MQTT_LIFETIME_VERSION 1

/* The lease and callback userdata must have static lifetime. A failed/unknown
 * stop never licenses destroy: pinned ESP-MQTT destroy ignores stop failure. */
typedef struct { void *client,*queue; bool started,retained; } probe_mqtt_lease_t;
typedef struct {
    int (*stop_confirm)(void *client);
    int (*destroy)(void *client);
    void (*delete_queue)(void *queue);
} probe_mqtt_lifetime_ops_t;
static inline int probe_mqtt_release(probe_mqtt_lease_t *lease,const probe_mqtt_lifetime_ops_t *ops)
{
    if(lease->retained)return -1;
    if(lease->client&&lease->started){
        int result=ops->stop_confirm(lease->client);
        if(result){lease->retained=true;return result;}
        lease->started=false;
    }
    if(lease->client){
        int result=ops->destroy(lease->client);
        if(result){lease->retained=true;return result;}
        lease->client=NULL;
    }
    if(lease->queue){ops->delete_queue(lease->queue);lease->queue=NULL;}
    return 0;
}
