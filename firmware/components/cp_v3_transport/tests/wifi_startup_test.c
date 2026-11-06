/* Exact owner loop; virtual time/event snapshots and mocked SDK connect only. */
#include "../wifi_startup.h"
#include <assert.h>
#include <stdio.h>
typedef struct {
    uint64_t now,ip_at,disconnect_at,connect_ms,connect_times[4];
    uint32_t seq;
    unsigned connects,disconnects,pauses,notices,cancel_at_connect;
    bool cancelled,disconnect_each,disconnect_sent,cancel_in_pause,cancel_in_notice;
    int connect_error;
} fixture_t;
static uint64_t now(void *p){return ((fixture_t *)p)->now;}
static bool active(void *p){return !((fixture_t *)p)->cancelled;}
static v3_wifi_snapshot_t snapshot(void *p){
    fixture_t *f=p;uint32_t events=0;
    if(f->connects&&(f->disconnect_each||f->disconnect_at)&&f->now>=f->disconnect_at&&(f->disconnect_each||!f->disconnect_sent)){
        f->seq++;f->disconnects++;events=V3_WIFI_EVENT_DISCONNECTED;f->disconnect_sent=true;
    }
    bool ip=f->ip_at&&f->now>=f->ip_at;
    return (v3_wifi_snapshot_t){events,f->seq,202,ip};
}
static int connect_wifi(void *p){
    fixture_t *f=p;assert(!f->cancelled&&f->connects<4);
    f->connect_times[f->connects++]=f->now;f->now+=f->connect_ms;
    if(f->connects==f->cancel_at_connect)f->cancelled=true;
    return f->connect_error;
}
static void pause_ms(void *p,uint32_t delay){
    fixture_t *f=p;assert(delay&&delay<=10);f->pauses++;f->now+=delay;if(f->cancel_in_pause)f->cancelled=true;
}
static void notice(void *p,uint32_t event,uint32_t reason,unsigned attempt,uint64_t elapsed,bool ip){
    fixture_t *f=p;(void)event;(void)reason;(void)ip;assert(attempt==f->connects&&elapsed==f->now);f->notices++;
    if(f->cancel_in_notice)f->cancelled=true;
}
static v3_wifi_startup_outcome_t run(fixture_t *f,uint32_t timeout,unsigned retries,uint32_t delay){
    v3_wifi_startup_io_t io={f,now,active,snapshot,connect_wifi,pause_ms,notice};
    return v3_wifi_startup_wait(&io,timeout,retries,delay);
}
int main(void){
    assert(v3_wifi_startup_options_valid(180000,3,3000));
    assert(v3_wifi_startup_options_valid(30000,0,0));
    assert(!v3_wifi_startup_options_valid(180001,3,3000));
    assert(!v3_wifi_startup_options_valid(999,0,0));
    assert(!v3_wifi_startup_options_valid(180000,4,3000));
    assert(!v3_wifi_startup_options_valid(180000,3,0));
    assert(!v3_wifi_startup_options_valid(180000,3,30001));
    fixture_t f={.ip_at=179990};v3_wifi_startup_outcome_t out=run(&f,180000,3,3000);
    assert(out.result==V3_WIFI_READY&&f.connects==1&&f.now==179990);
    f=(fixture_t){.disconnect_each=true};out=run(&f,180000,3,3000);
    assert(out.result==V3_WIFI_TIMEOUT&&f.now==180000&&f.connects==4);
    for(unsigned i=0;i<4;i++)assert(f.connect_times[i]==i*3000);
    f=(fixture_t){.disconnect_each=true};out=run(&f,30000,0,0);
    assert(out.result==V3_WIFI_TIMEOUT&&f.now==30000&&f.connects==1); /* legacy default */
    f=(fixture_t){.disconnect_at=179000};out=run(&f,180000,3,3000);
    assert(out.result==V3_WIFI_TIMEOUT&&f.now==180000&&f.connects==1); /* no retry beyond deadline */
    f=(fixture_t){.ip_at=180000};out=run(&f,180000,3,3000);
    assert(out.result==V3_WIFI_TIMEOUT&&f.now==180000); /* late DHCP grants no success */
    f=(fixture_t){.connect_ms=180000,.ip_at=1};out=run(&f,180000,3,3000);
    assert(out.result==V3_WIFI_TIMEOUT&&f.connects==1&&!f.pauses); /* slow SDK call cannot reset deadline */
    f=(fixture_t){.cancelled=true};out=run(&f,180000,3,3000);
    assert(out.result==V3_WIFI_CANCELLED&&!f.connects);
    f=(fixture_t){.cancel_at_connect=1};out=run(&f,180000,3,3000);
    assert(out.result==V3_WIFI_CANCELLED&&f.connects==1&&!f.pauses);
    f=(fixture_t){.cancel_in_pause=true};out=run(&f,180000,3,3000);
    assert(out.result==V3_WIFI_CANCELLED&&f.connects==1&&f.pauses==1);
    f=(fixture_t){.cancel_in_notice=true,.disconnect_each=true};out=run(&f,180000,3,3000);
    assert(out.result==V3_WIFI_CANCELLED&&f.connects==1);
    f=(fixture_t){.connect_error=123};out=run(&f,180000,3,3000);
    assert(out.result==V3_WIFI_CONNECT_FAILED&&out.connect_error==123&&f.connects==1&&!f.pauses);
    f=(fixture_t){.disconnect_at=10,.ip_at=1000};out=run(&f,180000,3,3000);
    assert(out.result==V3_WIFI_READY&&f.connects==1&&f.now==1000); /* DHCP beats delayed retry */
    puts("Wi-Fi startup: bounded owner retries, zero-retry default, absolute deadline and cancellation passed");
}
