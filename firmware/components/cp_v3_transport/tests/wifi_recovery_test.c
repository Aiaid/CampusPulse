/* Included after actual production recovery/preflight functions. */
static void reset(void){
    s_owner=task=(void *)1;s_cancelled=app_stopped=s_link=false;
    s_wifi_initialized=s_wifi_started=true;
    s_wifi_events=0;s_wifi_disconnect_seq=4;s_wifi_disconnect_reason=200;
    s_config=(cp_v3_transport_config_t){.mode=CP_V3_TRANSPORT_MQTT_TLS,.cancelled=app_cancel,
        .wifi_timeout_ms=1000,.wifi_reconnect_max_attempts=3,.wifi_reconnect_delay_ms=20,
        .clock_seed={.mono_ms=30,.utc_ms=1793577600000,.clock_epoch=8,.uncertainty_ms=1000}};
    now=ready_at=cancel_at=0;
    stop_calls=disconnect_calls=connect_calls=radio_stop_calls=clock_calls=cancel_operation=0;
    fail_every_connect=false;
    stop_result=disconnect_result=connect_result=clock_result=ESP_OK;
}
static void no_network(void){assert(!stop_calls&&!disconnect_calls&&!connect_calls&&!radio_stop_calls);}
int main(void){
    reset();cp_v3_transport_wifi_state_t state;
    assert(cp_v3_transport_wifi_state(NULL)==ESP_ERR_INVALID_ARG);
    assert(cp_v3_transport_wifi_state(&state)==ESP_OK);
    assert(state.reject_flags==16&&state.disconnect_seq==4&&state.disconnect_reason==200&&!clock_calls);
    cp_v3_transport_response_t out={0};
    assert(request_preflight(&out)==ESP_ERR_INVALID_STATE);
    assert(out.state_reject_flags==16&&out.wifi_disconnect_seq==4&&out.wifi_disconnect_reason==200&&!clock_calls);
    for(unsigned gate=0;gate<5;gate++){
        reset();uint32_t expected=16;
        switch(gate){
            case 0:task=(void *)2;expected=1;break;
            case 1:s_cancelled=true;expected|=2;break;
            case 2:app_stopped=true;expected|=2;break;
            case 3:s_wifi_initialized=false;expected|=4;break;
            case 4:s_wifi_started=false;expected|=8;break;
        }
        assert(cp_v3_transport_reconnect_wifi()==ESP_ERR_INVALID_STATE);
        memset(&out,0,sizeof out);assert(request_preflight(&out)==ESP_ERR_INVALID_STATE);
        assert(out.state_reject_flags==expected&&!clock_calls);no_network();
    }
    reset();s_link=true;assert(cp_v3_transport_reconnect_wifi()==ESP_OK);no_network();
    assert(cp_v3_transport_wifi_state(&state)==ESP_OK&&!state.reject_flags&&!clock_calls);
    clock_result=ESP_ERR_INVALID_STATE;
    assert(request_preflight(&out)==ESP_ERR_INVALID_STATE&&out.state_reject_flags==32&&clock_calls==1);

    reset();ready_at=30;cp_v3_transport_config_t before=s_config;
    assert(cp_v3_transport_reconnect_wifi()==ESP_OK);
    assert(stop_calls==1&&disconnect_calls==1&&connect_calls==1&&!radio_stop_calls&&now==30);
    assert(s_owner==task&&s_wifi_initialized&&s_wifi_started&&!s_cancelled&&!clock_calls);
    assert(!memcmp(&before,&s_config,sizeof before));
    assert(request_preflight(&out)==ESP_OK&&!out.state_reject_flags&&clock_calls==1);

    reset();fail_every_connect=true;
    assert(cp_v3_transport_reconnect_wifi()==ESP_ERR_TIMEOUT);
    assert(now==1000&&connect_calls==4&&stop_calls==1&&disconnect_calls==1&&!s_cancelled);
    fail_every_connect=false;ready_at=1010;
    assert(cp_v3_transport_reconnect_wifi()==ESP_OK&&now==1010&&connect_calls==5);

    for(unsigned operation=1;operation<=3;operation++){
        reset();cancel_operation=operation;
        assert(cp_v3_transport_reconnect_wifi()==ESP_ERR_INVALID_STATE);
        assert(stop_calls==1&&disconnect_calls==(operation>=2)&&connect_calls==(operation>=3));
    }
    reset();cancel_at=20;assert(cp_v3_transport_reconnect_wifi()==ESP_ERR_INVALID_STATE&&now==20);
    reset();stop_result=ESP_ERR_TIMEOUT;
    assert(cp_v3_transport_reconnect_wifi()==ESP_ERR_TIMEOUT);
    assert(s_cancelled&&!s_wifi_started&&radio_stop_calls==1&&!disconnect_calls&&!connect_calls);
    stop_result=ESP_OK;assert(cp_v3_transport_reconnect_wifi()==ESP_ERR_INVALID_STATE&&stop_calls==1);
    reset();disconnect_result=ESP_FAIL;
    assert(cp_v3_transport_reconnect_wifi()==ESP_FAIL&&disconnect_calls==1&&!connect_calls);
    reset();connect_result=ESP_FAIL;
    assert(cp_v3_transport_reconnect_wifi()==ESP_FAIL&&connect_calls==1&&now==0);
    reset();s_config.mode=CP_V3_TRANSPORT_HTTPS;ready_at=10;
    assert(cp_v3_transport_reconnect_wifi()==ESP_OK&&!stop_calls&&disconnect_calls==1&&connect_calls==1);
    puts("transport actual Wi-Fi recovery/preflight/owner/cancellation tests passed");
}
