#include "control_json.h"
#include "http_response.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
static size_t allocation,fail_at,live;
static unsigned method_calls,timeout_calls;
static esp_http_client_method_t local_method;
esp_err_t esp_http_client_set_timeout_ms(esp_http_client_handle_t client,int timeout)
{assert(client&&timeout==1000);++timeout_calls;return ESP_OK;}
esp_err_t esp_http_client_set_method(esp_http_client_handle_t client,esp_http_client_method_t method)
{assert(client&&method==HTTP_METHOD_HEAD);++method_calls;local_method=method;return ESP_OK;}
static void *fail_alloc(size_t size)
{if(++allocation==fail_at)return NULL;void*p=malloc(size);if(p)++live;return p;}
static void counted_free(void*p){if(p){assert(live);--live;}free(p);}
static char *build(unsigned kind)
{
    const char *boot="12345678-1234-4234-8234-123456789abc";
    return kind<2?cp_control_contact_json(boot,1,1000,"paused",kind?"test-policy":NULL):
        cp_control_activation_json(boot,"test-policy",2,kind==2,kind==2?NULL:"allocation_failed");
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
    cp_http_response_t response={.body=buffer,.deadline_ms=100};
    for(uint64_t now=0;now<100;++now)assert(cp_http_response_append(&response,"x",1,now,true)==ESP_OK);
    assert(cp_http_response_append(&response,"x",1,100,true)==ESP_ERR_TIMEOUT&&response.used==100);
    assert(cp_http_response_append(&response,"x",1,101,false)==ESP_ERR_TIMEOUT&&response.used==100);
    response=(cp_http_response_t){.body=buffer,.deadline_ms=100};
    char full[CP_NETWORK_BODY_MAX];memset(full,'x',sizeof full);
    assert(cp_http_response_append(&response,full,sizeof full,1,true)==ESP_OK);
    assert(cp_http_response_append(&response,"x",1,2,true)==ESP_ERR_INVALID_SIZE&&response.used==sizeof full);
    response=(cp_http_response_t){.body=buffer,.deadline_ms=100};
    assert(cp_http_response_append(&response,"x",1,1,false)==ESP_ERR_INVALID_STATE&&!response.used);
    response=(cp_http_response_t){.body=buffer,.deadline_ms=100};
    int fake_client=1;
    esp_http_client_event_t event={.client=&fake_client,.user_data=&response,.event_id=HTTP_EVENT_ON_CONNECTED};
    assert(cp_http_response_event(&event,1,true)==ESP_OK&&timeout_calls==1&&!method_calls);
    event.event_id=HTTP_EVENT_ON_HEADER;
    assert(cp_http_response_event(&event,100,true)==ESP_ERR_TIMEOUT&&method_calls==1&&local_method==HTTP_METHOD_HEAD);
    event.event_id=HTTP_EVENT_ON_DATA;event.data="first-header-buffer-body";event.data_len=24;
    assert(cp_http_response_event(&event,100,true)==ESP_ERR_TIMEOUT&&method_calls==1&&!response.used);
    event.event_id=HTTP_EVENT_DISCONNECTED;
    assert(cp_http_response_event(&event,101,false)==ESP_OK&&method_calls==1);
    response=(cp_http_response_t){.body=buffer,.deadline_ms=100};
    event.event_id=HTTP_EVENT_ON_DATA;event.user_data=&response;
    assert(cp_http_response_event(&event,100,true)==ESP_ERR_TIMEOUT&&method_calls==2&&!response.used);
    printf("control JSON: %u allocator failures leave no partial request; HTTP size/deadline/cancel bounds passed\n",injected);
}
