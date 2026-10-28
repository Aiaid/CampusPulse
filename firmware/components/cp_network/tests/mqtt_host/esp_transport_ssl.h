#pragma once
#include "mqtt_client.h"
#define ESP_TLS_DYN_BUF_RX_STATIC 1
void esp_transport_ssl_set_esp_tls_dyn_buf_strategy(esp_transport_handle_t,int);
