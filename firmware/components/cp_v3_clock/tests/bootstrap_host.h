#pragma once
/* Minimal SDK ABI for executing production bootstrap.c on the host. These
 * doubles simulate call outcomes; signature correctness has a separate suite. */
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <sys/time.h>
#include "cp_settings.h"
#define CONFIG_MBEDTLS_HAVE_TIME 1
#define CONFIG_MBEDTLS_HAVE_TIME_DATE 1
#define CONFIG_MBEDTLS_CERTIFICATE_BUNDLE 1
#define ESP_ERR_WIFI_NOT_INIT 201
#define ESP_ERR_WIFI_NOT_STARTED 202
#define ESP_ERR_HTTP_EAGAIN 203
#define ESP_LOG_WARN 1
#define ESP_LOG_NONE 0
typedef void *TaskHandle_t;
typedef void *esp_event_handler_instance_t;
typedef const char *esp_event_base_t;
typedef struct { int unused; } esp_netif_t;
typedef struct { uint8_t reason; } wifi_event_sta_disconnected_t;
typedef int wifi_mode_t;
typedef int wifi_init_config_t;
#define WIFI_INIT_CONFIG_DEFAULT() 0
#define WIFI_STORAGE_RAM 1
#define WIFI_MODE_STA 1
#define WIFI_IF_STA 1
#define WIFI_AUTH_OPEN 0
#define WIFI_AUTH_WPA2_PSK 1
#define WIFI_AUTH_WPA2_ENTERPRISE 2
#define ESP_EAP_TYPE_PEAP 4
extern const char wifi_event_base[], ip_event_base[];
#define WIFI_EVENT wifi_event_base
#define IP_EVENT ip_event_base
#define ESP_EVENT_ANY_ID -1
#define IP_EVENT_STA_GOT_IP 1
#define WIFI_EVENT_STA_DISCONNECTED 2
#define IP_EVENT_STA_LOST_IP 3
typedef struct { struct { unsigned char ssid[32], password[64];
    struct { int authmode; } threshold; struct { bool capable; } pmf_cfg; } sta; } wifi_config_t;
#define ESP_SNTP_OPMODE_POLL 0
#define SNTP_SYNC_MODE_IMMED 0
#define SNTP_SYNC_STATUS_RESET 0
#define pdMS_TO_TICKS(ms) (ms)
#define HTTP_EVENT_HEADERS_SENT 1
#define HTTP_EVENT_ON_HEADER 2
#define HTTP_EVENT_ON_DATA 3
#define HTTP_EVENT_ON_FINISH 4
#define HTTP_EVENT_REDIRECT 5
#define HTTP_METHOD_POST 1
typedef void *esp_http_client_handle_t;
typedef struct { int event_id, data_len; char *data, *header_key, *header_value; } esp_http_client_event_t;
typedef struct {
    const char *url; int method, timeout_ms; bool is_async, disable_auto_redirect;
    esp_err_t (*event_handler)(esp_http_client_event_t *);
    int (*crt_bundle_attach)(void *); bool skip_cert_common_name_check;
    int buffer_size, buffer_size_tx;
} esp_http_client_config_t;
int esp_crt_bundle_attach(void *);
TaskHandle_t xTaskGetCurrentTaskHandle(void);
void vTaskDelay(unsigned);
int64_t esp_timer_get_time(void);
void esp_log_level_set(const char *, int);
esp_err_t esp_netif_init(void);
esp_err_t esp_event_loop_create_default(void);
esp_netif_t *esp_netif_get_handle_from_ifkey(const char *);
esp_netif_t *esp_netif_create_default_wifi_sta(void);
void esp_netif_destroy_default_wifi(esp_netif_t *);
esp_err_t esp_event_handler_instance_register(esp_event_base_t, int32_t,
    void (*)(void *, esp_event_base_t, int32_t, void *), void *, esp_event_handler_instance_t *);
esp_err_t esp_event_handler_instance_unregister(esp_event_base_t, int32_t, esp_event_handler_instance_t);
esp_err_t esp_wifi_get_mode(wifi_mode_t *);
esp_err_t esp_wifi_init(const wifi_init_config_t *);
esp_err_t esp_wifi_set_storage(int);
esp_err_t esp_wifi_set_mode(int);
esp_err_t esp_wifi_set_config(int, const wifi_config_t *);
esp_err_t esp_wifi_start(void);
esp_err_t esp_wifi_connect(void);
esp_err_t esp_wifi_stop(void);
esp_err_t esp_wifi_deinit(void);
esp_err_t esp_wifi_sta_enterprise_enable(void);
esp_err_t esp_wifi_sta_enterprise_disable(void);
esp_err_t esp_eap_client_use_default_cert_bundle(bool);
esp_err_t esp_eap_client_set_domain_name(const char *);
esp_err_t esp_eap_client_set_disable_time_check(bool);
esp_err_t esp_eap_client_set_eap_methods(int);
esp_err_t esp_eap_client_set_identity(const unsigned char *, int);
esp_err_t esp_eap_client_set_username(const unsigned char *, int);
esp_err_t esp_eap_client_set_password(const unsigned char *, int);
void esp_eap_client_clear_identity(void);
void esp_eap_client_clear_username(void);
void esp_eap_client_clear_password(void);
void esp_eap_client_clear_ca_cert(void);
bool esp_sntp_enabled(void);
void esp_sntp_stop(void);
void esp_sntp_set_time_sync_notification_cb(void (*)(struct timeval *));
void esp_sntp_setoperatingmode(int);
void esp_sntp_set_sync_mode(int);
void esp_sntp_setservername(int, const char *);
void esp_sntp_set_sync_status(int);
void esp_sntp_init(void);
void esp_fill_random(void *, size_t);
esp_http_client_handle_t esp_http_client_init(const esp_http_client_config_t *);
esp_err_t esp_http_client_set_header(esp_http_client_handle_t, const char *, const char *);
esp_err_t esp_http_client_set_post_field(esp_http_client_handle_t, const char *, int);
esp_err_t esp_http_client_perform(esp_http_client_handle_t);
int esp_http_client_get_status_code(esp_http_client_handle_t);
bool esp_http_client_is_complete_data_received(esp_http_client_handle_t);
esp_err_t esp_http_client_cleanup(esp_http_client_handle_t);

/* Unused cryptographic adapter is linked so the real bootstrap compiles. The
 * protocol verifier below is injected at its public boundary in this suite. */
#define MBEDTLS_PRIVATE(x) x
#define MBEDTLS_PK_ECDSA 1
#define MBEDTLS_ECP_DP_SECP256R1 1
typedef int mbedtls_mpi;
typedef struct { struct { int id; } grp; int Q; } mbedtls_ecp_keypair;
typedef struct { mbedtls_ecp_keypair ec; } mbedtls_pk_context;
static inline void mbedtls_pk_init(mbedtls_pk_context *p) { p->ec.grp.id = 1; }
static inline void mbedtls_pk_free(mbedtls_pk_context *p) { (void)p; }
static inline void mbedtls_mpi_init(mbedtls_mpi *p) { *p = 0; }
static inline void mbedtls_mpi_free(mbedtls_mpi *p) { (void)p; }
static inline int mbedtls_pk_parse_public_key(mbedtls_pk_context *p, const unsigned char *b, size_t n) { (void)p;(void)b;(void)n;return -1; }
static inline int mbedtls_pk_can_do(const mbedtls_pk_context *p, int t) { (void)p;(void)t;return 0; }
static inline int mbedtls_sha256(const void *p, size_t n, unsigned char *o, int t) { (void)p;(void)n;(void)o;(void)t;return -1; }
static inline mbedtls_ecp_keypair *mbedtls_pk_ec(mbedtls_pk_context p) { (void)p;return NULL; }
static inline int mbedtls_ecp_check_pubkey(const void *p, const void *q) { (void)p;(void)q;return -1; }
static inline int mbedtls_mpi_read_binary(mbedtls_mpi *p, const unsigned char *b, size_t n) { (void)p;(void)b;(void)n;return -1; }
static inline int mbedtls_ecdsa_verify(const void *g, const unsigned char *d, size_t n, const void *q, const mbedtls_mpi *r, const mbedtls_mpi *s) { (void)g;(void)d;(void)n;(void)q;(void)r;(void)s;return -1; }
