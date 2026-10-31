#include "cp_v3_small_results.h"
#include <assert.h>
#include <openssl/sha.h>
#include <stdio.h>
#include <string.h>

static const char *batch="00000000-0000-4000-8000-000000000001";
static bool hash(void *ctx,const void *p,size_t n,uint8_t out[32]) { (void)ctx; return SHA256(p,n,out)!=NULL; }
static cp_v3_scope_t scope(void) {
    cp_v3_scope_t s={.assignment_generation=1,.window_seq=1}; strcpy(s.node_id,"synthetic-template-only");
    strcpy(s.boot_id,"00000000-0000-4000-8000-000000000002"); strcpy(s.policy_id,"synthetic-template-policy");
    strcpy(s.placement_id,"synthetic-place"); memset(s.policy_sha256,'0',64); strcpy(s.dataset,"controlled_test"); return s;
}
static cp_v3_small_time_t time_at(uint64_t ms) {
    return (cp_v3_small_time_t){.mono_ms=ms,.utc_ms=1898553600000ULL+ms,.clock_epoch=1,.utc_known=true};
}
static cp_v3_stats_snapshot_t snapshot(unsigned duration) {
    cp_v3_stats_snapshot_t s={.capacity=512,.unique_keys=2,.window_ms=duration,.duration_ms=duration,.bin_ms=5000,
        .window_closed=true,.received_reports_known=true,.callback_drops_known=true,.aggregation_drops_known=true};
    s.bin_count=duration/5000; s.configured_bins=s.bin_count; s.snapshot_mono_us=s.end_mono_us=(uint64_t)duration*1000;
    s.counts[CP_V3_STATS_UNKNOWN]=2; s.received_reports=s.worker_reports=s.rssi_samples=s.bin_count*10;
    s.adv_reports=s.bin_count*8; s.scan_response_reports=s.bin_count*2; s.rssi_sum=-(int64_t)s.bin_count*600;
    s.rssi_min=s.rssi_max=-60; s.scan_coverage_ms=duration;
    strcpy(s.rules_version,CP_V3_SMALL_RULESET); strcpy(s.extractor_version,CP_V3_STATS_VERSION);
    for(unsigned i=0;i<s.bin_count;i++) s.bins[i]=(cp_v3_stats_bin_t){.reports=10,.rssi_samples=10,.rssi_sum=-600,.unique_keys=2};
    return s;
}
static void emit(const char *body,size_t bytes,const cp_v3_expected_t *e,unsigned duration,bool raw,bool fixtures) {
    assert(bytes==strlen(body)&&bytes==e->body_bytes&&e->accepted_count==1);
    assert(!strstr(body,"address")&&!strstr(body,"payload")&&!strstr(body,"secret"));
    if(fixtures) printf("{\"body\":%s,\"sha256\":\"%s\",\"window_ms\":%u,\"local_raw\":%s,\"event_max_ms\":3600000}\n",body,e->body_sha256,duration,raw?"true":"false");
}
int main(int argc,char **argv) {
    bool fixtures=argc==2&&!strcmp(argv[1],"fixtures"); cp_v3_scope_t s=scope();
    char body[4096],again[4096]; size_t bytes,more; cp_v3_expected_t expected,duplicate;
    for(unsigned duration=30000;duration<=60000;duration+=30000) {
        cp_v3_stats_snapshot_t w=snapshot(duration); cp_v3_small_time_t end=time_at(duration);
        assert(cp_v3_small_window_body(&s,&w,end,batch,1,hash,NULL,body,sizeof body,&bytes,&expected)==CP_V3_OK);
        assert(cp_v3_small_window_body(&s,&w,end,batch,1,hash,NULL,again,sizeof again,&more,&duplicate)==CP_V3_OK);
        assert(bytes==more&&!memcmp(body,again,bytes)&&!strcmp(expected.body_sha256,duplicate.body_sha256));
        emit(body,bytes,&expected,duration,false,fixtures);
        if(!fixtures) printf("compact synthetic window%us=%zu bytes\n",duration/1000,bytes);
        end.utc_known=false;
        assert(cp_v3_small_window_body(&s,&w,end,batch,1,hash,NULL,body,sizeof body,&bytes,&expected)==CP_V3_OK);
        assert(strstr(body,"null,1,null")&&strstr(body,"\"f\":2")); emit(body,bytes,&expected,duration,false,fixtures);
        end=time_at(duration); w.bins[0].reports++;
        assert(cp_v3_small_window_body(&s,&w,end,batch,1,hash,NULL,body,sizeof body,&bytes,&expected)==CP_V3_INVALID&&bytes==0);
        w=snapshot(duration); w.received_reports_known=false;
        assert(cp_v3_small_window_body(&s,&w,end,batch,1,hash,NULL,body,sizeof body,&bytes,&expected)==CP_V3_INVALID);
        w=snapshot(duration); w.counts[CP_V3_STATS_UNKNOWN]--; w.counts[CP_V3_STATS_PHONE_RELATED]++;
        assert(cp_v3_small_window_body(&s,&w,end,batch,1,hash,NULL,body,sizeof body,&bytes,&expected)==CP_V3_UNSUPPORTED);
        w=snapshot(duration); assert(cp_v3_small_window_body(&s,&w,end,batch,1,hash,NULL,body,128,&bytes,&expected)==CP_V3_OUTPUT_FULL&&bytes==0&&!body[0]);
    }
    cp_v3_temporal_event_t event={.revision=1,.state=CP_V3_TEMPORAL_CLOSED,.reason=CP_V3_TEMPORAL_OBSERVED_GAP,
        .start=time_at(1000),.last_seen=time_at(3000),.observed_until=time_at(6000),.end=time_at(6000),.reports=3,.present_slices=3,
        .absent_slices=3,.coverage_ms=5000,.rssi_n=3,.rssi_sum=-180,.rssi_min=-60,.rssi_max=-60};
    event.event_id[6]=0x40; event.event_id[8]=0x80; event.event_id[15]=3;
    assert(cp_v3_small_event_body(&s,&event,1000,batch,1,hash,NULL,body,sizeof body,&bytes,&expected)==CP_V3_OK);
    emit(body,bytes,&expected,30000,false,fixtures); if(!fixtures) printf("compact synthetic event=%zu bytes\n",bytes);
    event.state=CP_V3_TEMPORAL_CENSORED; event.reason=CP_V3_TEMPORAL_TIMEOUT;
    assert(cp_v3_small_event_body(&s,&event,1000,batch,1,hash,NULL,body,sizeof body,&bytes,&expected)==CP_V3_OK);
    emit(body,bytes,&expected,30000,false,fixtures);
    event.observed_until=time_at(4000);event.coverage_ms=3000;event.absent_slices=1;
    assert(cp_v3_small_event_body(&s,&event,1000,batch,1,hash,NULL,body,sizeof body,&bytes,&expected)==CP_V3_OK);
    emit(body,bytes,&expected,30000,false,fixtures);
    event.state=CP_V3_TEMPORAL_CLOSED;event.reason=CP_V3_TEMPORAL_OBSERVED_GAP;
    event.last_seen=time_at(701000);event.observed_until=event.end=time_at(711000);
    event.reports=event.present_slices=event.rssi_n=701;event.absent_slices=10;
    event.coverage_ms=710000;event.rssi_sum=-42060;event.quality_mask=CP_V3_TEMPORAL_HISTORY_TRUNCATED;
    assert(cp_v3_small_event_body(&s,&event,1000,batch,1,hash,NULL,body,sizeof body,&bytes,&expected)==CP_V3_OK);
    emit(body,bytes,&expected,30000,false,fixtures);
    event.rssi_sum=-1000; assert(cp_v3_small_event_body(&s,&event,1000,batch,1,hash,NULL,body,sizeof body,&bytes,&expected)==CP_V3_INVALID);
    cp_v3_small_status_t status={.time=time_at(60000),.state=CP_V3_SMALL_RUNNING,.queue={1,700,0,0,1,500}};
    assert(cp_v3_small_status_body(&s,&status,batch,1,hash,NULL,body,sizeof body,&bytes,&expected)==CP_V3_OK);
    emit(body,bytes,&expected,30000,false,fixtures); if(!fixtures) printf("compact synthetic status=%zu bytes\n",bytes);
    status.local_raw_counters_known=true; status.local_raw[0]=100; status.local_raw[1]=99; status.local_raw[2]=90; status.local_raw[3]=1;
    assert(cp_v3_small_status_body(&s,&status,batch,1,hash,NULL,body,sizeof body,&bytes,&expected)==CP_V3_OK);
    emit(body,bytes,&expected,30000,true,fixtures);
    status.resources[0]=100; status.resources[1]=101; status.resource_known_mask=3;
    assert(cp_v3_small_status_body(&s,&status,batch,1,hash,NULL,body,sizeof body,&bytes,&expected)==CP_V3_INVALID);
    return 0;
}
