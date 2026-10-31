/* Compile the actual generated SDK async connection and close functions with
 * bounded host shims. These tests do not claim hardware/network acceptance. */
#include <assert.h>
#include <errno.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef int esp_err_t;
enum { ESP_OK=0, ESP_FAIL=-1, ESP_ERR_NO_MEM=0x101,
       ESP_ERR_INVALID_ARG=0x102, ESP_ERR_ESP_TLS_FAILED_CONNECT_TO_HOST=0x8004,
       ESP_ERR_MBEDTLS_SSL_HANDSHAKE_FAILED=0x801a, ERR_TCP_TRANSPORT_NO_MEM=-3,
       ERR_TCP_TRANSPORT_CONNECTION_FAILED=-1, ERR_TCP_TRANSPORT_CONNECTION_TIMEOUT=0,
       ERR_TCP_TRANSPORT_CONNECTION_CLOSED_BY_FIN=-2, ESP_ERR_ESP_TLS_TCP_CLOSED_FIN=0x8008,
       ESP_TLS_ERR_SSL_WANT_READ=-0x6900, ESP_TLS_ERR_SSL_TIMEOUT=-0x6800 };
#define INVALID_SOCKET (-1)
#define ESP_STATIC_ANALYZER_CHECK(condition,result) do { if(condition) return (result); } while(0)
#define ESP_LOGE(...) ((void)0)
typedef struct { int last_error, esp_tls_error_code, esp_tls_flags; } esp_tls_last_error_t;
typedef esp_tls_last_error_t *esp_tls_error_handle_t;
typedef struct { int timeout_ms; bool is_plain_tcp, non_block; } esp_tls_cfg_t;
typedef struct { esp_tls_last_error_t error; int socket, system_error; } esp_tls_t;
typedef enum { TRANS_SSL_INIT=0, TRANS_SSL_CONNECTING } transport_ssl_conn_state_t;
typedef struct { esp_tls_t *tls; esp_tls_cfg_t cfg; bool ssl_initialized;
    transport_ssl_conn_state_t conn_state; int sockfd; } transport_esp_tls_t;
typedef struct { void *data; esp_tls_last_error_t error; int socket_error; } transport_t;
typedef transport_t *esp_transport_handle_t;

static int progress, socket_result, error_result, init_calls, connect_calls,
    destroy_calls, live_tls, copy_calls, socket_close_calls, read_poll, read_result,
    read_calls, injected_system_error;
static bool fail_init;
static esp_tls_last_error_t injected_error;
static esp_tls_cfg_t observed_config;
static esp_tls_t *esp_tls_init(void) {
    ++init_calls;
    if(fail_init)return NULL;
    esp_tls_t *tls=calloc(1,sizeof(*tls));assert(tls);tls->socket=42;++live_tls;return tls;
}
static int esp_tls_conn_new_async(const char *host,int length,int port,const esp_tls_cfg_t *config,esp_tls_t *tls) {
    assert(host && length==(int)strlen(host) && port==443 && tls);
    ++connect_calls;observed_config=*config;tls->error=injected_error;
    tls->system_error=injected_system_error;return progress;
}
static esp_err_t esp_tls_get_conn_sockfd(esp_tls_t *tls,int *socket) {
    assert(tls && socket);if(socket_result!=ESP_OK)return socket_result;
    *socket=tls->socket;return ESP_OK;
}
static esp_err_t esp_tls_get_error_handle(esp_tls_t *tls,esp_tls_error_handle_t *error) {
    assert(tls && error);if(error_result!=ESP_OK)return error_result;
    *error=&tls->error;return ESP_OK;
}
static esp_tls_error_handle_t esp_transport_get_error_handle(esp_transport_handle_t transport) {
    return transport?&transport->error:NULL;
}
static void esp_transport_set_errors(esp_transport_handle_t transport,const esp_tls_error_handle_t error) {
    assert(transport && error);transport->error=*error;
    /* The SDK stores system errno separately from esp_tls_last_error_t and
     * copies/clears that channel when it bridges the TLS error tracker. */
    esp_tls_t *tls=(esp_tls_t *)error;
    transport->socket_error=tls->system_error;tls->system_error=0;++copy_calls;
}
static void capture_tcp_transport_error(esp_transport_handle_t transport,int error) {
    assert(error==ERR_TCP_TRANSPORT_NO_MEM || error==ERR_TCP_TRANSPORT_CONNECTION_CLOSED_BY_FIN);
    transport->error.last_error=error==ERR_TCP_TRANSPORT_NO_MEM?ESP_ERR_NO_MEM:ESP_ERR_ESP_TLS_TCP_CLOSED_FIN;
}
static int esp_transport_poll_read(esp_transport_handle_t transport,int timeout) {
    assert(transport && timeout==1000);return read_poll;
}
static int esp_tls_conn_read(esp_tls_t *tls,unsigned char *buffer,int length) {
    assert(tls && buffer && length==32);++read_calls;tls->error=injected_error;
    tls->system_error=injected_system_error;return read_result;
}
static int esp_tls_conn_destroy(esp_tls_t *tls) {
    if(!tls)return -1;
    assert(live_tls==1);--live_tls;++destroy_calls;free(tls);return 0;
}
static int close(int socket) { assert(socket>=0);++socket_close_calls;return 0; }

/* This include is extracted from the fingerprint-checked generated SDK source. */
#include "transport_async_actual.inc"

static void reset(transport_t *transport,transport_esp_tls_t *ssl) {
    assert(live_tls==0);memset(transport,0,sizeof(*transport));memset(ssl,0,sizeof(*ssl));
    transport->data=ssl;progress=socket_result=error_result=ESP_OK;
    init_calls=connect_calls=destroy_calls=copy_calls=socket_close_calls=0;
    read_poll=read_result=read_calls=injected_system_error=0;
    fail_init=false;memset(&injected_error,0,sizeof(injected_error));
}
static int connect_test(transport_t *transport) {
    return esp_tls_connect_async(transport,"example.invalid",443,12000,false);
}
static void cleanup(transport_t *transport,transport_esp_tls_t *ssl,int expected_destroy) {
    base_close(transport);base_close(transport);
    assert(live_tls==0 && destroy_calls==expected_destroy && socket_close_calls==0);
    assert(!ssl->tls && !ssl->ssl_initialized && ssl->sockfd==INVALID_SOCKET && ssl->conn_state==TRANS_SSL_INIT);
}
int main(void) {
    transport_t transport;transport_esp_tls_t ssl;
    reset(&transport,&ssl);progress=0;
    assert(connect_test(&transport)==0 && init_calls==1 && connect_calls==1 && !copy_calls);
    assert(ssl.ssl_initialized && ssl.conn_state==TRANS_SSL_CONNECTING && ssl.sockfd==42);
    assert(observed_config.non_block && !observed_config.is_plain_tcp && observed_config.timeout_ms==12000);
    progress=1;assert(connect_test(&transport)==1 && init_calls==1 && connect_calls==2 && !copy_calls);
    assert(transport.error.last_error==ESP_OK);cleanup(&transport,&ssl,1);

    reset(&transport,&ssl);progress=-1;
    injected_error=(esp_tls_last_error_t){ESP_ERR_MBEDTLS_SSL_HANDSHAKE_FAILED,0x2700,0x08};injected_system_error=104;
    assert(connect_test(&transport)==-1 && copy_calls==1 && !destroy_calls);
    assert(transport.error.last_error==ESP_ERR_MBEDTLS_SSL_HANDSHAKE_FAILED);
    assert(transport.error.esp_tls_error_code==0x2700 && transport.error.esp_tls_flags==0x08 && transport.socket_error==104);
    cleanup(&transport,&ssl,1);

    reset(&transport,&ssl);progress=-1;error_result=ESP_FAIL;
    assert(connect_test(&transport)==-1 && !copy_calls);
    assert(transport.error.last_error==ESP_ERR_ESP_TLS_FAILED_CONNECT_TO_HOST);
    cleanup(&transport,&ssl,1);

    reset(&transport,&ssl);progress=-1;
    assert(connect_test(&transport)==-1 && copy_calls==1);
    assert(transport.error.last_error==ESP_ERR_ESP_TLS_FAILED_CONNECT_TO_HOST);
    cleanup(&transport,&ssl,1);

    reset(&transport,&ssl);fail_init=true;
    assert(connect_test(&transport)==-1 && init_calls==1 && !connect_calls && !copy_calls);
    assert(transport.error.last_error==ESP_ERR_NO_MEM);cleanup(&transport,&ssl,0);

    reset(&transport,&ssl);progress=1;socket_result=ESP_ERR_INVALID_ARG;
    assert(connect_test(&transport)==-1 && copy_calls==1 && !destroy_calls);
    assert(transport.error.last_error==ESP_ERR_INVALID_ARG);
    cleanup(&transport,&ssl,1);

    reset(&transport,&ssl);progress=0;socket_result=ESP_ERR_INVALID_ARG;
    injected_error=(esp_tls_last_error_t){ESP_ERR_MBEDTLS_SSL_HANDSHAKE_FAILED,0x7100,0x10};
    assert(connect_test(&transport)==-1 && copy_calls==1 && !destroy_calls);
    assert(transport.error.last_error==ESP_ERR_MBEDTLS_SSL_HANDSHAKE_FAILED && transport.error.esp_tls_error_code==0x7100 && transport.error.esp_tls_flags==0x10);
    cleanup(&transport,&ssl,1);

    reset(&transport,&ssl);progress=1;assert(connect_test(&transport)==1);
    char buffer[32];errno=0;read_poll=0;
    assert(ssl_read(&transport,buffer,sizeof(buffer),1000)==ERR_TCP_TRANSPORT_CONNECTION_TIMEOUT);
    assert(errno==EAGAIN && !read_calls && !copy_calls);
    errno=0;read_poll=1;read_result=ESP_TLS_ERR_SSL_WANT_READ;
    assert(ssl_read(&transport,buffer,sizeof(buffer),1000)==ERR_TCP_TRANSPORT_CONNECTION_TIMEOUT);
    assert(errno==EAGAIN && read_calls==1);
    errno=0;read_result=ESP_TLS_ERR_SSL_TIMEOUT;
    assert(ssl_read(&transport,buffer,sizeof(buffer),1000)==ERR_TCP_TRANSPORT_CONNECTION_TIMEOUT && errno==EAGAIN);
    errno=0;read_result=0;
    assert(ssl_read(&transport,buffer,sizeof(buffer),1000)==ERR_TCP_TRANSPORT_CONNECTION_CLOSED_BY_FIN && errno==0);
    assert(transport.error.last_error==ESP_ERR_ESP_TLS_TCP_CLOSED_FIN);
    errno=0;read_poll=-1;
    assert(ssl_read(&transport,buffer,sizeof(buffer),1000)==ERR_TCP_TRANSPORT_CONNECTION_FAILED && errno==0);
    errno=0;read_poll=1;read_result=-0x7100;
    injected_error=(esp_tls_last_error_t){ESP_FAIL,0x7100,0};injected_system_error=104;
    assert(ssl_read(&transport,buffer,sizeof(buffer),1000)==-0x7100 && errno==0);
    assert(transport.error.esp_tls_error_code==0x7100 && transport.socket_error==104);
    read_result=23;errno=0;
    assert(ssl_read(&transport,buffer,sizeof(buffer),1000)==23 && errno==0);
    ssl.cfg.non_block=false;read_poll=0;errno=0;
    assert(ssl_read(&transport,buffer,sizeof(buffer),1000)==ERR_TCP_TRANSPORT_CONNECTION_TIMEOUT && errno==0);
    read_poll=1;read_result=ESP_TLS_ERR_SSL_WANT_READ;errno=0;
    assert(ssl_read(&transport,buffer,sizeof(buffer),1000)==ERR_TCP_TRANSPORT_CONNECTION_TIMEOUT && errno==0);
    read_result=ESP_TLS_ERR_SSL_TIMEOUT;errno=0;
    assert(ssl_read(&transport,buffer,sizeof(buffer),1000)==ERR_TCP_TRANSPORT_CONNECTION_TIMEOUT && errno==0);
    cleanup(&transport,&ssl,1);
    puts("Actual pinned async transport: pending/success, TLS details, OOM, cleanup and retry/EOF/error/sync read semantics passed");
}
