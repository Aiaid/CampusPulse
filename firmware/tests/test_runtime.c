/* Actual runtime state machine under a finite scheduler. Only IO boundaries are
 * mocked; policy acceptance/expiry uses the real cp_core. No radio acceptance is
 * implied. Each named scenario starts in a fresh process to model cold boot. */
#include <assert.h>
#include <setjmp.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "../components/cp_runtime/runtime.c"

typedef struct {size_t width;unsigned capacity,head,length;command_t slots[2];} test_queue_t;
typedef enum { NETWORK_START,NETWORK_STOP,PIPE_STOP,PIPE_APPLY,PROVISION_STOP,
    PROVISION_BLE,PROVISION_AP,VALIDATE,SAVE,RESTART,APPLIED,FAILED } event_t;
static event_t events[256];static unsigned event_count;
static unsigned net_start_count,provision_start_count,validate_count,save_count,restart_count,apply_count,report_count;
static cp_settings_t persisted,validated,saved_input,last_network_settings;
static cp_network_snapshot_t net;
static cp_pipeline_snapshot_t pipe_state;
static cp_provision_snapshot_t provision;
static esp_err_t load_error=ESP_OK,save_error=ESP_OK,validation_error=ESP_OK;
static esp_err_t network_stop_error=ESP_OK,pipeline_stop_error=ESP_OK,provision_stop_error=ESP_OK,apply_error=ESP_OK;
static bool network_started,entropy_enabled,apply_actually_starts=true;
static char capture_state[20],last_report_id[65];static bool last_report_applied;
static cp_provision_submit_fn submit_callback;static void *submit_context;
static uint64_t clock_ms=10000,last_lease_deadline;
static unsigned lease_renewals;
static void (*entry)(void *);static void *entry_arg;
static jmp_buf yield;
static unsigned iteration,iteration_limit,marker;
static void (*on_tick)(unsigned);
static test_queue_t queue_storage;
static int mutex_storage;
static const cp_board_profile_t board={.board_id="host",.revision="synthetic",.target_chip="host",
    .capabilities=CP_CAP_BLE_SCAN,.max_addresses=64,.ingress_queue_bytes=8192,.max_collection_lease_ms=120000};
static void record(event_t e){assert(event_count<sizeof(events)/sizeof(events[0]));events[event_count++]=e;}
static cp_settings_t settings(const char *ssid)
{
    cp_settings_t s={.version=CP_SETTINGS_VERSION};strcpy(s.node_id,"cp_aabbccddeeff");
    snprintf(s.ssid,sizeof s.ssid,"%s",ssid);strcpy(s.password,"synthetic-only-pass");
    memset(s.device_token,'t',40);strcpy(s.api_origin,CP_API_ORIGIN);assert(cp_settings_validate(&s));return s;
}
static void publish_policy(uint64_t seq,uint64_t fetched,uint64_t lease)
{
    net.network=CP_NETWORK_READY;net.auth=CP_AUTH_VALID;net.clock_trusted=true;
    net.policy_valid=net.policy_present=true;net.policy_rejected=net.policy_expired=false;net.policy_response_sequence=seq;
    cp_network_policy_t p={0};strcpy(p.core.config_id,"synthetic-policy");
    p.core.required_capabilities=CP_CAP_BLE_SCAN;p.core.max_addresses=64;p.core.ingress_queue_bytes=8192;
    p.core.collection_enabled=true;p.core.requires_trusted_clock=true;p.core.upload_accept_until_utc_ms=1900000000000ULL;
    strcpy(p.node_id,"cp_aabbccddeeff");strcpy(p.placement_id,"synthetic-place");strcpy(p.dataset,"controlled_test");
    p.max_addresses=64;p.summary_window_ms=30000;p.summary_bin_ms=5000;p.max_body_bytes=8192;p.max_items=16;
    p.warn_pct=60;p.raw_pause_pct=80;p.critical_pct=95;p.resume_pct=40;
    p.request_sequence=seq;p.fetched_mono_ms=fetched;p.lease_ms=lease;net.policy=p;strcpy(net.desired_config_id,p.core.config_id);
}
int64_t esp_timer_get_time(void){return (int64_t)(clock_ms*1000);}
void bootloader_random_enable(void){assert(!entropy_enabled&&!network_started&&!provision.active);entropy_enabled=true;}
void bootloader_random_disable(void){assert(entropy_enabled);entropy_enabled=false;}
void esp_fill_random(void *p,size_t n){assert(entropy_enabled);memset(p,0x42,n);}
QueueHandle_t xQueueCreate(unsigned cap,size_t width)
{assert(cap==2&&width==sizeof(command_t));queue_storage=(test_queue_t){.width=width,.capacity=cap};return &queue_storage;}
int xQueueSend(QueueHandle_t handle,const void *item,TickType_t wait)
{assert(handle==&queue_storage&&wait==0);test_queue_t*q=handle;if(q->length==q->capacity)return pdFALSE;
 memcpy(&q->slots[(q->head+q->length)%q->capacity],item,q->width);++q->length;return pdTRUE;}
int xQueueReceive(QueueHandle_t handle,void *item,TickType_t wait)
{
    assert(handle==&queue_storage&&wait==pdMS_TO_TICKS(500));
    if(iteration==iteration_limit)longjmp(yield,1);
    clock_ms+=500;++iteration;if(on_tick)on_tick(iteration);
    test_queue_t*q=handle;if(!q->length)return pdFALSE;
    memcpy(item,&q->slots[q->head],q->width);memset(&q->slots[q->head],0,q->width);
    q->head=(q->head+1)%q->capacity;--q->length;return pdTRUE;
}
SemaphoreHandle_t xSemaphoreCreateMutex(void){return &mutex_storage;}
int xSemaphoreTake(SemaphoreHandle_t h,TickType_t wait){(void)wait;assert(h==&mutex_storage);return pdTRUE;}
int xSemaphoreGive(SemaphoreHandle_t h){assert(h==&mutex_storage);return pdTRUE;}
int xTaskCreate(void(*fn)(void*),const char*name,unsigned stack,void*arg,unsigned priority,TaskHandle_t*out)
{assert(!strcmp(name,"cp_control")&&stack>=8192&&priority);entry=fn;entry_arg=arg;*out=&entry;return pdPASS;}
void vTaskDelay(TickType_t ticks){clock_ms+=ticks;}
void esp_restart(void){record(RESTART);++restart_count;longjmp(yield,2);}
esp_err_t cp_settings_init(void){assert(!network_started&&!provision.active);return ESP_OK;}
esp_err_t cp_settings_load(cp_settings_t*out){if(load_error==ESP_OK)*out=persisted;else memset(out,0,sizeof*out);return load_error;}
esp_err_t cp_settings_save(const cp_settings_t*s)
{record(SAVE);++save_count;saved_input=*s;assert(validate_count&&validation_error==ESP_OK);if(save_error==ESP_OK)persisted=*s;return save_error;}
esp_err_t cp_settings_setup_proof(char out[33]){assert(!entropy_enabled&&!network_started&&!provision.active);memset(out,'a',32);out[32]=0;return ESP_OK;}
esp_err_t cp_network_init(const char*node,const char*boot){assert(!strcmp(node,"cp_aabbccddeeff")&&strlen(boot)==36&&boot[14]=='4');return ESP_OK;}
esp_err_t cp_network_start(const cp_settings_t*s)
{assert(!provision.active);record(NETWORK_START);++net_start_count;network_started=true;last_network_settings=*s;return ESP_OK;}
esp_err_t cp_network_stop(void){record(NETWORK_STOP);if(network_stop_error==ESP_OK)network_started=false;return network_stop_error;}
void cp_network_snapshot(cp_network_snapshot_t*out){*out=net;}
bool cp_network_get_policy(cp_network_policy_t*out){if(net.policy_valid)*out=net.policy;return net.policy_valid;}
esp_err_t cp_network_report_activation(const char*id,bool applied,const char*why)
{assert(why&&strlen(id)<65);record(applied?APPLIED:FAILED);++report_count;strcpy(last_report_id,id);last_report_applied=applied;return ESP_OK;}
void cp_network_set_capture_state(const char*state){assert(strlen(state)<sizeof capture_state);strcpy(capture_state,state);}
esp_err_t cp_network_validate_candidate(const cp_settings_t*s,uint32_t timeout)
{assert(!provision.active&&!pipe_state.collecting&&!network_started&&timeout>=1000);record(VALIDATE);++validate_count;validated=*s;return validation_error;}
esp_err_t cp_pipeline_init(const char*node,const char*boot){assert(node&&boot);return ESP_OK;}
esp_err_t cp_pipeline_stop(void){record(PIPE_STOP);if(pipeline_stop_error==ESP_OK)pipe_state.collecting=false;return pipeline_stop_error;}
esp_err_t cp_pipeline_apply(const cp_network_policy_t*p)
{assert(!provision.active&&p->core.collection_enabled);record(PIPE_APPLY);++apply_count;if(apply_error==ESP_OK)pipe_state.collecting=apply_actually_starts;return apply_error;}
void cp_pipeline_snapshot(cp_pipeline_snapshot_t*out){*out=pipe_state;}
void cp_pipeline_renew_lease(uint64_t deadline){assert(deadline>clock_ms);last_lease_deadline=deadline;++lease_renewals;}
esp_err_t cp_provision_start(cp_provision_mode_t mode,const char*node,const char*proof,cp_provision_submit_fn fn,void*ctx)
{assert(!network_started&&!pipe_state.collecting&&!provision.active&&strlen(proof)==32&&node);
 record(mode==CP_PROVISION_BLE?PROVISION_BLE:PROVISION_AP);++provision_start_count;provision.active=true;provision.mode=mode;submit_callback=fn;submit_context=ctx;return ESP_OK;}
esp_err_t cp_provision_stop(void){record(PROVISION_STOP);if(provision_stop_error==ESP_OK)provision.active=false;return provision_stop_error;}
void cp_provision_snapshot(cp_provision_snapshot_t*out){*out=provision;}
void cp_provision_set_status(const char*state,const char*why)
{snprintf(provision.state,sizeof provision.state,"%s",state);snprintf(provision.reason,sizeof provision.reason,"%s",why);}
static int run(unsigned ticks,void(*hook)(unsigned))
{
    iteration=0;iteration_limit=ticks;on_tick=hook;
    assert(cp_runtime_start()==ESP_OK&&entry);
    int result=setjmp(yield);if(!result)entry(entry_arg);return result;
}
static void prepare(bool enrolled)
{
    persisted=settings("previous-network");load_error=enrolled?ESP_OK:ESP_ERR_NOT_FOUND;
    pipe_state.storage_ready=true;pipe_state.free_slots=200;pipe_state.capacity_slots=341;
    assert(cp_runtime_prepare("cp_aabbccddeeff",&board)==ESP_OK);
}
static void issue_candidate(void)
{
    cp_settings_t candidate=settings("candidate-network");assert(submit_callback);
    assert(submit_callback(&candidate,"12345678-1234-4234-8234-123456789abc",submit_context)==ESP_OK);
    assert(!save_count&&!validate_count); /* Transport callback only queues. */
}
static void candidate_success_tick(unsigned n){if(n==1){marker=event_count;issue_candidate();}}
static void candidate_ap_tick(unsigned n)
{
    if(n==1)assert(cp_runtime_request_setup(CP_PROVISION_SOFTAP));
    if(n==2){assert(provision.mode==CP_PROVISION_SOFTAP);marker=event_count;issue_candidate();}
}
static void stop_failure_tick(unsigned n){if(n==1)assert(cp_runtime_request_setup(CP_PROVISION_SOFTAP));}
static void policy_invalidate_tick(unsigned n)
{
    if(n==2){assert(pipe_state.collecting);net.policy_response_sequence=2;net.policy_valid=false;net.policy_present=false;}
}
static void policy_reject_tick(unsigned n)
{
    if(n==2){assert(pipe_state.collecting);net.policy_response_sequence=2;net.policy_valid=false;net.policy_rejected=true;strcpy(net.desired_config_id,"unsupported-policy");}
}
static void renewal_tick(unsigned n)
{if(n==2){assert(pipe_state.collecting);publish_policy(2,clock_ms-200,120000);}}
static void transient_tick(unsigned n)
{if(n==2){net.last_http_status=503;net.last_error=ESP_FAIL;clock_ms=15000;}}
static void no_actual_scan_tick(unsigned n)
{if(n==2){pipe_state.collecting=false;pipe_state.pressure_paused=true;pipe_state.free_slots=1;}}
static void resume_tick(unsigned n)
{if(n==1)assert(cp_runtime_request_setup(CP_PROVISION_SOFTAP));if(n==2)assert(cp_runtime_request_resume());}
static void assert_candidate_order(void)
{const event_t expected[]={PROVISION_STOP,VALIDATE,SAVE,RESTART};assert(event_count-marker==4);
 for(unsigned i=0;i<4;++i)assert(events[marker+i]==expected[i]);}
static void scenario(const char*name)
{
    if(!strcmp(name,"enrolled_boot")){prepare(true);assert(run(1,NULL)==1);assert(net_start_count==1&&!provision_start_count&&!save_count);assert(!strcmp(last_network_settings.ssid,"previous-network"));}
    else if(!strcmp(name,"unassigned_boot")){prepare(false);assert(run(1,NULL)==1);assert(!net_start_count&&provision_start_count==1&&provision.mode==CP_PROVISION_BLE);assert(s_core.setup_active&&!s_core.lease_valid);}
    else if(!strcmp(name,"candidate_commit")){prepare(false);assert(run(2,candidate_success_tick)==2);assert_candidate_order();assert(save_count==1&&restart_count==1&&!memcmp(&validated,&saved_input,sizeof validated));assert(!strcmp(persisted.ssid,"candidate-network"));}
    else if(!strcmp(name,"candidate_failure_ap")){prepare(true);validation_error=ESP_ERR_TIMEOUT;assert(run(3,candidate_ap_tick)==1);assert(validate_count==1&&!save_count&&!restart_count);assert(provision.active&&provision.mode==CP_PROVISION_SOFTAP);assert(!strcmp(persisted.ssid,"previous-network")&&!strcmp(provision.state,"failed"));}
    else if(!strcmp(name,"candidate_save_failure")){prepare(true);save_error=ESP_FAIL;assert(run(3,candidate_ap_tick)==1);assert(validate_count==1&&save_count==1&&!restart_count);assert(provision.active&&provision.mode==CP_PROVISION_SOFTAP&&!strcmp(persisted.ssid,"previous-network"));}
    else if(!strcmp(name,"network_stop_failure")){prepare(true);network_stop_error=ESP_ERR_TIMEOUT;assert(run(1,stop_failure_tick)==1);assert(!provision_start_count&&network_started&&!strcmp(s_reason,"previous_owner_stop_failed"));}
    else if(!strcmp(name,"pipeline_stop_failure")){prepare(true);pipeline_stop_error=ESP_ERR_TIMEOUT;pipe_state.collecting=true;assert(run(1,stop_failure_tick)==1);assert(!provision_start_count&&pipe_state.collecting&&network_started);}
    else if(!strcmp(name,"fresh_policy_age")){prepare(true);publish_policy(1,9000,120000);assert(run(1,NULL)==1);assert(s_core.lease_started_ms==10500&&s_core.lease_duration_ms==118500&&s_core.latest_request_sequence==1);assert(apply_count==1&&last_report_applied&&pipe_state.collecting&&!strcmp(capture_state,"running"));}
    else if(!strcmp(name,"same_policy_lease_renewal")){prepare(true);publish_policy(1,9000,120000);assert(run(2,renewal_tick)==1);assert(apply_count==1&&report_count==1&&lease_renewals==1&&last_lease_deadline==130800);assert(s_core.lease_started_ms==11000&&s_core.lease_duration_ms==119800);}
    else if(!strcmp(name,"expired_policy_once")){prepare(true);publish_policy(1,0,1000);assert(run(3,NULL)==1);assert(!apply_count&&!pipe_state.collecting&&report_count==1&&!last_report_applied);}
    else if(!strcmp(name,"explicit_unassigned")){prepare(true);publish_policy(1,9000,120000);assert(run(3,policy_invalidate_tick)==1);assert(!pipe_state.collecting&&s_core.policy_state==CP_POLICY_NONE&&!s_core.lease_valid&&report_count==1);}
    else if(!strcmp(name,"unsupported_policy")){prepare(true);publish_policy(1,9000,120000);assert(run(3,policy_reject_tick)==1);assert(!pipe_state.collecting&&s_core.policy_state==CP_POLICY_FAILED&&report_count==2&&!last_report_applied);assert(!strcmp(last_report_id,"unsupported-policy"));}
    else if(!strcmp(name,"transient_lease_expiry")){prepare(true);publish_policy(1,10000,2000);assert(run(2,transient_tick)==1);assert(s_core.latest_request_sequence==1&&report_count==1&&apply_count==1&&!s_core.lease_valid&&!pipe_state.collecting);assert(!strcmp(capture_state,"expired"));}
    else if(!strcmp(name,"actual_capture_contact")){prepare(true);publish_policy(1,9000,120000);assert(run(2,no_actual_scan_tick)==1);assert(!pipe_state.collecting&&strcmp(capture_state,"running")!=0);}
    else if(!strcmp(name,"resume_previous")){prepare(true);assert(run(3,resume_tick)==1);assert(net_start_count==2&&!provision.active&&network_started&&!strcmp(last_network_settings.ssid,"previous-network"));}
    else {fprintf(stderr,"Unknown scenario: %s\n",name);exit(2);}
}
int main(int argc,char**argv)
{
    assert(argc==2);scenario(argv[1]);printf("actual runtime: %s passed\n",argv[1]);return 0;
}
