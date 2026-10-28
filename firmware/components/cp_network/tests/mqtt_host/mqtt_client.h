#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "esp_err.h"
typedef void *esp_transport_handle_t;
typedef const char *esp_event_base_t;
typedef struct test_client *esp_mqtt_client_handle_t;
typedef struct {int esp_tls_stack_err,esp_tls_cert_verify_flags,esp_transport_sock_errno,esp_tls_last_esp_err;} esp_mqtt_error_codes_t;
typedef struct {esp_mqtt_client_handle_t client;int msg_id;const char *topic,*data;int topic_len,data_len,total_data_len,current_data_offset,qos;bool retain;esp_mqtt_error_codes_t *error_handle;} esp_mqtt_event_t;
typedef esp_mqtt_event_t *esp_mqtt_event_handle_t;
typedef void (*esp_event_handler_t)(void *,esp_event_base_t,int32_t,void *);
enum {MQTT_EVENT_BEFORE_CONNECT,MQTT_EVENT_CONNECTED,MQTT_EVENT_DISCONNECTED,MQTT_EVENT_ERROR,MQTT_EVENT_SUBSCRIBED,MQTT_EVENT_PUBLISHED,MQTT_EVENT_DATA};
#define ESP_EVENT_ANY_ID -1
#define MQTT_PROTOCOL_V_3_1_1 4
#define MQTT_OVER_SSL_SCHEME "mqtts"
typedef struct {
    struct {struct {const char *uri;} address;struct {esp_err_t (*crt_bundle_attach)(void *);bool skip_cert_common_name_check;} verification;} broker;
    struct {const char *client_id,*username;struct {const char *password;} authentication;} credentials;
    struct {int protocol_ver,keepalive;bool disable_clean_session;int message_retransmit_timeout;} session;
    struct {bool disable_auto_reconnect;int timeout_ms,refresh_connection_after_ms;} network;
    struct {unsigned stack_size;int priority;} task;
    struct {int size,out_size;} buffer;
    struct {uint64_t limit;} outbox;
} esp_mqtt_client_config_t;
esp_mqtt_client_handle_t esp_mqtt_client_init(const esp_mqtt_client_config_t *);
esp_err_t esp_mqtt_client_register_event(esp_mqtt_client_handle_t,int,esp_event_handler_t,void *);
esp_err_t esp_mqtt_client_start(esp_mqtt_client_handle_t);
esp_err_t esp_mqtt_client_stop(esp_mqtt_client_handle_t);
esp_err_t esp_mqtt_client_destroy(esp_mqtt_client_handle_t);
esp_transport_handle_t esp_mqtt_client_get_transport(esp_mqtt_client_handle_t,char *);
int esp_mqtt_client_subscribe(esp_mqtt_client_handle_t,const char *,int);
int esp_mqtt_client_publish(esp_mqtt_client_handle_t,const char *,const char *,int,int,int);
int esp_mqtt_client_get_outbox_size(esp_mqtt_client_handle_t);
