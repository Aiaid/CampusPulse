#include "cp_network.h"
#include "protocol_internal.h"
#include "cJSON.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
static const char policy_json[]=
"{\"protocol\":\"campuspulse/2\",\"server_time\":\"2026-10-24T12:00:00.000Z\",\"expired\":false,\"control\":{\"lease_ms\":120000},\"config\":{"
"\"protocol\":\"campuspulse/2\",\"capture_config_id\":\"test-v2\",\"node_id\":\"cp_aabbccddeeff\",\"placement_id\":\"synthetic-place\",\"dataset\":\"controlled_test\","
"\"capture_profile\":\"address_metrics\",\"identity_scheme\":\"mac\",\"accept_until\":\"2026-12-01T00:00:00.000Z\","
"\"allowed_streams\":[\"ble_windows\",\"address_summaries\",\"node_status\"],"
"\"scan\":{\"stack\":\"nimble\",\"adapter_version\":\"cp-nimble-v2\",\"mode\":\"passive\",\"interval_ms\":100,\"window_ms\":100,\"filter_duplicates\":false,\"host_filter\":\"none\"},"
"\"raw_capture\":{\"mode\":\"off\"},\"summary\":{\"window_ms\":30000,\"bin_ms\":5000,\"max_addresses\":64},\"control\":{\"lease_ms\":120000},"
"\"upload_policy\":{\"max_items\":128,\"max_body_bytes\":65536,\"flush_max_age_ms\":30000,\"warn_pct\":60,\"raw_pause_pct\":75,\"critical_pct\":90,\"resume_pct\":40,\"overload_action\":\"pause_scan\"}}}";
static bool parse_object(cJSON *o)
{
    char *s=cJSON_PrintUnformatted(o);assert(s);
    cp_network_policy_t policy;bool present,expired;
    bool ok=cp_network_parse_policy(s,strlen(s),"cp_aabbccddeeff",&policy,&present,&expired);
    free(s);return ok;
}
static void mutate_reject(const char *obj,const char *key,cJSON *value)
{
    cJSON *o=cJSON_Parse(policy_json);assert(o);
    cJSON *config=cJSON_GetObjectItemCaseSensitive(o,"config");
    cJSON *target=obj?cJSON_GetObjectItemCaseSensitive(config,obj):config;
    cJSON_ReplaceItemInObjectCaseSensitive(target,key,value);
    assert(!parse_object(o));cJSON_Delete(o);
}
static void summary_policy_matrix(void)
{
    const unsigned windows[]={1000,10000,30000,60000,80000,300000};
    const unsigned bins[]={1000,5000,5000,5000,5000,300000};
    const unsigned capacities[]={16,32,64};
    for (unsigned w=0;w<sizeof(windows)/sizeof(windows[0]);++w)
        for (unsigned a=0;a<sizeof(capacities)/sizeof(capacities[0]);++a) {
            cJSON *o=cJSON_Parse(policy_json);assert(o);
            cJSON *summary=cJSON_GetObjectItem(cJSON_GetObjectItem(o,"config"),"summary");
            cJSON_ReplaceItemInObject(summary,"window_ms",cJSON_CreateNumber(windows[w]));
            cJSON_ReplaceItemInObject(summary,"bin_ms",cJSON_CreateNumber(bins[w]));
            cJSON_ReplaceItemInObject(summary,"max_addresses",cJSON_CreateNumber(capacities[a]));
            char *json=cJSON_PrintUnformatted(o);assert(json);
            cp_network_policy_t p;bool present,expired;
            assert(cp_network_parse_policy(json,strlen(json),"cp_aabbccddeeff",&p,&present,&expired));
            assert(present&&!expired&&p.summary_window_ms==windows[w]&&p.summary_bin_ms==bins[w]);
            assert(p.max_addresses==capacities[a]&&p.core.max_addresses==capacities[a]);
            assert(p.scan_interval_ms==100&&p.scan_window_ms==100&&!p.filter_duplicates&&!p.raw_enabled);
            free(json);cJSON_Delete(o);
        }
}
int main(void)
{
    cp_network_policy_t p;bool present,expired;
    assert(cp_network_parse_policy(policy_json,strlen(policy_json),"cp_aabbccddeeff",&p,&present,&expired));
    assert(present&&!expired&&p.max_items==16&&p.max_body_bytes==8192&&p.max_addresses==64&&p.lease_ms==120000);
    assert(!strcmp(p.core.config_id,"test-v2")&&!p.raw_enabled&&p.core.ingress_queue_bytes==8192);
    assert(!cp_network_parse_policy(policy_json,strlen(policy_json),"cp_000000000000",&p,&present,&expired));
    mutate_reject(NULL,"protocol",cJSON_CreateString("campuspulse/1"));
    mutate_reject("scan","adapter_version",cJSON_CreateString("unknown"));
    mutate_reject("scan","interval_ms",cJSON_CreateNumber(5.5));
    mutate_reject("scan","window_ms",cJSON_CreateNumber(101));
    mutate_reject("raw_capture","mode",cJSON_CreateString("all"));
    mutate_reject("summary","max_addresses",cJSON_CreateNumber(65));
    summary_policy_matrix();
    mutate_reject("summary","window_ms",cJSON_CreateNumber(999));
    mutate_reject("summary","window_ms",cJSON_CreateNumber(300001));
    mutate_reject("summary","window_ms",cJSON_CreateNumber(30000.5));
    mutate_reject("summary","window_ms",cJSON_CreateNumber(31000));
    mutate_reject("summary","window_ms",cJSON_CreateNumber(85000));
    mutate_reject("summary","bin_ms",cJSON_CreateNumber(0));
    mutate_reject("summary","bin_ms",cJSON_CreateNumber(999));
    mutate_reject("summary","bin_ms",cJSON_CreateNumber(35000));
    mutate_reject("summary","bin_ms",cJSON_CreateNumber(4000));
    mutate_reject("summary","bin_ms",cJSON_CreateNumber(1000));
    mutate_reject("control","lease_ms",cJSON_CreateNumber(120001));
    mutate_reject("upload_policy","max_items",cJSON_CreateNumber(3));
    mutate_reject("upload_policy","max_body_bytes",cJSON_CreateNumber(4095));
    mutate_reject("upload_policy","resume_pct",cJSON_CreateNumber(60));
    mutate_reject(NULL,"accept_until",cJSON_CreateString("2026-02-30T00:00:00.000Z"));
    cJSON *sampled=cJSON_Parse(policy_json),*config=cJSON_GetObjectItem(sampled,"config"),*raw=cJSON_GetObjectItem(config,"raw_capture");
    cJSON_ReplaceItemInObject(raw,"mode",cJSON_CreateString("sampled"));
    cJSON_AddNumberToObject(raw,"sample_every_n",10);cJSON_AddStringToObject(raw,"selection","seq_mod_n_eq_0");cJSON_AddNumberToObject(raw,"max_reports_per_window",4);
    cJSON_AddItemToArray(cJSON_GetObjectItem(config,"allowed_streams"),cJSON_CreateString("ble_reports"));assert(parse_object(sampled));
    cJSON_AddItemToArray(cJSON_GetObjectItem(config,"allowed_streams"),cJSON_CreateString("ble_reports"));assert(!parse_object(sampled));cJSON_Delete(sampled);
    const char *none="{\"protocol\":\"campuspulse/2\",\"config\":null,\"expired\":false,\"control\":{\"lease_ms\":120000}}";
    assert(cp_network_parse_policy(none,strlen(none),"cp_aabbccddeeff",&p,&present,&expired)&&!present);
    uint64_t time=0;assert(cp_network_parse_server_time(policy_json,strlen(policy_json),&time)&&time==1792843200000ULL);
    const char *boot="12345678-1234-4234-8234-123456789abc";
    cp_network_batch_t expected={.accepted_count=3};
    strcpy(expected.node_id,"cp_aabbccddeeff");strcpy(expected.boot_id,boot);strcpy(expected.stream,"address_summaries");strcpy(expected.batch_id,"abcdef12-1234-4234-8234-123456789abc");
    assert(cp_network_sha256("abc",3,expected.body_sha256));
    assert(!strcmp(expected.body_sha256,"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"));
    char ack[1024];snprintf(ack,sizeof(ack),"{\"node_id\":\"%s\",\"boot_id\":\"%s\",\"stream\":\"%s\",\"batch_id\":\"%s\",\"body_sha256\":\"%s\",\"accepted_count\":3,\"durability\":\"committed\",\"receipt_id\":\"receipt_test\",\"received_at\":\"2026-10-24T12:00:00.000Z\"}",expected.node_id,expected.boot_id,expected.stream,expected.batch_id,expected.body_sha256);
    cp_network_ack_t result;assert(cp_network_parse_ack(ack,strlen(ack),&expected,&result));
    const char *wrongkeys[]={"node_id","boot_id","stream","batch_id","body_sha256","durability"};
    for(size_t i=0;i<sizeof(wrongkeys)/sizeof(wrongkeys[0]);++i) {
        cJSON *o=cJSON_Parse(ack);cJSON_ReplaceItemInObject(o,wrongkeys[i],cJSON_CreateString("wrong"));char *s=cJSON_PrintUnformatted(o);
        assert(!cp_network_parse_ack(s,strlen(s),&expected,&result));free(s);cJSON_Delete(o);
    }
    ++expected.accepted_count;assert(!cp_network_parse_ack(ack,strlen(ack),&expected,&result));--expected.accepted_count;
    cJSON *dup=cJSON_Parse(ack);cJSON_AddNumberToObject(dup,"accepted_count",3);char *bad=cJSON_PrintUnformatted(dup);
    assert(!cp_network_parse_ack(bad,strlen(bad),&expected,&result));free(bad);cJSON_Delete(dup);
    char contact[512];snprintf(contact,sizeof(contact),"{\"node_id\":\"%s\",\"boot_id\":\"%s\",\"contact_seq\":1,\"received_at\":\"2026-10-24T12:00:00.000Z\",\"control\":{\"lease_ms\":120000}}",expected.node_id,boot);
    assert(cp_network_control_ack_matches(contact,strlen(contact),expected.node_id,boot,1,NULL,NULL,NULL));
    assert(!cp_network_control_ack_matches(contact,strlen(contact),expected.node_id,boot,2,NULL,NULL,NULL));
    char activation[512];snprintf(activation,sizeof(activation),"{\"node_id\":\"%s\",\"boot_id\":\"%s\",\"capture_config_id\":\"test-v2\",\"apply_seq\":3,\"state\":\"applied\",\"received_at\":\"2026-10-24T12:00:00.000Z\"}",expected.node_id,boot);
    assert(cp_network_control_ack_matches(activation,strlen(activation),expected.node_id,boot,3,"test-v2","applied",NULL));
    assert(!cp_network_control_ack_matches(activation,strlen(activation),expected.node_id,boot,2,"test-v2","applied",NULL));
    cJSON *with_reason=cJSON_Parse(activation);cJSON_AddStringToObject(with_reason,"message","applied");
    char *with_reason_text=cJSON_PrintUnformatted(with_reason);
    assert(cp_network_control_ack_matches(with_reason_text,strlen(with_reason_text),expected.node_id,boot,3,"test-v2","applied","applied"));
    assert(!cp_network_control_ack_matches(with_reason_text,strlen(with_reason_text),expected.node_id,boot,3,"test-v2","applied","wrong_reason"));
    assert(!cp_network_control_ack_matches(with_reason_text,strlen(with_reason_text),expected.node_id,boot,3,"test-v2","applied",NULL));
    free(with_reason_text);cJSON_Delete(with_reason);
    char candidate_id[65];assert(cp_network_candidate_id(policy_json,strlen(policy_json),"cp_aabbccddeeff",candidate_id)&&!strcmp(candidate_id,"test-v2"));
    assert(!cp_network_candidate_id(policy_json,strlen(policy_json),"cp_000000000000",candidate_id)&&!candidate_id[0]);
    char nested[4096];size_t nested_length=0;
    for(unsigned i=0;i<1000;++i)nested[nested_length++]='[';
    nested[nested_length++]='0';
    for(unsigned i=0;i<1000;++i)nested[nested_length++]=']';
    assert(!cp_network_parse_policy(nested,nested_length,"cp_aabbccddeeff",&p,&present,&expired));
    cp_network_batch_t broken=expected;memset(broken.node_id,'x',sizeof(broken.node_id));
    assert(!cp_network_parse_ack(ack,strlen(ack),&broken,&result));
    char malformed[sizeof(policy_json)];unsigned random_state=17;
    for(unsigned n=0;n<512;++n) {
        memcpy(malformed,policy_json,sizeof(policy_json));random_state=random_state*1664525u+1013904223u;
        malformed[random_state%(sizeof(policy_json)-1)]^=(char)(1u<<(random_state%7));
        (void)cp_network_parse_policy(malformed,sizeof(policy_json)-1,"cp_aabbccddeeff",&p,&present,&expired);
    }
    puts("network protocol: compatible policies, bounded config, exact receipts, duplicate keys, control sequences, SHA256 and UTC passed");
}
