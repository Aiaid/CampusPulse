#include "mqtt_rpc.h"
#include <assert.h>
#include <stdio.h>
static const char topic[]="cp/v1/test/00000000-0000-4000-8000-000000000001/rep/ingest/1";
static const unsigned char reply[]={0,200,'{','"','a','"',':','1','}'};
static void packet(cp_mqtt_rpc_t *s){cp_mqtt_rpc_data(s,topic,sizeof(topic)-1,reply,sizeof(reply),0,sizeof(reply),0,false);}
static unsigned stops,destroys;static int stop_error,destroy_error;
static int stop(void *p){assert(p);++stops;return stop_error;}
static int destroy(void *p){assert(p);++destroys;return destroy_error;}
int main(void)
{
    assert(cp_mqtt_uri_valid("wss://gateway.example/mqtt"));
    assert(cp_mqtt_uri_valid("wss://gateway.example:443/mqtt"));
    const char *invalid[]={"ws://gateway.example/mqtt","wss://x:0/mqtt","wss://x:99999/mqtt",
        "wss://token@gateway.example/mqtt","wss://x/mqtt?token=secret","wss://x/mqtt#x","wss:///mqtt",
        "wss://x/mqtt/","wss://x\r\n/mqtt","wss://x:/mqtt"};
    for(unsigned i=0;i<sizeof(invalid)/sizeof(*invalid);++i)assert(!cp_mqtt_uri_valid(invalid[i]));
    assert(cp_mqtt_native_uri_valid("mqtts://broker.example"));
    assert(cp_mqtt_native_uri_valid("mqtts://Broker-123.example:8883"));
    assert(cp_mqtt_native_uri_valid("mqtts://b:65535"));
    const char *native_invalid[]={NULL,"","mqtt://broker.example","wss://broker.example/mqtt",
        "mqtts://user:secret@broker.example","mqtts://broker.example/","mqtts://broker.example/mqtt",
        "mqtts://broker.example?token=secret","mqtts://broker.example#secret","mqtts://",
        "mqtts://:8883","mqtts://broker:0","mqtts://broker:65536","mqtts://broker:999999999999999999999",
        "mqtts://broker:","mqtts://broker:+8883","mqtts://broker:8883:8883","mqtts://127.0.0.1",
        "mqtts://[::1]","mqtts://-broker.example","mqtts://broker-.example","mqtts://broker..example",
        "mqtts://.broker.example","mqtts://broker.example.","mqtts://broker_example",
        "mqtts://broker\r\n.example","mqtts://broker example"};
    for(unsigned i=0;i<sizeof(native_invalid)/sizeof(*native_invalid);++i)
        assert(!cp_mqtt_native_uri_valid(native_invalid[i]));
    char dns_uri[280]="mqtts://";memset(dns_uri+8,'a',63);strcpy(dns_uri+71,".example");
    assert(cp_mqtt_native_uri_valid(dns_uri));dns_uri[71]='a';assert(!cp_mqtt_native_uri_valid(dns_uri));
    for(unsigned n=0;n<4;++n){memset(dns_uri+8+n*64,'a',63);dns_uri[8+n*64+63]='.';}
    dns_uri[8+253]=0;assert(cp_mqtt_native_uri_valid(dns_uri));
    dns_uri[8+253]='a';dns_uri[8+254]=0;assert(!cp_mqtt_native_uri_valid(dns_uri));
    assert(!cp_mqtt_credential_valid(NULL,128)&&!cp_mqtt_credential_valid("",128));
    assert(!cp_mqtt_credential_valid("bad\nsecret",128)&&!cp_mqtt_credential_valid("bad\177secret",128));
    assert(cp_mqtt_credential_valid("synthetic !@#$%",128));
    char credential[CP_MQTT_PASSWORD_MAX+2];memset(credential,'x',sizeof(credential));
    credential[CP_MQTT_PASSWORD_MAX]=0;
    assert(cp_mqtt_credential_valid(credential,CP_MQTT_PASSWORD_MAX));
    credential[CP_MQTT_PASSWORD_MAX]='x';credential[CP_MQTT_PASSWORD_MAX+1]=0;
    assert(!cp_mqtt_credential_valid(credential,CP_MQTT_PASSWORD_MAX));
    assert(cp_mqtt_cold_budget(CP_MQTT_COLD_FREE,CP_MQTT_COLD_LARGEST));
    assert(!cp_mqtt_cold_budget(CP_MQTT_COLD_FREE-1,CP_MQTT_COLD_LARGEST));
    assert(!cp_mqtt_cold_budget(CP_MQTT_COLD_FREE,CP_MQTT_COLD_LARGEST-1));
    assert(cp_mqtt_hot_budget(32000,CP_MQTT_HOT_LARGEST,8192));
    assert(!cp_mqtt_hot_budget(30000,4096,0));
    assert(!cp_mqtt_hot_budget(30000,4436,0));
    assert(!cp_mqtt_hot_budget(30000,CP_MQTT_HOT_LARGEST-1,0));
    assert(cp_mqtt_hot_budget(30000,CP_MQTT_HOT_LARGEST,0));
    assert(!cp_mqtt_hot_budget(22000,10000,8192));
    assert(!cp_mqtt_hot_budget(30000,8192,8192));
    assert(!cp_mqtt_hot_budget(SIZE_MAX,SIZE_MAX,SIZE_MAX));
    assert(!cp_mqtt_allocation_budget(30000,10000,8193)); /* Both body copies. */
    assert(cp_mqtt_allocation_budget(40000,CP_MQTT_HOT_LARGEST,8193));
    /* Frozen 3.75 KiB body: caller copy + outbox + max RX + reply/reserve. */
    size_t floor=3841u+3840u+CP_MQTT_PACKET_ALLOWANCE+CP_MQTT_HOT_RESERVE+CP_MQTT_REPLY_MAX+1u;
    assert(floor==30466u);
    assert(cp_mqtt_allocation_budget(floor,CP_MQTT_HOT_LARGEST,3841));
    assert(!cp_mqtt_allocation_budget(floor-1u,CP_MQTT_HOT_LARGEST,3841));
    assert(!cp_mqtt_allocation_budget(SIZE_MAX,SIZE_MAX,SIZE_MAX));
    cp_mqtt_rpc_t s={0};
    /* Every split exercises status-prefix and payload fragment boundaries. */
    for(size_t split=0;split<=sizeof(reply);++split){
        assert(cp_mqtt_rpc_begin(&s,topic));
        cp_mqtt_rpc_data(&s,topic,sizeof(topic)-1,reply,(int)split,0,sizeof(reply),0,false);
        if(split<sizeof(reply))cp_mqtt_rpc_data(&s,NULL,0,reply+split,(int)(sizeof(reply)-split),
            (int)split,sizeof(reply),0,false);
        /* A zero-byte first fragment is legal, but its continuation also has
         * offset zero and consequently must retain its topic. */
        if(!split){cp_mqtt_rpc_cancel(&s);continue;}
        assert(s.complete&&!cp_mqtt_rpc_done(&s,0));
        cp_mqtt_rpc_puback(&s,42); /* PUBACK can arrive before publish returns. */
        cp_mqtt_rpc_publish_id(&s,42);assert(!cp_mqtt_rpc_done(&s,1));
        assert(cp_mqtt_rpc_done(&s,0));assert(!memcmp(s.reply,reply,sizeof(reply)));
        cp_mqtt_rpc_cancel(&s);
    }
    assert(cp_mqtt_rpc_begin(&s,topic));cp_mqtt_rpc_publish_id(&s,9);
    cp_mqtt_rpc_data(&s,"late",4,reply,sizeof(reply),0,sizeof(reply),0,false);
    assert(!s.complete&&!s.failed);packet(&s);cp_mqtt_rpc_puback(&s,8);
    assert(!cp_mqtt_rpc_done(&s,0));cp_mqtt_rpc_puback(&s,9);assert(cp_mqtt_rpc_done(&s,0));
    cp_mqtt_rpc_cancel(&s);packet(&s);assert(!cp_mqtt_rpc_done(&s,0));
    /* Oversize, offset gaps, mismatched total, malformed status and retained
     * server replies must not be truncated or accepted. */
    for(unsigned scenario=0;scenario<8;++scenario){
        assert(cp_mqtt_rpc_begin(&s,topic));
        if(scenario==0)cp_mqtt_rpc_data(&s,topic,sizeof(topic)-1,reply,2,0,CP_MQTT_REPLY_MAX+3,0,false);
        if(scenario==1)cp_mqtt_rpc_data(&s,topic,sizeof(topic)-1,reply,2,0,sizeof(reply),1,false);
        if(scenario==2)cp_mqtt_rpc_data(&s,topic,sizeof(topic)-1,reply,2,0,sizeof(reply),0,true);
        if(scenario>=3&&scenario<=5){
            cp_mqtt_rpc_data(&s,topic,sizeof(topic)-1,reply,2,0,sizeof(reply),0,false);
            cp_mqtt_rpc_data(&s,NULL,0,reply+2,2,scenario==3?3:2,scenario==4?10:sizeof(reply),scenario==5?1:0,false);
        }
        if(scenario==6){unsigned char bad[]={0,0};cp_mqtt_rpc_data(&s,topic,sizeof(topic)-1,bad,2,0,2,0,false);}
        if(scenario==7)cp_mqtt_rpc_data(&s,topic,sizeof(topic)-1,NULL,2,0,2,0,false);
        assert(s.failed);cp_mqtt_rpc_puback(&s,1);assert(!cp_mqtt_rpc_done(&s,0));cp_mqtt_rpc_cancel(&s);
    }
    unsigned char full[CP_MQTT_REPLY_MAX+2u]={0,200};
    assert(cp_mqtt_rpc_begin(&s,topic));
    cp_mqtt_rpc_data(&s,topic,sizeof(topic)-1,full,sizeof(full),0,sizeof(full),0,false);
    assert(s.complete&&s.used==sizeof(full)&&s.reply[sizeof(full)]==0);cp_mqtt_rpc_cancel(&s);
    assert(cp_mqtt_rpc_begin(&s,topic));cp_mqtt_rpc_publish_id(&s,-1);assert(s.failed);cp_mqtt_rpc_cancel(&s);
    assert(cp_mqtt_rpc_begin(&s,topic));cp_mqtt_rpc_fail(&s);packet(&s);assert(!s.complete);cp_mqtt_rpc_cancel(&s);
    /* Stop failure never licenses freeing a client used by the SDK. */
    cp_mqtt_lease_ops_t ops={stop,destroy};int object=1;
    cp_mqtt_lease_t lease={.client=&object,.started=true};stop_error=7;
    assert(cp_mqtt_lease_release(&lease,&ops)==7&&lease.retained&&lease.client==&object&&stops==1&&!destroys);
    assert(cp_mqtt_lease_release(&lease,&ops)!=0&&stops==1&&!destroys);
    lease=(cp_mqtt_lease_t){.client=&object,.started=true};stop_error=0;destroy_error=8;
    assert(cp_mqtt_lease_release(&lease,&ops)==8&&lease.retained&&!lease.started&&lease.client);
    lease=(cp_mqtt_lease_t){.client=&object,.started=true};destroy_error=0;
    assert(!cp_mqtt_lease_release(&lease,&ops)&&!lease.client&&!lease.started);
    printf("mqtt RPC fragmentation/correlation/budgets/lifetime passed; host_state_bytes=%zu\n",sizeof(s));
}
