#include "board_runtime_adapters.h"
#include <string.h>
#include <stdio.h>

static bool admit(void *p) { te_runtime_window_adapter_t *a=p; return a->queue_ready(a->io); }
static te_handoff_peek_result_t peek(void *p,void *out,size_t cap,size_t *n) {
    te_runtime_window_adapter_t *a=p; *n=0;
    if(cap<sizeof(cp_v3_capture_window_t)) return TE_PEEK_ERROR;
    /* The existing API reports empty and collector failure identically. Do not
     * infer an empty queue; halt pending an unambiguous API. */
    if(!te_v3_shared_capture_window(a->capture,out)) return TE_PEEK_ERROR;
    *n=sizeof(cp_v3_capture_window_t); return TE_PEEK_ITEM;
}
static bool freeze(void *p,const void *s,size_t sn,void *b,size_t bc,size_t *bn,void *id,size_t ic,size_t *in) {
    te_runtime_window_adapter_t *a=p;
    return te_v3_window_freeze(a->freeze,s,sn,b,bc,bn,id,ic,in);
}
static bool hash(void *p,const void *b,size_t n,uint8_t out[32]) {
    te_runtime_window_adapter_t *a=p; return a->freeze->sha256(a->freeze->sha_context,b,n,out);
}
static te_handoff_store_result_t store(void *p,const void *b,size_t n,const void *id,size_t in,const uint8_t h[32]) {
    te_runtime_window_adapter_t *a=p; cp_v3_expected_t e,read={0}; size_t len=0; uint8_t digest[32];
    if(in!=sizeof e || !hash(p,b,n,digest) || memcmp(digest,h,32))return TE_STORE_ERROR;
    memcpy(&e,id,sizeof e);
    if(!a->expiry_utc_ms || a->expiry_utc_ms>a->control->policy.accept_until_utc_ms)return TE_STORE_ERROR;
    te_v3_small_queue_result_t r=te_v3_small_queue_push(a->queue,CP_V3_QUEUE_WINDOW,&e,b,n,a->expiry_utc_ms,&a->slot);
    if(r==TE_SMALL_QUEUE_FULL)return TE_STORE_FULL;
    if(r!=TE_SMALL_QUEUE_OK)return TE_STORE_ERROR;
    if(te_v3_small_queue_read(a->queue,a->slot,a->readback,sizeof a->readback,&len,&read)!=TE_SMALL_QUEUE_OK ||
       len!=n || memcmp(a->readback,b,n) || memcmp(&read,&e,sizeof e))return TE_STORE_ERROR;
    a->stored_identity=e; memcpy(a->stored_hash,h,32); a->stored=true; return TE_STORE_DURABLE;
}
static bool release(void *p,const void *s,size_t n) {
    te_runtime_window_adapter_t *a=p;
    if(!a->stored || n!=sizeof a->release_scratch)return false;
    memcpy(&a->release_scratch,s,sizeof a->release_scratch);
    bool ok=te_v3_shared_capture_window_release(a->capture,&a->release_scratch);
    memset(&a->release_scratch,0,sizeof a->release_scratch);
    if(!ok)return false;
    a->released=true; return true;
}
static bool valid(te_runtime_window_adapter_t *a) {
    return a && a->queue && a->capture && a->control && a->freeze && a->freeze->sha256 &&
        a->now && a->queue_ready && a->post_statistics;
}
static bool boot_uuid(const char *s);
static void secure_clear(void *p,size_t n) { volatile uint8_t *v=p; while(n--)*v++=0; }
static bool next_window_identity(te_runtime_window_adapter_t *a) {
    static const char hex[]="0123456789abcdef";
    uint8_t raw[16]; char id[37]; unsigned j=0; bool nonzero=false;
    if(a->identity_fault || !a->entropy || !a->reserve_identity || !a->control || !a->freeze ||
       (a->identity_active && !a->sent) ||
       !memchr(a->control->boot_id,0,sizeof a->control->boot_id) || !boot_uuid(a->control->boot_id) ||
       !memchr(a->control->node_id,0,sizeof a->control->node_id) || !a->control->node_id[0] ||
       a->window_seq==UINT32_MAX || a->window_id_count>=TE_RT_WINDOW_IDS_MAX ||
       (a->window_id_count && strcmp(a->identity_boot,a->control->boot_id)) ||
       !a->entropy(a->io,raw))return false;
    for(unsigned i=0;i<16;i++)nonzero |= raw[i]!=0;
    if(!nonzero) { secure_clear(raw,sizeof raw); return false; }
    raw[6]=(uint8_t)((raw[6]&15u)|0x40u); raw[8]=(uint8_t)((raw[8]&63u)|0x80u);
    for(unsigned i=0;i<16;i++) {
        if(i==4||i==6||i==8||i==10)id[j++]='-';
        id[j++]=hex[raw[i]>>4];id[j++]=hex[raw[i]&15];
    }
    id[j]=0; secure_clear(raw,sizeof raw);
    for(unsigned i=0;i<a->window_id_count;i++)if(!strcmp(id,a->window_ids[i]))return false;
    if((memchr(a->ack_batch_id,0,sizeof a->ack_batch_id) && !strcmp(id,a->ack_batch_id)) ||
       (memchr(a->lease_batch_id,0,sizeof a->lease_batch_id) && !strcmp(id,a->lease_batch_id)))return false;
    uint32_t seq=a->window_seq+1;
    if(!a->reserve_identity(a->io,a->control->node_id,a->control->boot_id,id,seq))return false;
    /* Only now may a successfully reclaimed prior window be discarded. */
    if(a->sent) {
        secure_clear(&a->handoff,sizeof a->handoff); secure_clear(a->readback,sizeof a->readback);
        secure_clear(a->receipt,sizeof a->receipt); secure_clear(&a->stored_identity,sizeof a->stored_identity);
        secure_clear(a->stored_hash,sizeof a->stored_hash); a->stored=a->released=a->sent=false;
    }
    if(!a->window_id_count)memcpy(a->identity_boot,a->control->boot_id,sizeof a->identity_boot);
    memcpy(a->window_ids[a->window_id_count++],id,sizeof id);
    memcpy(a->freeze->batch_id,id,sizeof id); a->freeze->seq=seq; a->window_seq=seq; a->identity_active=true;
    return true;
}
static bool bounds(cp_v3_time_t t,uint64_t *lo,uint64_t *hi) {
    if (!t.clock_epoch || !t.utc_ms || t.utc_ms<t.uncertainty_ms ||
        t.utc_ms>UINT64_MAX-t.uncertainty_ms) return false;
    *lo=t.utc_ms-t.uncertainty_ms; *hi=t.utc_ms+t.uncertainty_ms; return true;
}
static bool boot_uuid(const char *s) {
    if(!s || strlen(s)!=36 || s[14]!='4' || !strchr("89ab",s[19]))return false;
    for(unsigned i=0;i<36;i++) {
        if(i==8||i==13||i==18||i==23) {if(s[i]!='-')return false;}
        else if(!((s[i]>='0'&&s[i]<='9')||(s[i]>='a'&&s[i]<='f')))return false;
    }
    return true;
}
static te_runtime_result_t recover_control(te_runtime_window_adapter_t *a);
static te_runtime_result_t connect_transport(te_runtime_window_adapter_t *a) {
    if(!a->settings || !a->transport_config || !a->capability || !a->capability->boot_id[0] ||
       !boot_uuid(a->capability->boot_id) || a->transport_started)return TE_RT_FAIL;
    if(cp_v3_transport_start(a->settings,a->transport_config)!=ESP_OK)return TE_RT_FAIL;
    a->transport_started=true;
    /* start establishes Wi-Fi, not TLS. A completed request establishes a
     * verified TLS session even if this pre-registration GET returns 4xx. */
    char path[96]; int n=snprintf(path,sizeof path,"/api/v3/device/config?boot_id=%s",a->capability->boot_id);
    cp_v3_transport_response_t response={0};
    if(n<=0 || (size_t)n>=sizeof path ||
       cp_v3_transport_request(CP_V3_HTTP_GET,path,NULL,0,(char *)a->receipt,sizeof a->receipt,&response)!=ESP_OK ||
       !response.complete || response.stage!=CP_V3_TRANSPORT_COMPLETE || response.tls_verify_flags ||
       response.tls_connected!=1)return TE_RT_FAIL;
    a->tls_verified=true;
    /* Registration capabilities require all three NVS keys free. Recover
     * historical exact records before registration, with no current-boot
     * control or lease authority. At most three live keys exist. */
    for(unsigned i=0;i<4;i++) {
        te_runtime_result_t r=recover_control(a);
        if(r==TE_RT_EMPTY)return TE_RT_OK;
        if(r!=TE_RT_OK)return TE_RT_FAIL;
    }
    return TE_RT_FAIL;
}
static te_runtime_result_t register_capabilities(te_runtime_window_adapter_t *a) {
    cp_v3_time_t now; uint64_t lo,hi; size_t length=0; const char *body=NULL;
    if(!a->tls_verified || !a->recovery_complete || a->registered || !a->workspace || !a->uplink_budget ||
       !a->budget_lock || !a->budget_unlock || !a->registration_seq || !a->queue->opened ||
       strcmp(a->queue->queue.node_id,a->capability->node_id) ||
       strcmp(a->queue->queue.boot_id,a->capability->boot_id) ||
       cp_v3_transport_time(&now)!=ESP_OK || !bounds(now,&lo,&hi) ||
       te_v3_capabilities_build(a->capability,lo,hi,a->capability_json,sizeof a->capability_json,&length)!=TE_V3_CAPABILITIES_OK ||
       cp_v3_control_init(a->control,a->workspace,a->capability->node_id,a->capability->boot_id,
                          a->capability_json,length,now,cp_v3_transport_sha256,NULL)!=CP_V3_CONTROL_OK ||
       cp_v3_control_registration(a->control,a->registration_seq,now.mono_ms,&body,&length)!=CP_V3_CONTROL_OK ||
       !body || !length || !a->budget_lock(a->io))return TE_RT_FAIL;
    cp_v3_budget_result_t charge=cp_v3_budget_charge(a->uplink_budget,length,lo,hi);
    a->budget_unlock(a->io);
    if(charge!=CP_V3_BUDGET_OK)return TE_RT_FAIL;
    cp_v3_transport_response_t response={0};
    if(cp_v3_transport_request(CP_V3_HTTP_POST,"/api/v3/device/capabilities",body,length,
       (char *)a->receipt,sizeof a->receipt,&response)!=ESP_OK || !response.complete ||
       response.stage!=CP_V3_TRANSPORT_COMPLETE || response.tls_connected!=1 || response.tls_verify_flags ||
       response.http_status<200 || response.http_status>=300 || !response.body_bytes ||
       response.body_bytes>sizeof a->receipt || cp_v3_transport_time(&now)!=ESP_OK ||
       cp_v3_control_registration_receipt(a->control,a->receipt,response.body_bytes,now)!=CP_V3_CONTROL_OK)
        return TE_RT_FAIL;
    a->registered=true; return TE_RT_OK;
}
static te_runtime_result_t validate_policy(te_runtime_window_adapter_t *a) {
    cp_v3_time_t now; uint64_t lo,hi; cp_v3_transport_response_t response={0};
    char path[96];
    if(!a->registered || !a->control || !a->queue || !a->queue->opened ||
       !a->queue->config.write_budget || !a->queue->config.write_budget->opened ||
       !a->queue->config.write_budget->configured || !a->actual_apply || !a->apply_seq ||
       a->closed_boundary.window_open || a->closed_boundary.segment_open ||
       cp_v3_transport_time(&now)!=ESP_OK || !bounds(now,&lo,&hi))return TE_RT_FAIL;
    int n=snprintf(path,sizeof path,"/api/v3/device/config?boot_id=%s",a->capability->boot_id);
    if(n<=0 || (size_t)n>=sizeof path ||
       cp_v3_transport_request(CP_V3_HTTP_GET,path,NULL,0,(char *)a->receipt,sizeof a->receipt,&response)!=ESP_OK ||
       !response.complete || response.stage!=CP_V3_TRANSPORT_COMPLETE || response.tls_connected!=1 ||
       response.tls_verify_flags || response.http_status<200 || response.http_status>=300 ||
       !response.body_bytes || response.body_bytes>sizeof a->receipt ||
       cp_v3_transport_time(&now)!=ESP_OK || !bounds(now,&lo,&hi) ||
       cp_v3_control_offer(a->control,a->receipt,response.body_bytes,now)!=CP_V3_CONTROL_OK)return TE_RT_FAIL;
    /* This adapter implements window statistics only. */
    if(!a->control->policy.statistics || a->control->policy.local_raw.enabled ||
       a->control->policy.candidate_events ||
       cp_v3_control_apply(a->control,now,a->closed_boundary,a->apply_seq,a->actual_apply,a->apply_context)!=CP_V3_CONTROL_OK ||
       a->control->state!=CP_V3_CONTROL_ACK_PENDING || a->control->apply_result!=CP_V3_APPLY_OK)
        return TE_RT_FAIL;
    return TE_RT_OK;
}
static bool strict_control(void *context,const cp_v3_expected_t *e,const void *body,size_t n,const void *receipt,size_t rn) {
    te_runtime_window_adapter_t *a=context;
    return cp_v3_control_match_frozen_receipt(a->workspace,&e->scope,body,n,receipt,rn,
                                               cp_v3_transport_sha256,NULL)==CP_V3_CONTROL_OK;
}
static te_runtime_result_t recover_small(te_runtime_window_adapter_t *a,cp_v3_queue_kind_t kind,unsigned slot) {
    cp_v3_expected_t e={0}; size_t n=0,rn=0; cp_v3_time_t now; uint64_t lo,hi;
    te_v3_small_queue_result_t read=te_v3_small_queue_read(a->queue,slot,a->readback,sizeof a->readback,&n,&e);
    /* A trusted, budgeted queue sweep durably tombstoned this expired record;
     * this is expiry, not an upload receipt. Re-scan remaining records. */
    if(read==TE_SMALL_QUEUE_EXPIRED)return TE_RT_OK;
    const char *stream=kind==CP_V3_QUEUE_WINDOW?"window_statistics":"node_status";
    if(read!=TE_SMALL_QUEUE_OK || !n || strcmp(e.stream,stream) ||
       strcmp(e.scope.node_id,a->capability->node_id) || !strcmp(e.scope.boot_id,a->capability->boot_id) ||
       !a->historical_aged || !a->historical_authorized || !a->post_statistics || cp_v3_transport_time(&now)!=ESP_OK ||
       !bounds(now,&lo,&hi) || !a->historical_aged(a->io,a->readback,n,&e,now) ||
       !a->historical_authorized(a->io,kind,a->readback,n,&e,now) || !a->budget_lock(a->io))return TE_RT_FAIL;
    cp_v3_budget_result_t charge=cp_v3_budget_charge(a->uplink_budget,n,lo,hi);
    a->budget_unlock(a->io);
    if(charge!=CP_V3_BUDGET_OK ||
       !a->post_statistics(a->io,a->readback,n,&e,a->receipt,sizeof a->receipt,&rn) || !rn || rn>sizeof a->receipt ||
       !cp_v3_statistics_receipt_matches(a->receipt,rn,&e) ||
       te_v3_small_queue_ack(a->queue,slot,a->receipt,rn)!=TE_SMALL_QUEUE_OK)return TE_RT_FAIL;
    return TE_RT_OK;
}
static te_runtime_result_t recover_control(te_runtime_window_adapter_t *a) {
    if(!a->tls_verified || !a->capability || !a->queue || !a->queue->opened || !a->workspace ||
       !a->uplink_budget || !a->budget_lock || !a->budget_unlock ||
       !a->queue->config.write_budget || !a->queue->config.write_budget->opened ||
       !a->queue->config.write_budget->configured ||
       strcmp(a->queue->queue.node_id,a->capability->node_id) ||
       strcmp(a->queue->queue.boot_id,a->capability->boot_id))
        return TE_RT_FAIL;
    unsigned slot=0;
    te_v3_small_queue_result_t r=te_v3_small_queue_oldest(a->queue,CP_V3_QUEUE_CONTROL,&slot);
    if(r==TE_SMALL_QUEUE_NOT_FOUND) {
        r=te_v3_small_queue_oldest(a->queue,CP_V3_QUEUE_WINDOW,&slot);
        if(r==TE_SMALL_QUEUE_OK)return recover_small(a,CP_V3_QUEUE_WINDOW,slot);
        if(r!=TE_SMALL_QUEUE_NOT_FOUND)return TE_RT_FAIL;
        r=te_v3_small_queue_oldest(a->queue,CP_V3_QUEUE_STATUS,&slot);
        if(r==TE_SMALL_QUEUE_OK)return recover_small(a,CP_V3_QUEUE_STATUS,slot);
        if(r!=TE_SMALL_QUEUE_NOT_FOUND || !a->backlog_audit_empty || !a->backlog_audit_empty(a->io))return TE_RT_FAIL;
        a->recovery_complete=true; return TE_RT_EMPTY;
    }
    if(r!=TE_SMALL_QUEUE_OK)return TE_RT_FAIL;
    cp_v3_expected_t e={0}; size_t n=0;
    r=te_v3_small_queue_read(a->queue,slot,a->readback,sizeof a->readback,&n,&e);
    if(r==TE_SMALL_QUEUE_EXPIRED)return TE_RT_OK;
    if(r!=TE_SMALL_QUEUE_OK || !n || strcmp(e.scope.node_id,a->capability->node_id) ||
       !strcmp(e.scope.boot_id,a->capability->boot_id))return TE_RT_FAIL;
    const char *path=!strcmp(e.stream,"config_ack")?"/api/v3/device/config/ack":
                     !strcmp(e.stream,"lease")?"/api/v3/device/lease":NULL;
    cp_v3_time_t now; uint64_t lo,hi;
    if(!path || !a->historical_authorized || cp_v3_transport_time(&now)!=ESP_OK || !bounds(now,&lo,&hi) ||
       !a->historical_authorized(a->io,CP_V3_QUEUE_CONTROL,a->readback,n,&e,now) || !a->budget_lock(a->io))return TE_RT_FAIL;
    cp_v3_budget_result_t charge=cp_v3_budget_charge(a->uplink_budget,n,lo,hi);
    a->budget_unlock(a->io);
    if(charge!=CP_V3_BUDGET_OK)return TE_RT_FAIL;
    cp_v3_transport_response_t response={0};
    if(cp_v3_transport_request_receipt_only(CP_V3_HTTP_POST,path,a->readback,n,(char *)a->receipt,sizeof a->receipt,&response)!=ESP_OK ||
       !response.complete || response.stage!=CP_V3_TRANSPORT_COMPLETE || response.tls_connected!=1 ||
       response.tls_verify_flags || response.http_status<200 || response.http_status>=300 || !response.body_bytes ||
       response.body_bytes>sizeof a->receipt || !strict_control(a,&e,a->readback,n,a->receipt,response.body_bytes) ||
       te_v3_small_queue_ack_control(a->queue,slot,a->receipt,response.body_bytes,strict_control,a)!=TE_SMALL_QUEUE_OK)
        return TE_RT_FAIL;
    /* This only reclaims the original committed record; it does not update
     * the current control state or grant current-boot capture authority. */
    return TE_RT_OK;
}
static bool freeze_control(te_runtime_window_adapter_t *a,const char *stream,const char batch[37],
                           uint32_t seq,const void *body,size_t n) {
    uint8_t digest[32]; static const char hex[]="0123456789abcdef";
    if(!seq || !body || !n || n>sizeof a->control_body || !memchr(batch,0,37) || !boot_uuid(batch) ||
       !cp_v3_transport_sha256(NULL,body,n,digest))return false;
    cp_v3_expected_t e={0}; e.scope=a->control->policy.scope;
    memcpy(e.batch_id,batch,37); strcpy(e.stream,stream);
    e.seq_first=e.seq_last=seq; e.accepted_count=1; e.body_bytes=n;
    for(unsigned i=0;i<32;i++){e.body_sha256[2*i]=hex[digest[i]>>4];e.body_sha256[2*i+1]=hex[digest[i]&15];}
    memcpy(a->control_body,body,n); a->control_length=n; a->control_expected=e; return true;
}
static bool persist_control(te_runtime_window_adapter_t *a) {
    cp_v3_expected_t e={0}; size_t n=0;
    if(!a->control_length || !a->control->policy.accept_until_utc_ms ||
       te_v3_small_queue_push(a->queue,CP_V3_QUEUE_CONTROL,&a->control_expected,a->control_body,
           a->control_length,a->control->policy.accept_until_utc_ms,&a->control_slot)!=TE_SMALL_QUEUE_OK ||
       te_v3_small_queue_read(a->queue,a->control_slot,a->readback,sizeof a->readback,&n,&e)!=TE_SMALL_QUEUE_OK ||
       n!=a->control_length || memcmp(a->readback,a->control_body,n) ||
       memcmp(&e,&a->control_expected,sizeof e))return false;
    return true;
}
static bool exchange_control(te_runtime_window_adapter_t *a,const char *path,bool lease) {
    cp_v3_time_t now; uint64_t lo,hi; cp_v3_expected_t e={0}; size_t n=0;
    if(te_v3_small_queue_read(a->queue,a->control_slot,a->readback,sizeof a->readback,&n,&e)!=TE_SMALL_QUEUE_OK ||
       n!=a->control_length || memcmp(a->readback,a->control_body,n) ||
       memcmp(&e,&a->control_expected,sizeof e) || cp_v3_transport_time(&now)!=ESP_OK ||
       !bounds(now,&lo,&hi) || !a->budget_lock(a->io))return false;
    cp_v3_budget_result_t charged=cp_v3_budget_charge(a->uplink_budget,n,lo,hi);
    a->budget_unlock(a->io);
    if(charged!=CP_V3_BUDGET_OK)return false;
    cp_v3_transport_response_t response={0};
    if(cp_v3_transport_request(CP_V3_HTTP_POST,path,a->readback,n,(char *)a->receipt,sizeof a->receipt,&response)!=ESP_OK ||
       !response.complete || response.stage!=CP_V3_TRANSPORT_COMPLETE || response.tls_connected!=1 ||
       response.tls_verify_flags || response.http_status<200 || response.http_status>=300 || !response.body_bytes ||
       response.body_bytes>sizeof a->receipt ||
       !strict_control(a,&e,a->readback,n,a->receipt,response.body_bytes) ||
       cp_v3_transport_time(&now)!=ESP_OK)return false;
    cp_v3_control_result_t verified=lease ?
        cp_v3_control_lease_receipt(a->control,a->receipt,response.body_bytes,now) :
        cp_v3_control_ack_receipt(a->control,a->receipt,response.body_bytes,now);
    if(verified!=CP_V3_CONTROL_OK)return false;
    return te_v3_small_queue_ack_control(a->queue,a->control_slot,a->receipt,response.body_bytes,strict_control,a)==TE_SMALL_QUEUE_OK;
}
static te_runtime_result_t control_phase(te_runtime_window_adapter_t *a,te_runtime_phase_t phase) {
    if(!a->registered || !a->recovery_complete || !a->queue || !a->control || !a->workspace ||
       !a->uplink_budget || !a->budget_lock || !a->budget_unlock)return TE_RT_FAIL;
    switch(phase) {
    case TE_RT_ACK_FREEZE: {
        size_t n=0; const char *body=cp_v3_control_ack_bytes(a->control,&n);
        if(a->ack_frozen || a->control->state!=CP_V3_CONTROL_ACK_PENDING ||
           a->control->apply_result!=CP_V3_APPLY_OK || a->control->apply_seq!=a->apply_seq ||
           !freeze_control(a,"config_ack",a->ack_batch_id,a->apply_seq,body,n))return TE_RT_FAIL;
        a->ack_frozen=true; return TE_RT_OK;
    }
    case TE_RT_ACK_STORE:
        if(!a->ack_frozen || a->ack_stored || !persist_control(a))return TE_RT_FAIL;
        a->ack_stored=true; return TE_RT_OK;
    case TE_RT_ACK_SEND:
        if(!a->ack_stored || a->ack_committed || !exchange_control(a,"/api/v3/device/config/ack",false))return TE_RT_FAIL;
        a->ack_committed=true; return TE_RT_OK;
    case TE_RT_LEASE: {
        cp_v3_time_t now; const char *body=NULL; size_t n=0;
        if(!a->ack_committed || a->lease_committed || !a->lease_contact_seq ||
           !memcmp(a->ack_batch_id,a->lease_batch_id,sizeof a->ack_batch_id) ||
           cp_v3_transport_time(&now)!=ESP_OK ||
           cp_v3_control_lease_request(a->control,a->lease_contact_seq,now.mono_ms,&body,&n)!=CP_V3_CONTROL_OK ||
           !freeze_control(a,"lease",a->lease_batch_id,a->lease_contact_seq,body,n) ||
           !persist_control(a) || !exchange_control(a,"/api/v3/device/lease",true))return TE_RT_FAIL;
        a->lease_committed=true; return TE_RT_OK;
    }
    case TE_RT_START: {
        cp_v3_time_t now;
        if(!a->ack_committed || !a->lease_committed || !a->capture || !a->queue_ready || !a->next_window_seq ||
           cp_v3_transport_time(&now)!=ESP_OK || !a->queue_ready(a->io) ||
           te_v3_shared_capture_start(a->capture,a->control,now,a->next_window_seq,true)!=ESP_OK)return TE_RT_FAIL;
        return TE_RT_OK;
    }
    default: return TE_RT_FAIL;
    }
}
te_runtime_result_t te_runtime_window_perform(void *p,te_runtime_phase_t phase) {
    te_runtime_window_adapter_t *a=p;
    if(!a)return TE_RT_FAIL;
    if(phase==TE_RT_CONNECT)return connect_transport(a);
    if(phase==TE_RT_REGISTER)return a->queue && a->control && a->capability ? register_capabilities(a) : TE_RT_FAIL;
    if(phase==TE_RT_VALIDATE)return a->capability ? validate_policy(a) : TE_RT_FAIL;
    if(phase==TE_RT_RECOVER)return a->capability ? recover_control(a) : TE_RT_FAIL;
    if(phase>=TE_RT_ACK_FREEZE && phase<=TE_RT_START)return control_phase(a,phase);
    if(!valid(a))return TE_RT_FAIL;
    if(phase==TE_RT_MONITOR) {
        cp_v3_time_t now={0};
        return a->now(a->io,&now) && te_v3_shared_capture_maintain(a->capture,a->control,now,a->queue_ready(a->io))==ESP_OK ? TE_RT_OK : TE_RT_FAIL;
    }
    if(phase==TE_RT_SEND) {
        cp_v3_expected_t e={0}; size_t n=0,rn=0; uint8_t digest[32];
        cp_v3_time_t now; uint64_t lo,hi;
        if(!a->stored || !a->released || a->sent ||
           te_v3_small_queue_read(a->queue,a->slot,a->readback,sizeof a->readback,&n,&e)!=TE_SMALL_QUEUE_OK || !n || memcmp(&e,&a->stored_identity,sizeof e) ||
           !hash(a,a->readback,n,digest) || memcmp(digest,a->stored_hash,32) || !a->uplink_budget ||
           !a->budget_lock || !a->budget_unlock || cp_v3_transport_time(&now)!=ESP_OK || !bounds(now,&lo,&hi) ||
           !a->budget_lock(a->io))return TE_RT_FAIL;
        cp_v3_budget_result_t charged=cp_v3_budget_charge(a->uplink_budget,n,lo,hi);
        a->budget_unlock(a->io);
        if(charged!=CP_V3_BUDGET_OK || !a->post_statistics(a->io,a->readback,n,&e,a->receipt,sizeof a->receipt,&rn) || !rn || rn>sizeof a->receipt ||
           !cp_v3_statistics_receipt_matches(a->receipt,rn,&e) ||
           te_v3_small_queue_ack(a->queue,a->slot,a->receipt,rn)!=TE_SMALL_QUEUE_OK)return TE_RT_FAIL;
        a->sent=true; return TE_RT_OK;
    }
    te_handoff_state_t expected;
    switch(phase) {
    case TE_RT_PEEK:
        expected=TE_HANDOFF_EMPTY;
        if((a->stored || a->released) && !a->sent)return TE_RT_FAIL;
        if(a->handoff.state!=expected)return TE_RT_FAIL;
        if(!next_window_identity(a)) {a->identity_fault=true; return TE_RT_FAIL;}
        break;
    case TE_RT_FREEZE: expected=TE_HANDOFF_STAGED; break;
    case TE_RT_STORE: expected=TE_HANDOFF_FROZEN; break;
    case TE_RT_RELEASE: expected=TE_HANDOFF_DURABLE; break;
    default: return TE_RT_FAIL;
    }
    if(a->handoff.state!=expected)return TE_RT_FAIL;
    te_handoff_ops_t ops={admit,peek,freeze,hash,store,release,a};
    return te_handoff_step(&a->handoff,&ops)==TE_STEP_PROGRESS ? TE_RT_OK : TE_RT_FAIL;
}
bool te_runtime_window_pause(void *p) {
    te_runtime_window_adapter_t *a=p;
    return a && a->capture && te_v3_shared_capture_pause(a->capture,CP_V3_TEMPORAL_SCAN_GAP,0)==ESP_OK;
}
