#pragma once
#include "esp_err.h"
#include <string.h>
#include <stdlib.h>
typedef void *httpd_handle_t;
typedef struct { int content_len; } httpd_req_t;
typedef struct { const char *uri; int method; esp_err_t (*handler)(httpd_req_t *); } httpd_uri_t;
typedef struct { int max_uri_handlers,max_open_sockets,stack_size,recv_wait_timeout,send_wait_timeout; } httpd_config_t;
#define HTTPD_DEFAULT_CONFIG() ((httpd_config_t){0})
#define HTTPD_403_FORBIDDEN 403
#define HTTPD_400_BAD_REQUEST 400
#define HTTP_GET 0
#define HTTP_POST 1
#define ESP_ERR_WIFI_NOT_STARTED 0x3002
#define WIFI_AUTH_WPA2_PSK 3
#define WIFI_STORAGE_RAM 1
#define WIFI_MODE_AP 2
#define WIFI_IF_AP 1
#define ESP_BT_CONTROLLER_STATUS_IDLE 0
typedef struct { int dummy; } esp_netif_t;
typedef struct { int dummy; } wifi_init_config_t;
typedef struct { struct {unsigned char ssid[32],password[64];unsigned char ssid_len,authmode,max_connection,channel;}ap;} wifi_config_t;
#define WIFI_INIT_CONFIG_DEFAULT() ((wifi_init_config_t){0})
typedef struct {char version[32];}esp_app_desc_t;
static inline const esp_app_desc_t *esp_app_get_description(void){static const esp_app_desc_t desc={"synthetic-sdk-test"};return &desc;}
extern int64_t cp_test_time_us;
static inline int64_t esp_timer_get_time(void){return cp_test_time_us;}
static inline int esp_netif_init(void){return ESP_OK;}
static inline esp_netif_t *esp_netif_create_default_wifi_ap(void){return calloc(1,sizeof(esp_netif_t));}
static inline void esp_netif_destroy_default_wifi(esp_netif_t *p){free(p);}
static inline int esp_wifi_init(const wifi_init_config_t *c){(void)c;return ESP_OK;}
static inline int esp_wifi_set_storage(int s){(void)s;return ESP_OK;}
static inline int esp_wifi_set_mode(int s){(void)s;return ESP_OK;}
static inline int esp_wifi_set_config(int s,const wifi_config_t *c){(void)s;(void)c;return ESP_OK;}
static inline int esp_wifi_start(void){return ESP_OK;}
static inline int esp_wifi_stop(void){return ESP_OK;}
static inline int esp_wifi_deinit(void){return ESP_OK;}
static inline int esp_bt_controller_get_status(void){return ESP_BT_CONTROLLER_STATUS_IDLE;}
static inline int httpd_start(httpd_handle_t *h,const httpd_config_t *c){(void)c;*h=(void *)1;return ESP_OK;}
static inline int httpd_stop(httpd_handle_t h){(void)h;return ESP_OK;}
static inline int httpd_register_uri_handler(httpd_handle_t h,const httpd_uri_t *u){(void)h;(void)u;return ESP_OK;}
static inline int httpd_req_get_hdr_value_str(httpd_req_t *r,const char *name,char *out,size_t cap){(void)r;(void)name;(void)out;(void)cap;return ESP_FAIL;}
static inline size_t httpd_req_get_hdr_value_len(httpd_req_t *r,const char *name){(void)r;(void)name;return 0;}
static inline int httpd_resp_set_hdr(httpd_req_t *r,const char *name,const char *v){(void)r;(void)name;(void)v;return ESP_OK;}
static inline int httpd_resp_set_type(httpd_req_t *r,const char *type){(void)r;(void)type;return ESP_OK;}
static inline int httpd_resp_set_status(httpd_req_t *r,const char *status){(void)r;(void)status;return ESP_OK;}
static inline int httpd_resp_sendstr(httpd_req_t *r,const char *s){(void)r;(void)s;return ESP_OK;}
static inline int httpd_resp_sendstr_chunk(httpd_req_t *r,const char *s){(void)r;(void)s;return ESP_OK;}
static inline int httpd_resp_send_chunk(httpd_req_t *r,const char *s,size_t n){(void)r;(void)s;(void)n;return ESP_OK;}
static inline int httpd_resp_send_err(httpd_req_t *r,int code,const char *s){(void)r;(void)code;(void)s;return ESP_FAIL;}
static inline int httpd_req_recv(httpd_req_t *r,char *s,size_t n){(void)r;(void)s;(void)n;return -1;}
