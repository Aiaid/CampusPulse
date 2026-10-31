#include "board_capabilities.h"
#include "board_report.h"
#include "cp_v3_control.h"
#include "cp_v3_stats.h"
#include <assert.h>
#include <openssl/sha.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* All IDs, UTC, placement checks, CPU values and NVS values are synthetic.
 * malloc is a host arena, not proof that ESP32 PSRAM/NVS passed admission. */
#define ISSUED UINT64_C(1793318400000)
static cp_v3_control_t control;
static cp_v3_control_workspace_t workspace;
/* Frozen using the real backend statisticsPolicy/freezeDeviceConfigV3 fixture
 * with this test's --emit capability, 1024-byte bodies, three 1024-byte reserves
 * and measured synthetic resource budgets. No clock/network/account required.
 * Optional argv[1] permits independent regenerated-backend parity checks. */
static const char backend_response[]=
    "{\"protocol\":\"campuspulse/3\",\"server_time\":\"2026-10-30T00:01:00.000Z\",\"data_ingestion_available\":true"
    ",\"requires_device_ack\":true,\"config\":{\"schema\":\"device-config-envelope/3\",\"policy\":{\"schema\":\"device"
    "-config/3\",\"protocol\":\"campuspulse/3\",\"policy_id\":\"synthetic-stats-notregister-1\",\"node_id\":\"synthet"
    "ic-te-notregister\",\"revision\":1,\"assignment_generation\":1,\"collection\":{\"enabled\":true,\"mode\":\"fixed"
    "_point\",\"scan\":{\"mode\":\"passive\",\"interval_units\":160,\"window_units\":160,\"duplicate_filter\":false,\"p"
    "hys\":[\"1m\"]},\"summary\":{\"enabled\":true,\"window_ms\":60000,\"bin_ms\":5000,\"max_addresses\":512}},\"local_"
    "raw\":{\"mode\":\"off\"},\"evidence\":{\"mode\":\"statistics\",\"schema\":\"window-statistics/1\",\"extractor_versio"
    "n\":\"cp-v3-stats/1\",\"ruleset_version\":\"unclassified-v1\"},\"temporal\":{\"mode\":\"rolling\",\"slice_ms\":2000"
    ",\"history_ms\":600000,\"max_event_ms\":3600000,\"max_tracks\":512,\"max_open_events\":64,\"gap_ms\":10000,\"re"
    "port_mode\":\"off\",\"min_update_ms\":60000},\"uplink\":{\"enabled\":true,\"transport\":\"https\",\"streams\":[\"win"
    "dow_statistics\",\"node_status\"],\"max_batch_items\":1,\"max_body_bytes\":1024,\"raw_sample\":{\"mode\":\"off\"}"
    ",\"archive\":{\"mode\":\"off\"},\"retry\":{\"min_delay_ms\":1000,\"max_delay_ms\":60000,\"max_attempts\":10}},\"loc"
    "al_queue\":{\"mode\":\"durable\",\"medium\":\"flash_journal\",\"max_bytes\":3072,\"max_items\":3,\"control_reserve"
    "_bytes\":1024,\"control_reserve_items\":1,\"stream_reserves\":[{\"stream\":\"window_statistics\",\"bytes\":1024"
    ",\"items\":1},{\"stream\":\"node_status\",\"bytes\":1024,\"items\":1}],\"high_water_percent\":80,\"full_behavior\""
    ":\"pause_collection\",\"recovery\":\"exact_frozen_batches\"},\"resources\":{\"working_bytes\":4194304,\"storage"
    "_write_bytes_per_day\":1048576},\"custody\":{\"dataset\":\"controlled_test\",\"purpose\":\"controlled_test\",\"p"
    "lacement_id\":\"synthetic-place-notregister\",\"association_scope\":\"window\",\"source_retention_hours\":1,\""
    "derived_retention_hours\":1,\"accept_until\":\"2026-10-30T02:01:00.000Z\",\"max_upload_bytes_per_day\":8388"
    "608},\"control\":{\"capability_sha256\":\"e4476e1cd82f6ac3e73f61e1e3ce7b7387afe6834d38a057df77b7c41b17ea4"
    "1\",\"activation\":{\"boot_id\":\"11111111-1111-4111-8111-111111111111\",\"boundary\":\"closed_window_and_segm"
    "ent\",\"after_window_seq\":3,\"after_segment_seq\":2,\"not_before\":\"2026-10-30T00:00:30.000Z\",\"expires_at\""
    ":\"2026-10-30T00:31:00.000Z\"},\"lease\":{\"duration_ms\":120000,\"on_collection_expiry\":\"pause\",\"on_raw_ex"
    "piry\":\"stop_recording\",\"on_uplink_expiry\":\"drain_frozen_until_accept_until\"}}},\"policy_sha256\":\"3c3c"
    "3ffc0cb193fef09cc840af36190a8fd0dcf18e76d3d7709de91a829fd806\"},\"reason\":null,\"applied_generation\":nu"
    "ll,\"activation_not_before\":\"2026-10-30T00:00:30.000Z\"}";
static bool hash(void *ctx,const void *p,size_t n,uint8_t out[32]) {
    (void)ctx; return SHA256(p,n,out)!=NULL;
}
static bool external(const void *p,void *ctx) {
    const te_v3_pools_t *pools=ctx;
    return p==pools->reports || p==pools->stats || p==pools->temporal;
}
static bool entropy(void *ctx,uint8_t id[16]) { (void)ctx; memset(id,1,16); return true; }
static cp_v3_time_t now(void) {
    return(cp_v3_time_t){.mono_ms=60000,.utc_ms=ISSUED+60000,.clock_epoch=1,.uncertainty_ms=10};
}
static void initialized(const te_v3_capability_request_t *r,const char *json,size_t n) {
    assert(cp_v3_control_init(&control,&workspace,r->node_id,r->boot_id,json,n,now(),hash,NULL)==CP_V3_CONTROL_OK);
    assert(control.small_statistics && !control.capability_tf_queue && !control.capability_local_raw &&
           !control.capability_events && !control.capability_tf_bytes && control.capability_body_bytes==1024 &&
           control.capability_queue_bytes==3072 && control.capability_queue_items==3 &&
           control.capability_addresses==r->max_addresses && control.capability_bins==r->max_bins);
    assert(control.capability_temporal==(r->temporal!=NULL));
    if(r->temporal) {
        assert(control.capability_report_modes==1 && control.temporal_cap.history_ms==r->temporal->history_ms &&
               control.temporal_cap.max_tracks==r->temporal->max_tracks &&
               control.temporal_cap.max_open_events==r->temporal->max_open_events);
    }
}
static void rejected(const te_v3_capability_request_t *r,uint64_t lo,uint64_t hi,te_v3_capability_result_t result) {
    char out[4096]="old-json"; size_t n=999;
    assert(te_v3_capabilities_build(r,lo,hi,out,sizeof out,&n)==result && n==0 && out[0]==0);
}
static void fixture(const te_v3_capability_request_t *r,const char *caps,size_t n,const char *response,size_t bytes) {
    initialized(r,caps,n);
    const char *body; size_t length;
    assert(cp_v3_control_registration(&control,1,60000,&body,&length)==CP_V3_CONTROL_OK && length);
    char reply[1024];
    int count=snprintf(reply,sizeof reply,"{\"protocol\":\"campuspulse/3\",\"node_id\":\"%s\",\"boot_id\":\"%s\","
        "\"registration_seq\":1,\"capability_sha256\":\"%s\",\"registered_at\":\"2026-10-30T00:01:00.000Z\","
        "\"applied\":false,\"capability_evidence\":\"device_claim\"}",r->node_id,r->boot_id,control.capability_sha256);
    assert(count>0 && (size_t)count<sizeof reply);
    assert(cp_v3_control_registration_receipt(&control,reply,(size_t)count,now())==CP_V3_CONTROL_OK);
    assert(cp_v3_control_offer(&control,response,bytes,now())==CP_V3_CONTROL_OK);
    assert(control.policy.statistics && !control.policy.candidate_events && !control.policy.local_raw.enabled &&
           control.policy.temporal.rolling && control.policy.temporal.history_ms==600000 &&
           control.policy.max_body_bytes==1024 && control.policy.queue_max_bytes==3072 &&
           control.policy.queue_max_items==3 && control.policy.control_reserve_items==1 &&
           control.policy.window_reserve_items==1 && control.policy.status_reserve_items==1 &&
           control.policy.event_reserve_items==0 && control.policy.control_reserve_bytes==1024 &&
           control.policy.window_reserve_bytes==1024 && control.policy.status_reserve_bytes==1024);
}
int main(int argc,char **argv) {
    assert(argc<=2);
    cp_v3_temporal_config_t temporal=cp_v3_temporal_default_config();
    te_v3_capability_evidence_t e={.measured_at_utc_ms=ISSUED,.valid_until_utc_ms=ISSUED+3600000,
        .external=external,.arenas_initialized_verified=true,.report_slots=16,
        .psram_free_bytes=4194304,.psram_headroom_bytes=524288,
        .internal_free_bytes=262144,.internal_headroom_bytes=131072,
        .storage_write_budget_bytes_per_day=1048576,.cpu_profile_verified=true,.scanner_profile_verified=true,
        .measured_cpu_us_per_window=100000,.cpu_budget_us_per_window=1000000,
        .queue_recovery_verified=true,.queue_power_loss_verified=true,.queue_budget_is_not_physical_reservation=true,
        .free_queue_slots=3,.queue_body_budget_bytes=3072,.queue_item_budget=3,.available_nvs_entries=332};
    e.allocated.reports=e.report_slots*sizeof(te_v3_report_t);
    e.allocated.stats=cp_v3_stats_memory_bytes(512);
    e.allocated.temporal=cp_v3_temporal_memory_bytes(&temporal);
    e.pools.reports=calloc(1,e.allocated.reports);e.pools.stats=malloc(e.allocated.stats);e.pools.temporal=malloc(e.allocated.temporal);
    assert(e.pools.reports&&e.pools.stats&&e.pools.temporal);
    e.external_context=&e.pools;
    cp_v3_stats_config_t stats={.capacity=512,.window_ms=60000,.bin_ms=5000,.rules_version="unclassified-v1"};
    assert(cp_v3_stats_init(e.pools.stats,e.allocated.stats,&stats));
    cp_v3_temporal_t *local;
    const cp_v3_temporal_context_t context={1,1,1};
    cp_v3_temporal_time_t time={.mono_ms=60000,.utc_ms=ISSUED+60000,.clock_epoch=1,.uncertainty_ms=10,.utc_known=true};
    assert(cp_v3_temporal_init(e.pools.temporal,e.allocated.temporal,&temporal,&context,time,entropy,NULL,&local)==CP_V3_TEMPORAL_OK);
    e.working_budget_bytes=4194304;
    te_v3_capability_request_t r={.node_id="synthetic-te-notregister",.capability_id="synthetic-te-caps",
        .boot_id="11111111-1111-4111-8111-111111111111",.issued_at_utc_ms=ISSUED,.expires_at_utc_ms=ISSUED+3600000,
        .max_addresses=512,.max_bins=12,.max_window_ms=60000,.min_scan_interval_units=4,.max_scan_interval_units=16384,
        .temporal=&temporal,.evidence=&e};
    char caps[4096];size_t n;
    assert(te_v3_capabilities_build(&r,ISSUED+59990,ISSUED+60010,caps,sizeof caps,&n)==TE_V3_CAPABILITIES_OK);
    initialized(&r,caps,n);
    assert(strstr(caps,"2026-10-30T00:00:00.000Z") && strstr(caps,"2026-10-30T01:00:00.000Z"));
    assert(!strstr(caps,"candidate_events")&&!strstr(caps,"tf_cpraw")&&!strstr(caps,"terminal_only"));
    char tight[4098]; memset(tight,'x',sizeof tight);size_t count;
    assert(te_v3_capabilities_build(&r,ISSUED+1,ISSUED+2,tight,n,&count)==TE_V3_CAPABILITIES_NO_SPACE && !count && !tight[0] && tight[n]=='x');
    assert(te_v3_capabilities_build(&r,ISSUED+1,ISSUED+2,tight,n+1,&count)==TE_V3_CAPABILITIES_OK && count==n && !tight[n] && tight[n+1]=='x');
    te_v3_capability_request_t bad=r;
#define INVALID(change) do { bad=r; change; rejected(&bad,ISSUED+1,ISSUED+2,TE_V3_CAPABILITIES_INVALID); } while(0)
    INVALID(bad.max_addresses=513);INVALID(bad.max_addresses=0);INVALID(bad.max_bins=13);
    INVALID(bad.max_bins=11);INVALID(bad.max_window_ms=45000);INVALID(bad.min_scan_interval_units=3);
    INVALID(bad.min_scan_interval_units=100;bad.max_scan_interval_units=99);
    INVALID(bad.max_scan_interval_units=16385);INVALID(bad.node_id[2]='"');
    INVALID(memset(bad.node_id,'a',sizeof bad.node_id));INVALID(bad.node_id[0]='_');
    INVALID(bad.node_id[2]=(char)200);
    INVALID(bad.capability_id[1]='\\');INVALID(bad.boot_id[14]='1');INVALID(bad.boot_id[19]='7');
    INVALID(bad.boot_id[1]=0);INVALID(bad.boot_id[1]='A');INVALID(bad.expires_at_utc_ms=ISSUED+1);
    INVALID(bad.issued_at_utc_ms=ISSUED+3);INVALID(bad.expires_at_utc_ms=UINT64_MAX);
#undef INVALID
    rejected(&r,ISSUED+2,ISSUED+1,TE_V3_CAPABILITIES_INVALID);
    count=99;
    assert(te_v3_capabilities_build(&r,ISSUED+1,ISSUED+2,NULL,0,&count)==TE_V3_CAPABILITIES_INVALID && !count);
    assert(te_v3_capabilities_build(&r,ISSUED+1,ISSUED+2,tight,sizeof tight,NULL)==TE_V3_CAPABILITIES_INVALID && !tight[0]);
    bad=r;memset(bad.node_id,'a',64);bad.node_id[64]=0;memset(bad.capability_id,'b',64);bad.capability_id[64]=0;
    assert(te_v3_capabilities_build(&bad,ISSUED+1,ISSUED+2,tight,sizeof tight,&count)==TE_V3_CAPABILITIES_OK);
    initialized(&bad,tight,count);assert(strstr(tight,bad.node_id)&&strstr(tight,bad.capability_id));
    te_v3_capability_evidence_t saved=e;
#define UNPROVEN(change) do { e=saved; change; rejected(&r,ISSUED+1,ISSUED+2,TE_V3_CAPABILITIES_UNPROVEN); } while(0)
    UNPROVEN(e.arenas_initialized_verified=false);UNPROVEN(e.external=NULL);
    UNPROVEN(e.pools.stats=NULL);UNPROVEN(e.allocated.stats--);UNPROVEN(e.allocated.temporal--);
    UNPROVEN(e.pools.stats=e.pools.reports);
    UNPROVEN(e.pools.temporal=(char *)e.pools.temporal+1);UNPROVEN(e.report_slots=SIZE_MAX);
    UNPROVEN(e.cpu_profile_verified=false);UNPROVEN(e.scanner_profile_verified=false);
    UNPROVEN(e.measured_cpu_us_per_window=e.cpu_budget_us_per_window+1);
    UNPROVEN(e.cpu_budget_us_per_window=60000001);UNPROVEN(e.measured_at_utc_ms=ISSUED+2);
    UNPROVEN(e.valid_until_utc_ms--);UNPROVEN(e.queue_recovery_verified=false);UNPROVEN(e.queue_power_loss_verified=false);
    UNPROVEN(e.queue_budget_is_not_physical_reservation=false);UNPROVEN(e.free_queue_slots=2);
    UNPROVEN(e.queue_body_budget_bytes=3071);UNPROVEN(e.queue_item_budget=2);UNPROVEN(e.available_nvs_entries=331);
    UNPROVEN(e.working_budget_bytes=1);UNPROVEN(e.working_budget_bytes=3727359);
    UNPROVEN(e.working_budget_bytes=(uint64_t)e.allocated.reports+e.allocated.stats+e.allocated.temporal+e.psram_free_bytes-e.psram_headroom_bytes+1);
    UNPROVEN(e.working_budget_bytes=UINT64_MAX);UNPROVEN(e.storage_write_budget_bytes_per_day=0);
    UNPROVEN(e.psram_free_bytes=e.psram_headroom_bytes-1);UNPROVEN(e.internal_free_bytes=e.internal_headroom_bytes-1);
    UNPROVEN(e.allocated.reports=SIZE_MAX);
#undef UNPROVEN
    e=saved;cp_v3_temporal_config_t invalid_temporal=temporal;bad=r;bad.temporal=&invalid_temporal;
    invalid_temporal.max_open_events=0;invalid_temporal.max_terminal_events=0;
    rejected(&bad,ISSUED+1,ISSUED+2,TE_V3_CAPABILITIES_UNPROVEN);
    bad=r;bad.temporal=NULL;e.pools.temporal=NULL;e.allocated.temporal=0;
    e.working_budget_bytes=e.allocated.reports+e.allocated.stats;
    assert(te_v3_capabilities_build(&bad,ISSUED+1,ISSUED+2,tight,sizeof tight,&count)==TE_V3_CAPABILITIES_OK);
    initialized(&bad,tight,count);assert(!strstr(tight,"\"temporal\""));
    e=saved;
    /* ISO generation uses full millisecond precision and Gregorian boundaries. */
    const uint64_t dates[]={0,UINT64_C(951782400123),UINT64_C(253402300798999)};
    const char *iso[]={"1970-01-01T00:00:00.000Z","2000-02-29T00:00:00.123Z","9999-12-31T23:59:58.999Z"};
    for(unsigned i=0;i<3;i++) {
        bad=r;bad.issued_at_utc_ms=dates[i];bad.expires_at_utc_ms=dates[i]+1000;
        e.measured_at_utc_ms=dates[i];e.valid_until_utc_ms=dates[i]+1000;
        assert(te_v3_capabilities_build(&bad,dates[i]+1,dates[i]+2,tight,sizeof tight,&count)==TE_V3_CAPABILITIES_OK);
        assert(strstr(tight,iso[i]));
    }
    e=saved;
    if(argc==2 && !strcmp(argv[1],"--emit")) puts(caps);
    else {
        fixture(&r,caps,n,backend_response,sizeof backend_response-1);
        if(argc==2) {
            char response[CP_V3_CONTROL_JSON_MAX]; FILE *f=fopen(argv[1],"rb"); assert(f);
            size_t bytes=fread(response,1,sizeof response,f); assert(!ferror(f)&&fgetc(f)==EOF); fclose(f);
            fixture(&r,caps,n,response,bytes);
        }
        puts("capabilities: strict control, measured rolling, bounded NVS, invalid/unknown/no-space rejection passed");
    }
    free(e.pools.reports);free(e.pools.stats);free(e.pools.temporal);return 0;
}
