/* Actual request/retry helpers + real persistent-budget codec/core and SDK
 * error constants/cJSON. Only network IO, journal storage, time and waiting
 * are substitutes. No capability qualification flags or live data are used. */
#include "small_runtime_requests.h"
#include "small_runtime_requests_json.h"
#include "cp_v3_budget.h"
#include <assert.h>
#include <openssl/sha.h>
#include <stdio.h>
#include <string.h>

static const char registration_body[]="{\"registration_seq\":1,\"uptime_ms\":123,\"capabilities\":{\"capability_id\":\"synthetic-frozen-capability\",\"boot_id\":\"00000000-0000-4000-8000-000000000001\"}}";
typedef struct {
    cp_v3_budget_t budget;
    unsigned charge_calls,posts,waits,notices,success_at;
    uint32_t waited_ms;
    uint8_t journal[CP_V3_BUDGET_RECORD_BYTES],body_hash[32];
    bool journal_present,stop,stop_after_charge,stop_after_post,stop_in_wait,store_fail;
    esp_err_t error;
    cp_v3_transport_response_t response;
    const char *server_body;
} fixture_t;
static cp_v3_budget_load_t load(void *p,void *out,size_t cap,size_t *bytes){
    fixture_t *f=p;*bytes=0;if(!f->journal_present)return CP_V3_BUDGET_LOAD_ABSENT;
    assert(cap>=sizeof f->journal);memcpy(out,f->journal,sizeof f->journal);*bytes=sizeof f->journal;return CP_V3_BUDGET_LOAD_PRESENT;
}
static bool save(void *p,const void *record,size_t bytes){
    fixture_t *f=p;assert(bytes==sizeof f->journal);if(f->store_fail)return false;
    cp_v3_budget_record_t decoded;assert(cp_v3_budget_decode(record,bytes,&decoded));
    memcpy(f->journal,record,bytes);f->journal_present=true;return true;
}
static bool stopped(void *p){return ((fixture_t *)p)->stop;}
static bool charge(void *p,size_t bytes){
    fixture_t *f=p;f->charge_calls++;assert(bytes==sizeof registration_body-1);
    uint64_t prior=f->budget.authorized_io_bytes;
    cp_v3_budget_result_t r=cp_v3_budget_charge(&f->budget,bytes,1800000000000ULL,1800000000020ULL);
    if(r==CP_V3_BUDGET_OK){assert(f->budget.authorized_io_bytes==prior+bytes);assert(f->journal_present);}
    else assert(f->budget.authorized_io_bytes==prior);
    if(f->stop_after_charge)f->stop=true;
    return r==CP_V3_BUDGET_OK;
}
static esp_err_t post(void *p,cp_v3_http_method_t method,const char *path,const void *body,size_t bytes,bool receipt_only,cp_v3_transport_response_t *out){
    fixture_t *f=p;assert(method==CP_V3_HTTP_POST&&!receipt_only&&!strcmp(path,"/api/v3/device/capabilities"));
    assert(body==registration_body&&bytes==sizeof registration_body-1);
    uint8_t hash[32];assert(SHA256(body,bytes,hash));assert(!memcmp(hash,f->body_hash,32));
    assert(f->charge_calls==f->posts+1);f->posts++;
    assert(f->budget.authorized_io_bytes==(uint64_t)f->posts*bytes);
    *out=f->response;
    if(f->success_at&&f->posts==f->success_at){out->http_status=out->parsed_http_status=200;out->complete=true;out->tls_connected=1;out->stage=CP_V3_TRANSPORT_COMPLETE;out->tls_esp_error=out->tls_stack_error=out->tls_verify_flags=0;}
    out->body_bytes=f->server_body?strlen(f->server_body):0;
    if(f->stop_after_post)f->stop=true;
    return f->success_at&&f->posts==f->success_at?ESP_OK:f->error;
}
static bool server(void *p,const cp_v3_transport_response_t *r){fixture_t *f=p;return te_small_server_retryable(f->server_body,r->body_bytes);}
static bool wait_ms(void *p,uint32_t delay){
    fixture_t *f=p;assert(delay==++f->waits*1000u);f->waited_ms+=delay;
    if(f->stop_in_wait){f->stop=true;return false;}return true;
}
static void note(void *p,unsigned index,size_t bytes){fixture_t *f=p;assert(index==f->notices++);assert(bytes==sizeof registration_body-1);}
static void make(fixture_t *f,uint64_t limit){
    memset(f,0,sizeof *f);f->error=ESP_ERR_TIMEOUT;f->response.stage=CP_V3_TRANSPORT_TLS;
    assert(SHA256((const unsigned char *)registration_body,sizeof registration_body-1,f->body_hash));
    uint8_t owner[32];assert(SHA256((const uint8_t *)"synthetic-registration-budget",29,owner));
    cp_v3_budget_store_t store={f,load,save,4096};
    assert(cp_v3_budget_open(&f->budget,store,owner)==CP_V3_BUDGET_OK);
    assert(cp_v3_budget_configure(&f->budget,limit,8192)==CP_V3_BUDGET_OK);
}
static bool run(fixture_t *f,cp_v3_transport_response_t *response){
    te_small_request_io_t io={f,stopped,charge,post,server};
    te_small_registration_io_t registration={&io,f,wait_ms,note};
    return te_small_registration_exchange(&registration,registration_body,sizeof registration_body-1,response);
}
int main(void){
    fixture_t f;cp_v3_transport_response_t r;
    make(&f,131072);f.success_at=3;
    assert(run(&f,&r)&&f.posts==3&&f.charge_calls==3&&f.waits==2&&f.waited_ms==3000);
    assert(f.budget.authorized_io_bytes==3u*(sizeof registration_body-1));
    make(&f,131072);assert(!run(&f,&r)&&f.posts==3&&f.charge_calls==3&&f.waits==2);
    make(&f,4096+2u*(sizeof registration_body-1));memset(&r,0xa5,sizeof r);
    assert(!run(&f,&r)&&f.posts==2&&f.charge_calls==3&&f.waits==2);
    assert(r.stage==CP_V3_TRANSPORT_IDLE&&!r.tls_verify_flags&&!r.received_bytes&&!r.written_bytes);
    make(&f,131072);f.store_fail=true;assert(!run(&f,&r)&&!f.posts&&f.charge_calls==1&&!f.waits&&r.stage==CP_V3_TRANSPORT_IDLE);
    make(&f,131072);f.stop=true;assert(!run(&f,&r)&&!f.posts&&!f.charge_calls&&!f.waits);
    make(&f,131072);f.stop_after_charge=true;assert(!run(&f,&r)&&f.charge_calls==1&&!f.posts&&!f.waits);
    make(&f,131072);f.stop_after_post=true;assert(!run(&f,&r)&&f.posts==1&&!f.waits);
    make(&f,131072);f.stop_in_wait=true;assert(!run(&f,&r)&&f.posts==1&&f.waits==1);
    make(&f,131072);f.error=ESP_ERR_INVALID_STATE;assert(!run(&f,&r)&&f.posts==1&&!f.waits);
    make(&f,131072);f.error=ESP_ERR_NO_MEM;assert(!run(&f,&r)&&f.posts==1&&!f.waits);
    make(&f,131072);f.response.tls_verify_flags=1;assert(!run(&f,&r)&&f.posts==1&&!f.waits);
    make(&f,131072);f.response.tls_stack_error=MBEDTLS_ERR_SSL_CA_CHAIN_REQUIRED;assert(!run(&f,&r)&&f.posts==1&&!f.waits);
    make(&f,131072);f.response.tls_esp_error=ESP_ERR_MBEDTLS_X509_CRT_PARSE_FAILED;assert(!run(&f,&r)&&f.posts==1&&!f.waits);
    make(&f,131072);f.response.tls_esp_error=ESP_ERR_MBEDTLS_SSL_HANDSHAKE_FAILED;assert(!run(&f,&r)&&f.posts==1&&!f.waits);
    make(&f,131072);f.response.tls_esp_error=ESP_ERR_ESP_TLS_FAILED_CONNECT_TO_HOST;f.error=ESP_FAIL;f.success_at=2;
    assert(run(&f,&r)&&f.posts==2&&f.charge_calls==2);
    /* A reply-less/unknown-status response interruption can be retried; a
     * parser-rejected positive chunk cannot. Every attempt remains charged. */
    make(&f,131072);f.error=ESP_ERR_INVALID_RESPONSE;f.response.stage=CP_V3_TRANSPORT_RESPONSE_HEADERS;f.response.tls_connected=1;f.response.last_read=0;f.success_at=2;
    assert(run(&f,&r)&&f.posts==2&&f.charge_calls==2);
    make(&f,131072);f.error=ESP_ERR_INVALID_RESPONSE;f.response.stage=CP_V3_TRANSPORT_RESPONSE_HEADERS;f.response.last_read=23;
    assert(!run(&f,&r)&&f.posts==1&&!f.waits);
    make(&f,131072);f.error=ESP_FAIL;f.response.tls_connected=1;f.response.io_error=ESP_FAIL;
    assert(!run(&f,&r)&&f.posts==1&&!f.waits);
    for(int sign=-1;sign<=1;sign+=2){
        make(&f,131072);f.error=ESP_FAIL;f.response.tls_stack_error=sign*MBEDTLS_ERR_NET_CONN_RESET;f.success_at=3;
        assert(run(&f,&r)&&f.posts==3&&f.charge_calls==3);
        make(&f,131072);f.error=ESP_FAIL;f.response.io_error=sign*MBEDTLS_ERR_NET_RECV_FAILED;f.success_at=3;
        assert(run(&f,&r)&&f.posts==3&&f.charge_calls==3);
    }
    const int partial_status[]={302,401,403,409,410,422};
    for(unsigned i=0;i<sizeof partial_status/sizeof *partial_status;i++){
        make(&f,131072);f.response.parsed_http_status=partial_status[i];f.response.stage=CP_V3_TRANSPORT_RESPONSE_BODY;
        assert(!run(&f,&r)&&f.posts==1&&!f.waits);
    }
    const int partial_transient[]={200,202,408,425,429,500,503};
    for(unsigned i=0;i<sizeof partial_transient/sizeof *partial_transient;i++){
        make(&f,131072);f.response.parsed_http_status=partial_transient[i];f.response.stage=CP_V3_TRANSPORT_RESPONSE_BODY;f.success_at=3;
        assert(run(&f,&r)&&f.posts==3&&f.charge_calls==3&&f.waits==2);
    }
    const int terminal[]={301,400,401,403,409,422};
    for(unsigned i=0;i<sizeof terminal/sizeof *terminal;i++){
        make(&f,131072);f.error=ESP_OK;f.response.complete=true;f.response.http_status=terminal[i];f.response.tls_connected=1;
        assert(!run(&f,&r)&&f.posts==1&&!f.waits);
    }
    const int transient[]={408,425,429,500,503};
    for(unsigned i=0;i<sizeof transient/sizeof *transient;i++){
        make(&f,131072);f.error=ESP_OK;f.response.complete=true;f.response.http_status=transient[i];f.response.tls_connected=1;f.success_at=3;
        f.server_body="{\"error\":{\"retryable\":true}}";assert(run(&f,&r)&&f.posts==3&&f.charge_calls==3);
        make(&f,131072);f.error=ESP_OK;f.response.complete=true;f.response.http_status=transient[i];f.response.tls_connected=1;
        f.server_body="{\"error\":{\"retryable\":false}}";assert(!run(&f,&r)&&f.posts==1&&!f.waits);
    }
    puts("registration: exact frozen SHA/body/seq/uptime, real daily budget every attempt, 3-attempt bounds, cancellation, TLS tuple, parsed-status and terminal HTTP/JSON guards passed");
}
