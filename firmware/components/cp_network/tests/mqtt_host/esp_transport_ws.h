#pragma once
#include "mqtt_client.h"
esp_err_t esp_transport_ws_set_headers(esp_transport_handle_t,const char *);
int esp_transport_ws_get_upgrade_request_status(esp_transport_handle_t);
