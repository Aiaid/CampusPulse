#pragma once
#include "cp_v3_transport.h"
#include "esp_tls_errors.h"
#include "mbedtls/net_sockets.h"
#include "mbedtls/ssl.h"

/* Restrict cache recovery to observed network outcomes. flags==0 alone does
 * not turn a certificate parser, local allocation or SHA failure into network
 * failure. SDK error handles can store either sign of an mbedTLS code. */
static inline bool cp_v3_transport_network_failure(esp_err_t result,const cp_v3_transport_response_t *r) {
    if(!r||r->tls_verify_flags)return false;
    int esp=r->tls_esp_error;
    if(esp&&esp!=ESP_ERR_ESP_TLS_FAILED_CONNECT_TO_HOST&&esp!=ESP_ERR_ESP_TLS_CONNECTION_TIMEOUT&&
       esp!=ESP_ERR_ESP_TLS_TCP_CLOSED_FIN&&esp!=ESP_ERR_ESP_TLS_SERVER_HANDSHAKE_TIMEOUT&&
       esp!=ESP_ERR_MBEDTLS_SSL_HANDSHAKE_FAILED&&esp!=ESP_ERR_MBEDTLS_SSL_READ_FAILED&&
       esp!=ESP_ERR_MBEDTLS_SSL_WRITE_FAILED)return false;
    int64_t stack=r->tls_stack_error;if(stack>0)stack=-stack;
    bool stack_network=stack==MBEDTLS_ERR_NET_CONNECT_FAILED||stack==MBEDTLS_ERR_NET_RECV_FAILED||
        stack==MBEDTLS_ERR_NET_SEND_FAILED||stack==MBEDTLS_ERR_NET_CONN_RESET||
        stack==MBEDTLS_ERR_SSL_CONN_EOF||stack==MBEDTLS_ERR_SSL_TIMEOUT;
    if(stack&&!stack_network)return false;
    int64_t io=r->io_error;if(io>0)io=-io;
    bool io_network=io==MBEDTLS_ERR_NET_RECV_FAILED||io==MBEDTLS_ERR_NET_SEND_FAILED||
        io==MBEDTLS_ERR_NET_CONN_RESET||io==MBEDTLS_ERR_SSL_CONN_EOF||io==MBEDTLS_ERR_SSL_TIMEOUT;
    if(result==ESP_ERR_TIMEOUT)return true;
    if(result==ESP_FAIL)return stack_network||io_network||esp==ESP_ERR_ESP_TLS_FAILED_CONNECT_TO_HOST||
        esp==ESP_ERR_ESP_TLS_CONNECTION_TIMEOUT||esp==ESP_ERR_ESP_TLS_TCP_CLOSED_FIN;
    /* EOF before a complete HTTP response; positive input rejected by the HTTP
     * parser is not treated as a DNS/network failure. */
    return result==ESP_ERR_INVALID_RESPONSE&&r->tls_connected==1&&r->last_read==0&&
        r->stage>=CP_V3_TRANSPORT_RESPONSE_HEADERS&&r->stage<=CP_V3_TRANSPORT_RESPONSE_BODY;
}
