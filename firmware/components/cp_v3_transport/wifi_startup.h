#pragma once
#include <stdbool.h>
#include <stdint.h>

enum {
    V3_WIFI_EVENT_STARTED=1u,V3_WIFI_EVENT_CONNECTED=2u,
    V3_WIFI_EVENT_DISCONNECTED=4u,V3_WIFI_EVENT_GOT_IP=8u,V3_WIFI_EVENT_LOST_IP=16u,
    V3_WIFI_EVENT_CONNECT_ATTEMPT=32u,V3_WIFI_EVENT_TIMEOUT=64u,V3_WIFI_EVENT_CANCELLED=128u
};
typedef struct {uint32_t events,disconnect_seq,reason;bool ip_acquired;} v3_wifi_snapshot_t;
typedef struct {
    void *context;
    uint64_t (*now)(void *);
    bool (*active)(void *);
    v3_wifi_snapshot_t (*snapshot)(void *);
    int (*connect)(void *);
    void (*pause)(void *,uint32_t);
    void (*notice)(void *,uint32_t,uint32_t,unsigned,uint64_t,bool);
} v3_wifi_startup_io_t;
typedef enum {V3_WIFI_READY,V3_WIFI_CANCELLED,V3_WIFI_TIMEOUT,V3_WIFI_CONNECT_FAILED,V3_WIFI_INVALID} v3_wifi_startup_result_t;
typedef struct {v3_wifi_startup_result_t result;int connect_error;unsigned attempts;} v3_wifi_startup_outcome_t;
static inline bool v3_wifi_startup_options_valid(uint32_t timeout,unsigned retries,uint32_t delay){
    return timeout>=1000&&timeout<=180000&&retries<=3&&(!retries||(delay&&delay<=30000));
}
/* Only the owner invokes connect/pause/notice. Event callbacks merely publish
 * snapshots. A disconnect schedules one bounded retry, never a new deadline. */
static inline v3_wifi_startup_outcome_t v3_wifi_startup_wait(const v3_wifi_startup_io_t *io,
    uint32_t timeout,unsigned retries,uint32_t delay){
    v3_wifi_startup_outcome_t out={V3_WIFI_INVALID,0,0};
    if(!io||!io->now||!io->active||!io->snapshot||!io->connect||!io->pause||!io->notice||
       !v3_wifi_startup_options_valid(timeout,retries,delay))return out;
    uint64_t began=io->now(io->context),last=began,retry_at=0;
    if(began>UINT64_MAX-timeout)return out;
    uint64_t deadline=began+timeout;uint32_t seen=0;bool scheduled=false,initial=true;
    for(;;){
        uint64_t now=io->now(io->context);
        if(!io->active(io->context)){
            io->notice(io->context,V3_WIFI_EVENT_CANCELLED,0,out.attempts,now>=began?now-began:0,false);
            out.result=V3_WIFI_CANCELLED;return out;
        }
        if(now<last){out.result=V3_WIFI_INVALID;return out;}last=now;
        v3_wifi_snapshot_t s=io->snapshot(io->context);
        if(s.events)io->notice(io->context,s.events,s.reason,out.attempts,now-began,s.ip_acquired);
        if(!io->active(io->context)){out.result=V3_WIFI_CANCELLED;return out;}
        now=io->now(io->context);
        if(now<last){out.result=V3_WIFI_INVALID;return out;}last=now;
        if(now>=deadline){
            io->notice(io->context,V3_WIFI_EVENT_TIMEOUT,s.reason,out.attempts,now-began,s.ip_acquired);
            out.result=V3_WIFI_TIMEOUT;return out;
        }
        if(!initial&&s.ip_acquired){out.result=V3_WIFI_READY;return out;}
        if(s.disconnect_seq!=seen){
            seen=s.disconnect_seq;
            if(!initial&&!scheduled&&out.attempts<=retries){scheduled=true;retry_at=now+delay;}
        }
        if(initial||(scheduled&&now>=retry_at)){
            initial=false;scheduled=false;
            if(!io->active(io->context)){out.result=V3_WIFI_CANCELLED;return out;}
            /* No logging/callback between this last deadline check and connect. */
            now=io->now(io->context);
            if(now>=deadline){out.result=V3_WIFI_TIMEOUT;return out;}
            out.attempts++;
            out.connect_error=io->connect(io->context);
            if(!io->active(io->context)){out.result=V3_WIFI_CANCELLED;return out;}
            now=io->now(io->context);
            io->notice(io->context,V3_WIFI_EVENT_CONNECT_ATTEMPT,0,out.attempts,now>=began?now-began:0,false);
            if(now>=deadline){out.result=V3_WIFI_TIMEOUT;return out;}
            if(out.connect_error){out.result=V3_WIFI_CONNECT_FAILED;return out;}
            continue;
        }
        uint64_t remaining=deadline-now;
        uint32_t sleep=remaining<10?(uint32_t)remaining:10;
        if(scheduled&&retry_at>now&&retry_at-now<sleep)sleep=(uint32_t)(retry_at-now);
        io->pause(io->context,sleep);
    }
}
