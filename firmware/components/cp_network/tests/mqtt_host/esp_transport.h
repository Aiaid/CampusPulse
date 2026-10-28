#pragma once
#include "mqtt_client.h"
enum {ERR_TCP_TRANSPORT_NO_MEM=-3,ERR_TCP_TRANSPORT_CONNECTION_FAILED=-2};
int esp_transport_poll_read(esp_transport_handle_t,int);
