/* Included after unmodified production clock functions by test_clock_adoption.py.
 * No Wi-Fi/MQTT lifecycle or HTTP IO implementation exists in this test binary. */
static const uint64_t UTC=UINT64_C(1793577600000);
static bool app_cancel(void) { return app_stopped; }
static void reset(void) {
    s_owner=(void *)1; task=(void *)1; s_cancelled=app_stopped=cancel_on_wall=false;
    s_wifi_initialized=s_wifi_started=true; wall_failure=false; wall_calls=0;
    s_anchor=(cp_v3_time_t){.mono_ms=1000,.utc_ms=UTC,.uncertainty_ms=1000,.clock_epoch=7};
    s_config=(cp_v3_transport_config_t){.mode=CP_V3_TRANSPORT_MQTT_TLS,.clock_seed=s_anchor,.cancelled=app_cancel};
    s_observed_lower=UTC-1000; s_observed_mono=1000; s_date_known=true;
    now=2000; cp_v3_time_t t;
    assert(cp_v3_transport_time(&t)==ESP_OK);
    assert(s_observed_lower==UTC-1 && s_observed_mono==2000);
}
static cp_v3_time_t fresh(void) {
    return (cp_v3_time_t){.mono_ms=2100,.utc_ms=UTC+1100,.uncertainty_ms=1042,.clock_epoch=8};
}
static void same(const cp_v3_time_t *a,const cp_v3_time_t *b) {
    assert(a->mono_ms==b->mono_ms && a->utc_ms==b->utc_ms &&
        a->clock_epoch==b->clock_epoch && a->uncertainty_ms==b->uncertainty_ms);
}
static void reject(cp_v3_time_t *seed,uint32_t expected) {
    cp_v3_time_t old=s_anchor,config_old=s_config.clock_seed;
    uint64_t old_floor=s_observed_lower,old_mono=s_observed_mono;
    assert(cp_v3_transport_adopt_clock(seed,expected)!=ESP_OK);
    same(&s_anchor,&old); same(&s_config.clock_seed,&config_old);
    assert(s_observed_lower==old_floor && s_observed_mono==old_mono && s_date_known);
}
int main(void) {
    reset(); cp_v3_time_t candidate=fresh(); now=2200;
    assert(cp_v3_transport_adopt_clock(&candidate,7)==ESP_OK && wall_calls==1);
    same(&s_anchor,&candidate); same(&s_config.clock_seed,&candidate);
    assert(!s_date_known && s_observed_lower==UTC+157);
    assert((uint64_t)wall.tv_sec*1000u+(uint64_t)wall.tv_usec/1000u==UTC+1200);
    now=2201; cp_v3_time_t t;
    assert(cp_v3_transport_time(&t)==ESP_OK && t.uncertainty_ms==1043 && t.clock_epoch==8);
    same(&s_anchor,&candidate); /* Never publish/reanchor derived-now uncertainty. */

    /* A wider fresh interval may need elapsed monotonic time to pass the fixed
     * pre-probe floor. Recomputing old-now here would reject forever. */
    reset(); candidate=fresh(); candidate.utc_ms=UTC+100; now=2200;
    reject(&candidate,7); assert(!wall_calls);
    now=3200; assert(cp_v3_transport_adopt_clock(&candidate,7)==ESP_OK);
    same(&s_anchor,&candidate);

    for(unsigned fault=0;fault<18;fault++) {
        reset(); candidate=fresh(); now=2200; uint32_t expected=7;
        switch(fault) {
            case 0: task=(void *)2; break;
            case 1: s_owner=NULL; break;
            case 2: s_wifi_initialized=false; break;
            case 3: s_wifi_started=false; break;
            case 4: cp_v3_transport_cancel(); break;
            case 5: app_stopped=true; break;
            case 6: candidate.clock_epoch=7; break;
            case 7: candidate.clock_epoch=9; break;
            case 8: expected=6; break;
            case 9: s_anchor.clock_epoch=UINT32_MAX; expected=UINT32_MAX; candidate.clock_epoch=0; break;
            case 10: candidate.mono_ms=1999; break;
            case 11: now=2099; break;
            case 12: candidate.utc_ms=UINT64_MAX; break;
            case 13: candidate.mono_ms=UINT64_MAX; break;
            case 14: candidate.uncertainty_ms=5000; break;
            case 15: now=UINT64_MAX; break;
            case 16: candidate.utc_ms=0; break;
            case 17: candidate.utc_ms=UTC-10000; break;
        }
        reject(&candidate,expected); assert(!wall_calls);
    }
    reset(); candidate=fresh(); now=2200; wall_failure=true;
    reject(&candidate,7); assert(wall_calls==1);
    reset(); candidate=fresh(); now=2200; cancel_on_wall=true;
    reject(&candidate,7); assert(wall_calls==1);
    assert(cp_v3_transport_time(&t)==ESP_ERR_INVALID_STATE && !t.utc_ms);
    reset(); reject(NULL,7); assert(!wall_calls);
    now=1999; assert(cp_v3_transport_time(&t)==ESP_ERR_INVALID_STATE && !t.utc_ms);

    reset(); assert(cp_v3_transport_sync_clock()==ESP_ERR_NOT_SUPPORTED);
    s_config.mode=CP_V3_TRANSPORT_HTTPS; s_date=fresh(); now=2200;
    assert(cp_v3_transport_sync_clock()==ESP_OK && s_anchor.clock_epoch==8 && !s_date_known);
    reset(); s_config.mode=CP_V3_TRANSPORT_HTTPS; candidate=fresh(); now=2200;
    assert(cp_v3_transport_adopt_clock(&candidate,7)==ESP_OK);
    puts("transport actual clock adoption/owner/floor/cancellation tests passed");
}
