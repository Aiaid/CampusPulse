#include "control_json.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
static void *response_realloc(void *pointer,size_t size);
#define CP_HTTP_RESPONSE_REALLOC response_realloc
#include "http_response.h"
static size_t allocation,fail_at,live;
static size_t response_allocations,response_fail_at,response_live,response_last_size;
static unsigned method_calls,timeout_calls;
static esp_http_client_method_t local_method;
esp_err_t esp_http_client_set_timeout_ms(esp_http_client_handle_t client,int timeout)
{assert(client&&timeout==1000);++timeout_calls;return ESP_OK;}
esp_err_t esp_http_client_set_method(esp_http_client_handle_t client,esp_http_client_method_t method)
{assert(client&&method==HTTP_METHOD_HEAD);++method_calls;local_method=method;return ESP_OK;}
static void *fail_alloc(size_t size)
{if(++allocation==fail_at)return NULL;void*p=malloc(size);if(p)++live;return p;}
static void counted_free(void*p){if(p){assert(live);--live;}free(p);}
static void *response_realloc(void *pointer,size_t size)
{
    assert(size&&size<=CP_NETWORK_BODY_MAX+1);
    response_last_size=size;
    if (++response_allocations==response_fail_at) return NULL;
    bool fresh=pointer==NULL;
    void *resized=realloc(pointer,size);
    if (resized&&fresh) ++response_live;
    return resized;
}
static void free_response(cp_http_response_t *response)
{
    if (response->body) {assert(response_live);--response_live;free(response->body);}
    assert(!response_live);
}
static void test_lazy_response(void)
{
    assert(cp_http_working_set_available(32u*1024u,18u*1024u));
    assert(!cp_http_working_set_available(32u*1024u-1,18u*1024u));
    assert(!cp_http_working_set_available(128u*1024u,18u*1024u-1));
    response_allocations=response_fail_at=0;
    cp_http_response_t response={.deadline_ms=100};
    int fake_client=1;
    esp_http_client_event_t event={.client=&fake_client,.user_data=&response,.event_id=HTTP_EVENT_ON_CONNECTED};
    assert(cp_http_response_event(&event,1,true)==ESP_OK);
    event.event_id=HTTP_EVENT_ON_HEADER;
    assert(cp_http_response_event(&event,2,true)==ESP_OK);
    event.event_id=HTTP_EVENT_ON_DATA;
    assert(cp_http_response_event(&event,3,true)==ESP_OK);
    assert(cp_http_response_append(&response,NULL,0,4,true)==ESP_OK);
    assert(!response.body&&!response.capacity&&!response.used&&!response_allocations);
    const char ack[]="{\"accepted\":true}";
    event.data=(void *)ack;event.data_len=sizeof ack-1;
    assert(cp_http_response_event(&event,5,true)==ESP_OK);
    assert(response.capacity==256&&response_allocations==1&&response_last_size==256);
    assert(response.used==sizeof ack-1&&!strcmp(response.body,ack));
    free_response(&response);

    char full[CP_NETWORK_BODY_MAX];
    for (size_t i=0;i<sizeof full;++i) full[i]=(char)('a'+i%26);
    const size_t chunks[]={1,254,1,256,512,1024,2048,4096};
    const size_t capacities[]={256,256,512,1024,2048,4096,8192,8193};
    response=(cp_http_response_t){.deadline_ms=100};
    response_allocations=0;
    for (size_t i=0;i<sizeof chunks/sizeof chunks[0];++i) {
        size_t before=response.used;
        assert(cp_http_response_append(&response,full+before,chunks[i],1,true)==ESP_OK);
        assert(response.capacity==capacities[i]&&response.used==before+chunks[i]);
        assert(!memcmp(response.body,full,response.used)&&response.body[response.used]==0);
    }
    const size_t required=response_allocations;
    assert(required==7&&response.used==sizeof full&&response.capacity==sizeof full+1);
    assert(cp_http_response_append(&response,"x",1,2,true)==ESP_ERR_INVALID_SIZE);
    assert(response.used==sizeof full&&response_allocations==required&&response.body[response.used]==0);
    free_response(&response);

    /* Fail each allocation/growth, preserving the old body and its terminator
     * so the caller can free it after the transport has stopped reading. */
    for (size_t failure=1;failure<=required;++failure) {
        response=(cp_http_response_t){.deadline_ms=100};
        response_allocations=0;response_fail_at=failure;
        event.user_data=&response;event.event_id=HTTP_EVENT_ON_DATA;
        unsigned stopped_before=method_calls;
        bool failed=false;
        for (size_t i=0;i<sizeof chunks/sizeof chunks[0];++i) {
            char *old_body=response.body;
            size_t old_used=response.used,old_capacity=response.capacity;
            event.data=full+old_used;event.data_len=(int)chunks[i];
            esp_err_t result=cp_http_response_event(&event,1,true);
            if (result==ESP_ERR_NO_MEM) {
                assert(response.body==old_body&&response.used==old_used&&response.capacity==old_capacity);
                assert(!old_used||(!memcmp(response.body,full,old_used)&&response.body[old_used]==0));
                assert(response.read_stopped&&method_calls==stopped_before+1);
                assert(cp_http_response_event(&event,2,true)==ESP_ERR_NO_MEM);
                assert(response_allocations==failure&&method_calls==stopped_before+1);
                failed=true;break;
            }
            assert(result==ESP_OK);
        }
        assert(failed);
        free_response(&response);
    }
    response_allocations=response_fail_at=0;
    response=(cp_http_response_t){.deadline_ms=100};
    assert(cp_http_response_append(&response,"x",1,100,true)==ESP_ERR_TIMEOUT);
    assert(!response.body&&!response.capacity&&!response_allocations);
    response=(cp_http_response_t){.deadline_ms=100};
    assert(cp_http_response_append(&response,"x",1,1,false)==ESP_ERR_INVALID_STATE);
    assert(!response.body&&!response.capacity&&!response_allocations);
    response=(cp_http_response_t){.deadline_ms=100};
    assert(cp_http_response_append(&response,"x",SIZE_MAX,1,true)==ESP_ERR_INVALID_SIZE);
    assert(!response.body&&!response.capacity&&!response_allocations);
    response=(cp_http_response_t){.used=SIZE_MAX,.deadline_ms=100};
    assert(cp_http_response_append(&response,"x",1,1,true)==ESP_ERR_INVALID_SIZE);
    assert(!response.body&&!response.capacity&&!response_allocations);
}
static char *build(unsigned kind)
{
    const char *boot="12345678-1234-4234-8234-123456789abc";
    return kind<2?cp_control_contact_json(boot,1,1000,"paused",kind?"test-policy":NULL):
        cp_control_activation_json(boot,"test-policy",2,kind==2,kind==2?NULL:"allocation_failed");
}
static void test_connection_event_evidence(void)
{
    int client=1;
    cp_http_response_t response={.deadline_ms=1000,.connected_seen=true,.connected_ms=5};
    esp_http_client_event_t event={.client=&client,.user_data=&response,.event_id=HTTP_EVENT_ON_CONNECTED};
    /* Cached handle state is not a new socket event. An actual reconnect must
     * replace the presumed old timestamp and remain visible to profiling. */
    assert(!response.connect_events);
    assert(cp_http_response_event(&event,20,true)==ESP_OK);
    assert(response.connect_events==1&&response.connected_ms==20);
    assert(cp_http_response_event(&event,30,true)==ESP_OK);
    assert(response.connect_events==2&&response.connected_ms==20);
    response.connect_events=UINT32_MAX;
    assert(cp_http_response_event(&event,40,true)==ESP_OK&&response.connect_events==UINT32_MAX);
}

int main(void)
{
    cJSON_Hooks hooks={.malloc_fn=fail_alloc,.free_fn=counted_free};cJSON_InitHooks(&hooks);
    unsigned injected=0;
    for(unsigned kind=0;kind<4;++kind){
        allocation=fail_at=0;char*good=build(kind);assert(good);size_t required=allocation;
        cJSON*parsed=cJSON_Parse(good);assert(parsed&&cJSON_GetArraySize(parsed)==(kind<2?8:kind==2?4:5));
        cJSON_Delete(parsed);cJSON_free(good);assert(!live);
        for(size_t n=1;n<=required;++n){
            allocation=0;fail_at=n;char*partial=build(kind);assert(!partial&&!live);++injected;
        }
        allocation=fail_at=0;good=build(kind);assert(good);cJSON_free(good);assert(!live);
    }
    allocation=fail_at=0;
    char *baseline=build(3);assert(baseline);size_t intent_allocations=allocation;cJSON_free(baseline);
    for(size_t n=1;n<=intent_allocations;++n) {
        fail_at=allocation=0;char *pending=build(2);char *original=pending;
        uint64_t seq=1,pending_seq=1;cp_control_activation_intent_t intent={0};
        assert(cp_control_stage_activation(&intent,"replacement-policy",false,"allocation_failed"));
        allocation=0;fail_at=n;
        assert(!cp_control_prepare_activation(&intent,"12345678-1234-4234-8234-123456789abc",&seq,&pending,&pending_seq));
        assert(intent.queued&&seq==1&&pending_seq==1&&pending==original);
        allocation=fail_at=0;
        assert(cp_control_prepare_activation(&intent,"12345678-1234-4234-8234-123456789abc",&seq,&pending,&pending_seq));
        assert(!intent.queued&&seq==2&&pending_seq==2&&strstr(pending,"replacement-policy"));
        cJSON_free(pending);assert(!live);
    }
    cJSON_InitHooks(NULL);
    char buffer[CP_NETWORK_BODY_MAX+1];
    cp_http_response_t response={.body=buffer,.capacity=sizeof buffer,.deadline_ms=100};
    for(uint64_t now=0;now<100;++now)assert(cp_http_response_append(&response,"x",1,now,true)==ESP_OK);
    assert(cp_http_response_append(&response,"x",1,100,true)==ESP_ERR_TIMEOUT&&response.used==100);
    assert(cp_http_response_append(&response,"x",1,101,false)==ESP_ERR_TIMEOUT&&response.used==100);
    response=(cp_http_response_t){.body=buffer,.capacity=sizeof buffer,.deadline_ms=100};
    char full[CP_NETWORK_BODY_MAX];memset(full,'x',sizeof full);
    assert(cp_http_response_append(&response,full,sizeof full,1,true)==ESP_OK);
    assert(cp_http_response_append(&response,"x",1,2,true)==ESP_ERR_INVALID_SIZE&&response.used==sizeof full);
    response=(cp_http_response_t){.body=buffer,.capacity=sizeof buffer,.deadline_ms=100};
    assert(cp_http_response_append(&response,"x",1,1,false)==ESP_ERR_INVALID_STATE&&!response.used);
    response=(cp_http_response_t){.body=buffer,.capacity=sizeof buffer,.deadline_ms=100};
    int fake_client=1;
    esp_http_client_event_t event={.client=&fake_client,.user_data=&response,.event_id=HTTP_EVENT_ON_CONNECTED};
    assert(cp_http_response_event(&event,1,true)==ESP_OK&&timeout_calls==1&&!method_calls);
    event.event_id=HTTP_EVENT_ON_HEADER;
    assert(cp_http_response_event(&event,100,true)==ESP_ERR_TIMEOUT&&method_calls==1&&local_method==HTTP_METHOD_HEAD);
    event.event_id=HTTP_EVENT_ON_DATA;event.data="first-header-buffer-body";event.data_len=24;
    assert(cp_http_response_event(&event,100,true)==ESP_ERR_TIMEOUT&&method_calls==1&&!response.used);
    event.event_id=HTTP_EVENT_DISCONNECTED;
    assert(cp_http_response_event(&event,101,false)==ESP_OK&&method_calls==1);
    response=(cp_http_response_t){.body=buffer,.capacity=sizeof buffer,.deadline_ms=100};
    event.event_id=HTTP_EVENT_ON_DATA;event.user_data=&response;
    assert(cp_http_response_event(&event,100,true)==ESP_ERR_TIMEOUT&&method_calls==2&&!response.used);
    test_lazy_response();
    test_connection_event_evidence();
    printf("control JSON: %u allocator failures leave no partial request; HTTP lazy growth/OOM/size/deadline/cancel bounds passed\n",injected);
}
