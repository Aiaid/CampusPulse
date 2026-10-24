#pragma once
#include "esp_err.h"
typedef void *esp_http_client_handle_t;
typedef enum {HTTP_METHOD_GET,HTTP_METHOD_POST,HTTP_METHOD_HEAD} esp_http_client_method_t;
typedef enum {HTTP_EVENT_ERROR,HTTP_EVENT_ON_CONNECTED,HTTP_EVENT_HEADERS_SENT,HTTP_EVENT_ON_HEADER,
              HTTP_EVENT_ON_DATA,HTTP_EVENT_ON_FINISH,HTTP_EVENT_DISCONNECTED} esp_http_client_event_id_t;
typedef struct {esp_http_client_event_id_t event_id;esp_http_client_handle_t client;void *data;int data_len;void *user_data;} esp_http_client_event_t;
esp_err_t esp_http_client_set_timeout_ms(esp_http_client_handle_t,int);
esp_err_t esp_http_client_set_method(esp_http_client_handle_t,esp_http_client_method_t);
