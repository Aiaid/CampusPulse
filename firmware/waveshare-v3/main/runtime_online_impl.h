/* Included by the network owner after its storage/upload adapters. No task,
 * board restart, credential mutation or independent transport owner lives here. */
static void online_reclaim_old_controls(void);
static bool online_refresh_clock(cp_v3_boundary_t);
static bool online_raw_limited(const local_raw_status_t *s) {
    return s->safe_to_unmount&&!s->io_failed_latched&&
        (s->reason==LOCAL_RAW_QUOTA||s->reason==LOCAL_RAW_LOW_SPACE||s->reason==LOCAL_RAW_BUDGET);
}
static bool online_lease_checkpoint(void *unused,const cp_v3_scope_t *scope,const void *body,size_t bytes) {
    (void)unused;char hash[65];body_hash(body,bytes,hash);bool found=false;
    xSemaphoreTake(s_tf,portMAX_DELAY);
    for(unsigned i=0;i<CP_V3_QUEUE_SLOTS&&!found;i++) {
        cp_v3_queue_slot_t *slot=&s_queue->slots[i];
        if(slot->state!=CP_V3_QUEUE_PENDING||slot->kind!=CP_V3_QUEUE_CONTROL||strcmp(slot->expected.stream,"lease")||
           strcmp(slot->expected.scope.boot_id,scope->boot_id)||slot->expected.scope.assignment_generation!=scope->assignment_generation||strcmp(slot->expected.body_sha256,hash))continue;
        cp_v3_expected_t expected;size_t stored;
        found=cp_v3_queue_read(s_queue,i,s_network_body,BODY_MAX,&stored,&expected)==CP_V3_QUEUE_OK&&stored==bytes&&!memcmp(s_network_body,body,bytes);
    }
    xSemaphoreGive(s_tf);return found;
}
static bool online_park(cp_v3_temporal_reason_t reason,cp_v3_boundary_t *boundary) {
    phase("ONLINE PAUSE");s_storage_park_requested=true;
    if(cp_v3_capture_pause(s_capture,reason,0)!=ESP_OK)return false;
    uint64_t deadline=monotonic_ms()+30000;
    while(!s_stop&&!s_storage_fault&&!s_storage_parked&&monotonic_ms()<deadline) {
        /* Old frozen uploads may free slots needed by the final old handoffs. */
        (void)upload_one(CP_V3_QUEUE_WINDOW);(void)upload_one(CP_V3_QUEUE_EVENT);(void)upload_one(CP_V3_QUEUE_STATUS);
        vTaskDelay(pdMS_TO_TICKS(25));
    }
    if(s_stop||s_storage_fault||!s_storage_parked)return false;
    esp_err_t stopped=local_raw_stop(s_raw,10000);
    local_raw_status_t raw;local_raw_snapshot(s_raw,&raw);cp_v3_capture_status_t capture;cp_v3_capture_status(s_capture,&capture);
    if((stopped!=ESP_OK&&!online_raw_limited(&raw))||!raw.safe_to_unmount||raw.io_failed_latched||!capture.quiescent||capture.failed||s_last_durable_window!=capture.last_closed_window_seq)return false;
    *boundary=(cp_v3_boundary_t){.closed_window_seq=capture.last_closed_window_seq};
    return true;
}
static bool online_detach_lease(cp_v3_boundary_t boundary) {
    return !s_control->lease_pending||cp_v3_control_detach_lease_at_boundary(s_control,boundary,online_lease_checkpoint,NULL)==CP_V3_CONTROL_OK;
}
static bool online_observations_aged(void) {
    uint64_t upper;portENTER_CRITICAL(&s_lock);upper=s_observation_upper;portEXIT_CRITICAL(&s_lock);
    cp_v3_time_t seed;portENTER_CRITICAL(&s_lock);seed=s_anchor;portEXIT_CRITICAL(&s_lock);
    return edge_online_observation_aged(seed,monotonic_ms(),upper);
}
static bool online_resume(void) {
    cp_v3_time_t now;if(!current(&now))return false;
    cp_v3_control_permissions_t permission=cp_v3_control_permissions(s_control,now);
    if(!permission.collection||s_stop||s_storage_fault||s_control->apply_result!=CP_V3_APPLY_OK)return false;
    cp_v3_capture_status_t capture;cp_v3_capture_status(s_capture,&capture);
    if(capture.running) {
        (void)cp_v3_capture_deadline(s_capture,permission.deadline_mono_ms);return true;
    }
    if(!capture.quiescent||capture.bounded_complete||capture.last_closed_window_seq==UINT32_MAX)return false;
    local_raw_status_t state;local_raw_snapshot(s_raw,&state);
    if(s_control->policy.local_raw.enabled&&!state.active) {
        cp_v3_control_raw_t *p=&s_control->policy.local_raw;
        local_raw_config_t cfg={p->max_segment_bytes,p->max_total_bytes,p->min_free_bytes,p->sync_interval_ms};uint8_t session[16];esp_fill_random(session,16);
        if(!permission.local_raw)return false;
        if(!online_raw_limited(&state)&&local_raw_start(s_raw,&cfg,s_boot,session)!=ESP_OK){
            local_raw_snapshot(s_raw,&state);if(!online_raw_limited(&state))return false;
        }
    }
    if(cp_v3_capture_start(s_capture,&s_control->policy.scope,capture.last_closed_window_seq+1,
        s_control->policy.scan_interval_units,s_control->policy.scan_window_units,permission.deadline_mono_ms)!=ESP_OK)return false;
    s_storage_park_requested=false;s_storage_backpressure=false;s_storage_resume=false;
    s_online->resume_pending=false;s_online->lease_recovery=false;
    publish_policy_view();phase("SMALL COLLECT");return true;
}
static bool online_ack(void) {
    s_online->ack_pending=true;
    if(s_storage_parked){
        cp_v3_capture_status_t capture;cp_v3_capture_status(s_capture,&capture);
        cp_v3_boundary_t boundary={.closed_window_seq=capture.last_closed_window_seq};
        cp_v3_time_t now;cp_v3_time_t seed;portENTER_CRITICAL(&s_lock);seed=s_anchor;portEXIT_CRITICAL(&s_lock);
        if((s_online->clock_sealed&&!s_online->clock_adopted)||!clock_copy(NULL,monotonic_ms(),&(cp_v3_temporal_time_t){0})||monotonic_ms()-seed.mono_ms>=EDGE_ONLINE_CLOCK_AGE_MS){
            if(s_online->clock_adopted){s_online->clock_sealed=false;s_online->clock_adopted=false;}
            if(!online_refresh_clock(boundary))return false;
        }else if(!current(&now))return false;
        online_reclaim_old_controls();
    }
    size_t bytes;const char *body=cp_v3_control_ack_bytes(s_control,&bytes);
    if(!body||!control_exchange("config_ack","/api/v3/device/config/ack",body,bytes,s_control->apply_seq,false))return false;
    publish_policy_view();
    if(s_control->apply_result==CP_V3_APPLY_OK&&s_bootstrap.save_startup){
        if(!save_startup_profile()){s_stop=true;return false;}s_bootstrap.save_startup=false;
    }
    /* A real failed apply is committed too; it never resumes the old policy. */
    cp_v3_control_clear(s_candidate);s_online->renewal=false;s_online->clock_sealed=false;s_online->clock_adopted=false;
    s_online->ready_frozen=false;s_online->ready_committed=false;s_online->ready_bytes=0;memset(&s_transition,0,sizeof s_transition);
    s_online->next_lease_ms=monotonic_ms()+s_control->policy.lease_ms/3;
    s_online->resume_pending=s_control->apply_result==CP_V3_APPLY_OK;s_online->lease_recovery=false;s_online->ack_pending=false;
    if(!s_online->resume_pending)phase("ONLINE PAUSED");
    return true;
}
static bool online_ready(const edge_online_transition_t *transition,cp_v3_boundary_t boundary) {
    if(!s_online->ready_frozen) {
        if(!online_observations_aged()||s_control_seq==UINT32_MAX)return false;
        cp_v3_time_t now;if(!current(&now))return false;
        uint64_t upper;portENTER_CRITICAL(&s_lock);upper=s_observation_upper;portEXIT_CRITICAL(&s_lock);
        int n=snprintf(s_online->ready_body,sizeof s_online->ready_body,
            "{\"protocol\":\"campuspulse/3\",\"schema\":\"scope-transition-ready/1\",\"transition_id\":\"%s\",\"boot_id\":\"%s\",\"from_generation\":%llu,\"capability_sha256\":\"%s\",\"closed_window_seq\":%lu,\"closed_segment_seq\":%lu,\"clock_epoch\":%lu,\"uptime_ms\":%llu,\"observation_upper_ms\":%llu}",
            transition->id,s_boot,(unsigned long long)transition->from_generation,transition->capability_sha256,
            (unsigned long)boundary.closed_window_seq,(unsigned long)boundary.closed_segment_seq,(unsigned long)now.clock_epoch,
            (unsigned long long)now.mono_ms,(unsigned long long)upper);
        if(n<=0||(size_t)n>=sizeof s_online->ready_body)return false;
        s_online->ready_bytes=(size_t)n;s_online->ready_seq=++s_control_seq;s_online->ready_frozen=true;
    }
    cp_v3_expected_t e={.scope=s_control->policy.scope,.seq_first=s_online->ready_seq,.seq_last=s_online->ready_seq,.accepted_count=1,.body_bytes=s_online->ready_bytes};
    strcpy(e.stream,"lease");body_hash(s_online->ready_body,s_online->ready_bytes,e.body_sha256);
    unsigned selected=CP_V3_QUEUE_SLOTS;xSemaphoreTake(s_tf,portMAX_DELAY);
    for(unsigned i=0;i<CP_V3_QUEUE_SLOTS;i++)if(s_queue->slots[i].state==CP_V3_QUEUE_PENDING&&s_queue->slots[i].kind==CP_V3_QUEUE_CONTROL&&
        !strcmp(s_queue->slots[i].expected.body_sha256,e.body_sha256)){selected=i;e=s_queue->slots[i].expected;break;}
    if(selected==CP_V3_QUEUE_SLOTS) {
        size_t encoded=cp_v3_queue_encoded_size(s_queue,s_online->ready_bytes);
        if(!encoded||!write_charge(NULL,edge_lifecycle_charge(encoded))){xSemaphoreGive(s_tf);return false;}
        uuid4(e.batch_id);s_publish_authorized=true;s_publish_allowance=edge_lifecycle_charge(encoded);
        cp_v3_queue_result_t result=cp_v3_queue_push_expiring(s_queue,CP_V3_QUEUE_CONTROL,&e,s_online->ready_body,s_online->ready_bytes,
            s_control->policy.accept_until_utc_ms,&selected);s_publish_authorized=false;
        if(result!=CP_V3_QUEUE_OK){xSemaphoreGive(s_tf);return false;}
    }
    size_t bytes;cp_v3_expected_t frozen;cp_v3_queue_result_t read=cp_v3_queue_read(s_queue,selected,s_network_body,BODY_MAX,&bytes,&frozen);xSemaphoreGive(s_tf);
    if(read!=CP_V3_QUEUE_OK||bytes!=s_online->ready_bytes||memcmp(s_network_body,s_online->ready_body,bytes))return false;
    cp_v3_transport_response_t response;
    if(!request(CP_V3_HTTP_POST,"/api/v3/device/lease",s_network_body,bytes,&response)||
        !edge_online_ready_matches(&frozen,s_network_body,bytes,s_reply,response.body_bytes,cp_v3_transport_sha256,NULL))return false;
    xSemaphoreTake(s_tf,portMAX_DELAY);cp_v3_queue_result_t ack=cp_v3_queue_ack_control(s_queue,selected,s_reply,response.body_bytes,control_match,NULL);xSemaphoreGive(s_tf);
    if(ack!=CP_V3_QUEUE_OK)return false;
    s_online->ready_committed=true;ESP_LOGI(TAG,"online_ready_committed=1 authority_granted=0");return true;
}
static bool online_refresh_clock(cp_v3_boundary_t boundary) {
    if(!s_online->clock_adopted) {
        if(!s_time_pin_ready)return false;
        if(!s_online->clock_sealed) {
            if(!online_observations_aged())return false;
            cp_v3_time_t floor;bool live=current(&floor);
            /* If the live map expired during an outage, transport still owns
             * its last observed floor. A failed time read cannot extend it. */
            if(!live){portENTER_CRITICAL(&s_lock);floor=s_anchor;portEXIT_CRITICAL(&s_lock);}
            if(!floor.clock_epoch||floor.clock_epoch==UINT32_MAX)return false;
            s_online->old_epoch=floor.clock_epoch;s_online->clock_sealed=true;
        }
        /* No transport_time/request sampling on probe retries. The old lower
         * bound above is fixed until a verified ORIGINAL seed is adopted. */
        phase("ONLINE CLOCK");cp_v3_transport_memory_t memory;
        if(cp_v3_transport_begin_memory(2000,&memory)!=ESP_OK)return false;
        cp_v3_time_t seed;esp_err_t probe=cp_v3_clock_probe_online(s_time_spki,s_time_key_id,s_online->old_epoch+1,cancelled,&seed);
        cp_v3_transport_end_memory();
        if(probe!=ESP_OK||s_stop||cp_v3_transport_adopt_clock(&seed,s_online->old_epoch)!=ESP_OK)return false;
        publish_anchor(seed);s_online->clock_adopted=true;s_signed_time=true;
    }
    cp_v3_time_t now;if(!current(&now))return false;
    if(s_control->clock_epoch<now.clock_epoch&&cp_v3_control_clock_boundary(s_control,now,boundary)!=CP_V3_CONTROL_OK)return false;
    if(s_candidate->state!=CP_V3_CONTROL_EMPTY&&s_candidate->clock_epoch<now.clock_epoch&&
        cp_v3_control_clock_boundary(s_candidate,now,boundary)!=CP_V3_CONTROL_OK)return false;
    return true;
}
static bool online_renew(void) {
    if(s_online->ack_pending||s_control->state==CP_V3_CONTROL_ACK_PENDING)return online_ack();
    cp_v3_boundary_t boundary;
    if(!s_online->clock_sealed&&!online_park(CP_V3_TEMPORAL_CONFIG_CHANGE,&boundary))return false;
    cp_v3_capture_status_t capture;cp_v3_capture_status(s_capture,&capture);boundary=(cp_v3_boundary_t){.closed_window_seq=capture.last_closed_window_seq};
    if(!online_detach_lease(boundary))return false;
    if(s_online->clock_adopted) {
        cp_v3_temporal_time_t time;cp_v3_time_t seed;portENTER_CRITICAL(&s_lock);seed=s_anchor;portEXIT_CRITICAL(&s_lock);
        if(!clock_copy(NULL,monotonic_ms(),&time)||time.uncertainty_ms>=3000||monotonic_ms()-seed.mono_ms>=EDGE_ONLINE_CLOCK_AGE_MS){
            s_online->clock_sealed=false;s_online->clock_adopted=false;
        }
    }
    if(!online_refresh_clock(boundary))return false;
    online_reclaim_old_controls();
    cp_v3_time_t now;if(!current(&now))return false;
    if(s_candidate->state==CP_V3_CONTROL_EMPTY) {
        uint64_t free_bytes;xSemaphoreTake(s_tf,portMAX_DELAY);bool have_space=raw_storage_space(&free_bytes)==ESP_OK;xSemaphoreGive(s_tf);
        if(!have_space)return false;
        size_t bytes=capabilities(s_network_body,4096,now,free_bytes);
        if(!bytes||cp_v3_control_stage_capabilities(s_control,s_candidate,s_network_body,bytes,now,boundary)!=CP_V3_CONTROL_OK)return false;
    }
    if(!s_candidate->renewal_registered) {
        const char *body;size_t bytes;if(cp_v3_control_renewal_registration(s_candidate,&body,&bytes)!=CP_V3_CONTROL_OK)return false;
        cp_v3_transport_response_t response;
        if(!request(CP_V3_HTTP_POST,"/api/v3/device/capabilities",body,bytes,&response)||!current(&now)||
            cp_v3_control_registration_receipt(s_candidate,s_reply,response.body_bytes,now)!=CP_V3_CONTROL_OK)return false;
    }
    phase("ONLINE POLICY");char path[128];snprintf(path,sizeof path,"/api/v3/device/config?boot_id=%s",s_boot);
    cp_v3_transport_response_t response;
    if(!request(CP_V3_HTTP_GET,path,NULL,0,&response)||!current(&now))return false;
    cp_v3_control_result_t offer=cp_v3_control_offer(s_candidate,s_reply,response.body_bytes,now);
    if(offer!=CP_V3_CONTROL_OK||s_control_seq==UINT32_MAX)return false;
    if(cp_v3_control_activate_renewal(s_control,s_candidate,now,boundary,++s_control_seq,actual_apply,NULL)!=CP_V3_CONTROL_OK)return false;
    return online_ack();
}
static void online_poll(void) {
    if(s_online->ack_pending||s_control->state==CP_V3_CONTROL_ACK_PENDING){(void)online_ack();return;}
    if(s_online->renewal){(void)online_renew();return;}
    char path[128];snprintf(path,sizeof path,"/api/v3/device/config?boot_id=%s",s_boot);
    cp_v3_transport_response_t response;if(!request(CP_V3_HTTP_GET,path,NULL,0,&response))return;
    cp_v3_time_t now;if(!current(&now))return;
    edge_online_transition_t transition;
    if(edge_online_transition(s_reply,response.body_bytes,s_boot,s_control->policy.scope.assignment_generation,s_control->capability_sha256,now,&transition)&&transition.pending) {
        if(!s_online->ready_frozen)s_transition=transition;
        if(strcmp(s_transition.id,transition.id))return; /* Retain the prior exact Ready until resolved. */
        cp_v3_boundary_t boundary;if(!online_park(CP_V3_TEMPORAL_PLACEMENT_CHANGE,&boundary))return;
        if(!online_detach_lease(boundary))return;
        if(!s_online->ready_committed)(void)online_ready(&s_transition,boundary);
        return;
    }
    uint64_t generation=0;
    if(edge_online_config_generation(s_reply,response.body_bytes,&generation)&&generation>s_control->policy.scope.assignment_generation) {
        if(s_control->lease_pending){cp_v3_boundary_t boundary;if(online_park(CP_V3_TEMPORAL_CONFIG_CHANGE,&boundary))(void)online_detach_lease(boundary);return;}
        cp_v3_control_result_t staged=cp_v3_control_stage(s_control,s_candidate,s_reply,response.body_bytes,now);
        if(staged!=CP_V3_CONTROL_OK)return;
        cp_v3_boundary_t boundary;if(!online_park(CP_V3_TEMPORAL_CONFIG_CHANGE,&boundary))return;
        if(!current(&now)||s_control_seq==UINT32_MAX)return;
        if(cp_v3_control_activate_staged(s_control,s_candidate,now,boundary,++s_control_seq,actual_apply,NULL)==CP_V3_CONTROL_OK)(void)online_ack();
    }
}
static void online_reclaim_old_controls(void) {
    for(unsigned slot=0;slot<CP_V3_QUEUE_SLOTS;slot++) {
        xSemaphoreTake(s_tf,portMAX_DELAY);cp_v3_queue_slot_t *q=&s_queue->slots[slot];
        bool historical=q->state==CP_V3_QUEUE_PENDING&&q->kind==CP_V3_QUEUE_CONTROL&&
            (strcmp(q->expected.scope.boot_id,s_boot)||q->expected.scope.assignment_generation!=s_control->policy.scope.assignment_generation||
             (s_control->detached_contact_seq&&!strcmp(q->expected.stream,"lease")));
        size_t bytes=0;cp_v3_expected_t expected;cp_v3_queue_result_t read=historical?cp_v3_queue_read(s_queue,slot,s_network_body,BODY_MAX,&bytes,&expected):CP_V3_QUEUE_NOT_FOUND;xSemaphoreGive(s_tf);
        if(read!=CP_V3_QUEUE_OK)continue;
        const char *path=!strcmp(expected.stream,"config_ack")?"/api/v3/device/config/ack":"/api/v3/device/lease";
        cp_v3_transport_response_t response;if(!request_mode(CP_V3_HTTP_POST,path,s_network_body,bytes,&response,true))continue;
        xSemaphoreTake(s_tf,portMAX_DELAY);(void)cp_v3_queue_ack_control(s_queue,slot,s_reply,response.body_bytes,control_match,NULL);xSemaphoreGive(s_tf);
    }
}
static bool online_run(void) {
    s_online->next_poll_ms=0;s_online->next_lease_ms=monotonic_ms()+s_control->policy.lease_ms/3;
    while(!s_stop) {
        if(s_storage_fault){(void)cp_v3_capture_pause(s_capture,CP_V3_TEMPORAL_CAPACITY,0);phase("ONLINE PAUSED");vTaskDelay(pdMS_TO_TICKS(EDGE_ONLINE_RETRY_MS));continue;}
        if(!s_auto_retry){(void)cp_v3_capture_pause(s_capture,CP_V3_TEMPORAL_LEASE_EXPIRED,0);phase("ONLINE PAUSED");vTaskDelay(pdMS_TO_TICKS(EDGE_ONLINE_RETRY_MS));continue;}
        cp_v3_transport_wifi_state_t link;
        if(cp_v3_transport_wifi_state(&link)==ESP_OK&&
            (link.reject_flags&CP_V3_TRANSPORT_REJECT_WIFI_NO_IP)) {
            cp_v3_boundary_t boundary;
            if(!online_park(CP_V3_TEMPORAL_SCAN_GAP,&boundary)){
                vTaskDelay(pdMS_TO_TICKS(EDGE_ONLINE_RETRY_MS));continue;
            }
            phase("ONLINE WIFI");
            esp_err_t recovered=cp_v3_transport_reconnect_wifi();
            ESP_LOGI(TAG,"wifi_recovery result=%ld prior_flags=%lu prior_disconnect_seq=%lu prior_disconnect_reason=%lu",
                (long)recovered,(unsigned long)link.reject_flags,(unsigned long)link.disconnect_seq,(unsigned long)link.disconnect_reason);
            if(recovered!=ESP_OK){vTaskDelay(pdMS_TO_TICKS(EDGE_ONLINE_RETRY_MS));continue;}
            s_online->next_poll_ms=0;s_online->next_lease_ms=0;
            s_online->lease_recovery=true;
            /* The old exact lease/capability/ACK bodies remain intact. A
             * renewed real permission, never the IP link, resumes capture. */
        }
        /* Sealed old clocks are never sampled again by the ordinary loop. */
        if(s_online->ack_pending||s_control->state==CP_V3_CONTROL_ACK_PENDING){(void)online_ack();vTaskDelay(pdMS_TO_TICKS(EDGE_ONLINE_RETRY_MS));continue;}
        if(s_online->renewal){(void)online_renew();vTaskDelay(pdMS_TO_TICKS(EDGE_ONLINE_RETRY_MS));continue;}
        uint64_t mono=monotonic_ms();
        if(mono>=s_online->next_poll_ms){online_poll();s_online->next_poll_ms=monotonic_ms()+EDGE_ONLINE_POLL_MS;}
        if(s_stop)break;
        if(s_control->state==CP_V3_CONTROL_ACK_PENDING){vTaskDelay(pdMS_TO_TICKS(250));continue;}
        if(s_online->resume_pending)(void)online_resume();
        cp_v3_time_t now;
        if(!current(&now)){cp_v3_boundary_t boundary;if(online_park(CP_V3_TEMPORAL_CLOCK_CHANGE,&boundary)){cp_v3_control_clear(s_candidate);s_online->renewal=true;}vTaskDelay(pdMS_TO_TICKS(EDGE_ONLINE_RETRY_MS));continue;}
        cp_v3_time_t seed;portENTER_CRITICAL(&s_lock);seed=s_anchor;portEXIT_CRITICAL(&s_lock);
        if(!s_online->ready_frozen&&edge_online_renew_due(now,seed,s_control->capability_expires_utc_ms)){
            cp_v3_boundary_t boundary;if(online_park(CP_V3_TEMPORAL_CONFIG_CHANGE,&boundary)){cp_v3_control_clear(s_candidate);s_online->renewal=true;}
            vTaskDelay(pdMS_TO_TICKS(250));continue;
        }
        cp_v3_control_permissions_t permission=cp_v3_control_permissions(s_control,now);
        if(!permission.collection)(void)cp_v3_capture_pause(s_capture,CP_V3_TEMPORAL_LEASE_EXPIRED,0);
        if((!s_storage_park_requested||s_online->lease_recovery)&&!s_online->ready_frozen&&mono>=s_online->next_lease_ms) {
            const char *body=NULL;size_t bytes=0;
            if(s_control->lease_pending){body=s_control->lease_json;bytes=s_control->lease_length;}
            else if(s_control->contact_seq<UINT32_MAX&&s_control_seq<UINT32_MAX&&
                cp_v3_control_lease_request(s_control,s_control->contact_seq+1,now.mono_ms,&body,&bytes)==CP_V3_CONTROL_OK)s_lease_stream_seq=++s_control_seq;
            if(body&&!control_exchange("lease","/api/v3/device/lease",body,bytes,s_lease_stream_seq,true)) {
                /* An assignment race or lost reply never reboots or invents a
                 * new request identity. Stop first, then poll/recover online. */
                cp_v3_boundary_t boundary;s_online->lease_recovery=true;(void)online_park(CP_V3_TEMPORAL_LEASE_EXPIRED,&boundary);s_online->next_poll_ms=0;
            }else if(body&&s_online->lease_recovery){s_online->lease_recovery=false;s_online->resume_pending=true;}
            s_online->next_lease_ms=monotonic_ms()+s_control->policy.lease_ms/3;
        }
        if(!s_storage_park_requested&&(s_storage_resume||!s_storage_backpressure))(void)online_resume();
        if(!upload_one(CP_V3_QUEUE_WINDOW)||!upload_one(CP_V3_QUEUE_EVENT)||!upload_one(CP_V3_QUEUE_STATUS)){
            (void)cp_v3_capture_pause(s_capture,CP_V3_TEMPORAL_CAPACITY,0);phase("ONLINE PAUSED");
        }
        if(s_storage_parked&&(!s_online->clock_sealed||s_online->clock_adopted))online_reclaim_old_controls();
        vTaskDelay(pdMS_TO_TICKS(250));
    }
    return !s_storage_fault;
}
