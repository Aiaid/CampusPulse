#pragma once
/* HTTP/SDK doubles only. Real signature interoperability is tested by run.py.
 * No Wi-Fi/EAP/SNTP or wall-clock functions are provided to this harness. */
#include "esp_err.h"
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#define CONFIG_MBEDTLS_HAVE_TIME 1
#define CONFIG_MBEDTLS_HAVE_TIME_DATE 1
#define CONFIG_MBEDTLS_CERTIFICATE_BUNDLE 1
#define ESP_ERR_HTTP_EAGAIN 203
#define ESP_LOG_NONE 0
#define pdMS_TO_TICKS(ms) (ms)
#define HTTP_EVENT_HEADERS_SENT 1
#define HTTP_EVENT_ON_HEADER 2
#define HTTP_EVENT_ON_DATA 3
#define HTTP_EVENT_ON_FINISH 4
#define HTTP_EVENT_REDIRECT 5
#define HTTP_METHOD_POST 1
#define HTTP_AUTH_TYPE_NONE 0
#define HTTP_TRANSPORT_OVER_SSL 2
typedef void *esp_http_client_handle_t;
typedef struct {
    int event_id,data_len;
    char *data,*header_key,*header_value;
    void *user_data;
} esp_http_client_event_t;
typedef struct {
    const char *url,*username,*password,*cert_pem,*common_name;
    int method,timeout_ms,auth_type,max_authorization_retries,transport_type;
    bool is_async,disable_auto_redirect,skip_cert_common_name_check;
    esp_err_t (*event_handler)(esp_http_client_event_t *);
    void *user_data;
    int (*crt_bundle_attach)(void *);
    int buffer_size,buffer_size_tx;
} esp_http_client_config_t;
int esp_crt_bundle_attach(void *);
void vTaskDelay(unsigned);
int64_t esp_timer_get_time(void);
void esp_log_level_set(const char *,int);
void esp_fill_random(void *,size_t);
esp_http_client_handle_t esp_http_client_init(const esp_http_client_config_t *);
esp_err_t esp_http_client_set_header(esp_http_client_handle_t,const char *,const char *);
esp_err_t esp_http_client_set_post_field(esp_http_client_handle_t,const char *,int);
esp_err_t esp_http_client_perform(esp_http_client_handle_t);
int esp_http_client_get_status_code(esp_http_client_handle_t);
bool esp_http_client_is_complete_data_received(esp_http_client_handle_t);
esp_err_t esp_http_client_cleanup(esp_http_client_handle_t);

#define MBEDTLS_PRIVATE(x) x
#define MBEDTLS_PK_ECDSA 1
#define MBEDTLS_ECP_DP_SECP256R1 1
typedef int mbedtls_mpi;
typedef struct { struct { int id; } grp; int Q; } mbedtls_ecp_keypair;
typedef struct { mbedtls_ecp_keypair ec; } mbedtls_pk_context;
static inline void mbedtls_pk_init(mbedtls_pk_context *p) { p->ec.grp.id=1; }
static inline void mbedtls_pk_free(mbedtls_pk_context *p) { (void)p; }
static inline void mbedtls_mpi_init(mbedtls_mpi *p) { *p=0; }
static inline void mbedtls_mpi_free(mbedtls_mpi *p) { (void)p; }
static inline int mbedtls_pk_parse_public_key(mbedtls_pk_context *p,const unsigned char *b,size_t n) { (void)p;(void)b;(void)n;return -1; }
static inline int mbedtls_pk_can_do(const mbedtls_pk_context *p,int t) { (void)p;(void)t;return 0; }
static inline int mbedtls_sha256(const void *p,size_t n,unsigned char *o,int t) { (void)p;(void)n;(void)o;(void)t;return -1; }
static inline mbedtls_ecp_keypair *mbedtls_pk_ec(mbedtls_pk_context p) { (void)p;return NULL; }
static inline int mbedtls_ecp_check_pubkey(const void *p,const void *q) { (void)p;(void)q;return -1; }
static inline int mbedtls_mpi_read_binary(mbedtls_mpi *p,const unsigned char *b,size_t n) { (void)p;(void)b;(void)n;return -1; }
static inline int mbedtls_ecdsa_verify(const void *g,const unsigned char *d,size_t n,const void *q,const mbedtls_mpi *r,const mbedtls_mpi *s) { (void)g;(void)d;(void)n;(void)q;(void)r;(void)s;return -1; }
