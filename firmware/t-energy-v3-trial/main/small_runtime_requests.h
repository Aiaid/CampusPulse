#pragma once
#include "cp_v3_transport.h"
#include "esp_tls_errors.h"
#include "mbedtls/net_sockets.h"
#include "mbedtls/ssl.h"
#include <string.h>

/* Shared by ordinary requests and startup retries. The mandatory charge
 * callback is the actual existing board-budget owner on device. A retry never
 * calls transport through a different, uncharged route. */
typedef struct {
    void *context;
    bool (*stopped)(void *);
    bool (*charge_post)(void *,size_t);
    esp_err_t (*exchange)(void *,cp_v3_http_method_t,const char *,const void *,size_t,
                         bool,cp_v3_transport_response_t *);
    bool (*server_retryable)(void *,const cp_v3_transport_response_t *);
} te_small_request_io_t;
typedef enum {
    TE_REQUEST_OK,TE_REQUEST_TRANSIENT,TE_REQUEST_TERMINAL,
    TE_REQUEST_CANCELLED,TE_REQUEST_BUDGET_DENIED
} te_small_request_result_t;
static inline bool te_small_transient_http(int status){
    return status==408||status==425||status==429||(status>=500&&status<=599);
}
static inline bool te_small_network_stack(int error){
    int64_t code=error;if(code>0)code=-code;
    return !code||code==MBEDTLS_ERR_NET_SOCKET_FAILED||code==MBEDTLS_ERR_NET_CONNECT_FAILED||
        code==MBEDTLS_ERR_NET_RECV_FAILED||code==MBEDTLS_ERR_NET_SEND_FAILED||
        code==MBEDTLS_ERR_NET_CONN_RESET||code==MBEDTLS_ERR_NET_UNKNOWN_HOST||
        code==MBEDTLS_ERR_SSL_TIMEOUT||code==MBEDTLS_ERR_SSL_PEER_CLOSE_NOTIFY||code==MBEDTLS_ERR_SSL_CONN_EOF;
}
static inline bool te_small_network_tls(const cp_v3_transport_response_t *r){
    if(r->tls_verify_flags||!te_small_network_stack(r->tls_stack_error))return false;
    switch(r->tls_esp_error){
    case 0:
    case ESP_ERR_ESP_TLS_CANNOT_RESOLVE_HOSTNAME:
    case ESP_ERR_ESP_TLS_CANNOT_CREATE_SOCKET:
    case ESP_ERR_ESP_TLS_FAILED_CONNECT_TO_HOST:
    case ESP_ERR_ESP_TLS_CONNECTION_TIMEOUT:
    case ESP_ERR_ESP_TLS_TCP_CLOSED_FIN:
    case ESP_ERR_ESP_TLS_SERVER_HANDSHAKE_TIMEOUT:
    case ESP_ERR_MBEDTLS_SSL_READ_FAILED:
    case ESP_ERR_MBEDTLS_SSL_WRITE_FAILED:return true;
    case ESP_ERR_MBEDTLS_SSL_HANDSHAKE_FAILED:
        /* Unknown handshake/verification failure is terminal even with flags0. */
        return r->tls_stack_error!=0;
    default:return false;
    }
}
static inline te_small_request_result_t te_small_request_once(const te_small_request_io_t *io,
    cp_v3_http_method_t method,const char *path,const void *body,size_t bytes,bool receipt_only,
    cp_v3_transport_response_t *r){
    if(r)memset(r,0,sizeof *r);
    if(!io||!r||!io->stopped||!io->charge_post||!io->exchange||!io->server_retryable||
       !path||(method==CP_V3_HTTP_POST&&(!body||!bytes)))return TE_REQUEST_TERMINAL;
    if(io->stopped(io->context))return TE_REQUEST_CANCELLED;
    if(method==CP_V3_HTTP_POST&&!io->charge_post(io->context,bytes))return TE_REQUEST_BUDGET_DENIED;
    if(io->stopped(io->context))return TE_REQUEST_CANCELLED;
    esp_err_t error=io->exchange(io->context,method,path,body,bytes,receipt_only,r);
    if(io->stopped(io->context)||error==ESP_ERR_INVALID_STATE)return TE_REQUEST_CANCELLED;
    if(r->tls_verify_flags||!te_small_network_tls(r))return TE_REQUEST_TERMINAL;
    /* A known terminal status is still terminal when the body is truncated.
     * parsed_http_status is diagnostic, never a successful receipt. */
    int status=r->http_status?r->http_status:r->parsed_http_status;
    if(status&&!((status>=200&&status<300)||te_small_transient_http(status)))return TE_REQUEST_TERMINAL;
    if(error==ESP_OK&&r->complete&&r->http_status>=200&&r->http_status<300){
        return r->tls_connected==1&&!r->tls_esp_error&&!r->tls_stack_error?TE_REQUEST_OK:TE_REQUEST_TERMINAL;
    }
    if(r->complete){
        return te_small_transient_http(status)&&io->server_retryable(io->context,r)?TE_REQUEST_TRANSIENT:TE_REQUEST_TERMINAL;
    }
    if(r->stage==CP_V3_TRANSPORT_IDLE)return TE_REQUEST_TERMINAL;
    if(error==ESP_ERR_INVALID_RESPONSE){
        /* EOF before any status is a network interruption; a positive chunk
         * rejected by the HTTP parser is not a retryable transport failure. */
        return r->tls_connected==1&&r->stage>=CP_V3_TRANSPORT_RESPONSE_HEADERS&&
            r->stage<=CP_V3_TRANSPORT_RESPONSE_BODY&&r->last_read==0?TE_REQUEST_TRANSIENT:TE_REQUEST_TERMINAL;
    }
    if(error==ESP_ERR_TIMEOUT)return TE_REQUEST_TRANSIENT;
    if(error==ESP_ERR_NOT_FOUND&&r->stage==CP_V3_TRANSPORT_DNS)return TE_REQUEST_TRANSIENT;
    if(error==ESP_FAIL){
        bool network=(r->tls_stack_error&&te_small_network_stack(r->tls_stack_error))||
            (r->io_error&&te_small_network_stack(r->io_error))||
            r->tls_esp_error==ESP_ERR_ESP_TLS_FAILED_CONNECT_TO_HOST||
            r->tls_esp_error==ESP_ERR_ESP_TLS_CONNECTION_TIMEOUT||r->tls_esp_error==ESP_ERR_ESP_TLS_TCP_CLOSED_FIN;
        return network?TE_REQUEST_TRANSIENT:TE_REQUEST_TERMINAL;
    }
    return TE_REQUEST_TERMINAL;
}

typedef struct {
    const te_small_request_io_t *request;
    void *context;
    bool (*wait)(void *,uint32_t);
    void (*attempt)(void *,unsigned,size_t);
} te_small_registration_io_t;
/* One already serialized capability request, sequence and uptime. No encoder,
 * entropy or clock callback is available here to regenerate its identity. */
static inline bool te_small_registration_exchange(const te_small_registration_io_t *io,
    const void *body,size_t bytes,cp_v3_transport_response_t *response){
    if(response)memset(response,0,sizeof *response);
    if(!io||!io->request||!io->request->stopped||!io->wait||!io->attempt||!body||!bytes||!response)return false;
    for(unsigned attempt=0;attempt<3;attempt++){
        if(io->request->stopped(io->request->context))return false;
        io->attempt(io->context,attempt,bytes);
        te_small_request_result_t result=te_small_request_once(io->request,CP_V3_HTTP_POST,
            "/api/v3/device/capabilities",body,bytes,false,response);
        if(result==TE_REQUEST_OK)return true;
        if(result!=TE_REQUEST_TRANSIENT||attempt==2||io->request->stopped(io->request->context))return false;
        if(!io->wait(io->context,(attempt+1u)*1000u))return false;
    }
    return false;
}
