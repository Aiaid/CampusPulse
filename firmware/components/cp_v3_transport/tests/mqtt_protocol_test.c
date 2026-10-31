#include "mqtt_protocol.h"
#include "mqtt_lifetime.h"
#include <assert.h>
#include <openssl/sha.h>
#include <stdio.h>
_Static_assert(CP_V3_MQTT_RESPONSE_MAX==8192,"Independent v3 reply bound");
static cp_v3_mqtt_rpc_t state;
static uint8_t frame[CP_V3_MQTT_FRAME_MAX],body[8192],reply_wire[8194];
static const char *topic="cp/v1/synthetic/00000000-0000-4000-8000-000000000001/rep/ingest/1";
static void begin(void){memset(&state,0,sizeof state);assert(cp_v3_mqtt_begin(&state,topic));}
static int stops,destroys,stop_error,destroy_error;
static int stop(void *p){assert(p);stops++;return stop_error;}
static int destroy(void *p){assert(p);destroys++;return destroy_error;}
int main(void){
    cp_v3_mqtt_identity_t identity={0};uint32_t rpc;
    const char *boot="00000000-0000-4000-8000-000000000001";
    assert(cp_v3_mqtt_identity_bind(&identity,"synthetic-node","synthetic",boot));
    assert(cp_v3_mqtt_identity_next(&identity,&rpc)&&rpc==1);
    memset(&state,0,sizeof state); /* A confirmed disconnect/stop clears only connection state. */
    assert(cp_v3_mqtt_identity_bind(&identity,"synthetic-node","synthetic",boot));
    assert(cp_v3_mqtt_identity_next(&identity,&rpc)&&rpc==2);
    assert(!cp_v3_mqtt_identity_bind(&identity,"different-node","synthetic",boot));
    assert(!cp_v3_mqtt_identity_bind(&identity,"synthetic-node","other",boot));
    assert(!cp_v3_mqtt_identity_bind(&identity,"synthetic-node","synthetic","00000000-0000-4000-8000-000000000002"));
    identity.sequence=UINT32_MAX;assert(!cp_v3_mqtt_identity_next(&identity,&rpc));
    assert(cp_v3_mqtt_boot_valid("00000000-0000-4000-8000-000000000001"));
    assert(!cp_v3_mqtt_boot_valid("00000000-0000-4000-8000-00000000000/"));
    assert(!cp_v3_mqtt_boot_valid("00000000-0000-1000-8000-000000000001"));
    cp_settings_t settings={0};strcpy(settings.mqtt_uri,CP_MQTT_PRODUCTION_URI);
    strcpy(settings.mqtt_username,"synthetic-user");strcpy(settings.mqtt_password,"synthetic-password");strcpy(settings.mqtt_namespace,"synthetic");
    cp_v3_transport_config_t config={.mode=CP_V3_TRANSPORT_MQTT_TLS,.origin=CP_API_ORIGIN,.active_boot=boot};
    assert(cp_v3_mqtt_config_valid(&settings,&config));config.origin="https://isolated.example";assert(!cp_v3_mqtt_config_valid(&settings,&config));
    config.origin=CP_API_ORIGIN;config.server_ca_pem="";assert(!cp_v3_mqtt_config_valid(&settings,&config));config.server_ca_pem=NULL;
    config.mode=CP_V3_TRANSPORT_HTTPS;assert(!cp_v3_mqtt_config_valid(&settings,&config));config.mode=CP_V3_TRANSPORT_MQTT_TLS;
    strcpy(settings.mqtt_uri,"mqtts://other.example:8883");assert(!cp_v3_mqtt_config_valid(&settings,&config));
    const char *paths[]={"/api/v3/device/capabilities","/api/v3/device/config?boot_id=00000000-0000-4000-8000-000000000001","/api/v3/device/config/ack","/api/v3/device/lease","/api/v3/statistics/ingest"};
    for(unsigned op=1;op<=5;op++){
        assert(cp_v3_mqtt_subop(op==2?CP_V3_HTTP_GET:CP_V3_HTTP_POST,paths[op-1],false)==op);
        assert(cp_v3_mqtt_subop(op==2?CP_V3_HTTP_GET:CP_V3_HTTP_POST,paths[op-1],true)==((op==3||op==4)?op:0));
    }
    for(size_t i=0;i<sizeof body;i++)body[i]=(uint8_t)(i*17u);
    uint8_t original[32],frozen[32];assert(SHA256(body,sizeof body,original));
    size_t bytes=0;assert(cp_v3_mqtt_frame(5,false,body,sizeof body,frame,sizeof frame,&bytes)&&bytes==8200);
    assert(!memcmp(frame,"CPV3\1\5\0\0",8));assert(SHA256(frame+8,bytes-8,frozen));assert(!memcmp(original,frozen,32));
    assert(cp_v3_mqtt_frame(3,true,body,123,frame,sizeof frame,&bytes)&&frame[6]==1);
    assert(!cp_v3_mqtt_frame(1,true,body,123,frame,sizeof frame,&bytes));
    assert(cp_v3_mqtt_frame(2,false,NULL,0,frame,sizeof frame,&bytes)&&bytes==8);
    assert(!cp_v3_mqtt_frame(2,false,body,1,frame,sizeof frame,&bytes));
    assert(!cp_v3_mqtt_frame(5,false,body,8193,frame,sizeof frame,&bytes));
    assert(!cp_v3_mqtt_frame(5,false,body,8192,frame,8199,&bytes));
    reply_wire[0]=0;reply_wire[1]=200;memcpy(reply_wire+2,body,8192);
    begin();cp_v3_mqtt_data(&state,"wrong",5,reply_wire,100,0,8194,0,false);assert(!state.failed&&!state.assembling);
    cp_v3_mqtt_data(&state,topic,(int)strlen(topic),reply_wire,100,0,8194,0,false);
    cp_v3_mqtt_data(&state,"old-reply-topic",15,reply_wire,100,0,8194,0,false);
    assert(state.used==100&&state.assembling&&!state.failed);
    begin();
    for(size_t offset=0;offset<sizeof reply_wire;){size_t n=sizeof reply_wire-offset;if(n>173)n=173;
        cp_v3_mqtt_data(&state,offset?NULL:topic,offset?0:(int)strlen(topic),reply_wire+offset,(int)n,(int)offset,sizeof reply_wire,0,false);offset+=n;}
    assert(state.complete&&!state.failed&&!memcmp(state.reply,reply_wire,sizeof reply_wire));
    assert(!cp_v3_mqtt_done(&state,0));cp_v3_mqtt_puback(&state,7);state.publish_id=7;
    cp_v3_mqtt_puback(&state,6);assert(state.puback_id==7);
    assert(!cp_v3_mqtt_done(&state,1));assert(cp_v3_mqtt_done(&state,0));
    begin();state.publish_id=state.puback_id=1;assert(!cp_v3_mqtt_done(&state,0)); /* PUBACK alone is not custody. */
    begin();cp_v3_mqtt_data(&state,topic,(int)strlen(topic),reply_wire,2,0,8195,0,false);assert(state.failed);
    begin();cp_v3_mqtt_data(&state,topic,(int)strlen(topic),reply_wire,2,0,8194,1,false);assert(state.failed);
    begin();cp_v3_mqtt_data(&state,topic,(int)strlen(topic),reply_wire,2,0,8194,0,true);assert(state.failed);
    begin();cp_v3_mqtt_data(&state,topic,(int)strlen(topic),reply_wire,2,0,8194,0,false);
    cp_v3_mqtt_data(&state,NULL,0,reply_wire+2,2,3,8194,0,false);assert(state.failed&&!state.complete);
    begin();uint8_t bad_status[2]={0,99};cp_v3_mqtt_data(&state,topic,(int)strlen(topic),bad_status,2,0,2,0,false);assert(state.failed);
    cp_mqtt_lease_ops_t ops={stop,destroy};cp_mqtt_lease_t lease={(void *)1,true,false};
    stop_error=7;assert(cp_mqtt_lease_release(&lease,&ops)==7&&lease.retained&&lease.client&&stops==1&&!destroys);
    assert(cp_mqtt_lease_release(&lease,&ops)!=0&&stops==1&&!destroys);
    lease=(cp_mqtt_lease_t){(void *)1,true,false};stop_error=0;assert(!cp_mqtt_lease_release(&lease,&ops)&&!lease.client&&!lease.started&&destroys==1);
    lease=(cp_mqtt_lease_t){(void *)1,true,false};destroy_error=9;assert(cp_mqtt_lease_release(&lease,&ops)==9&&lease.retained&&lease.client);
    puts("V3 MQTT: 8-byte frame/exact body hash, independent8192 reply, fragment/topic/QoS/retain bounds, PUBACK+outbox+application response and retained-stop ownership passed");
}
