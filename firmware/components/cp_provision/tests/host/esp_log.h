#pragma once
#define ESP_LOG_DEBUG 4
#define ESP_LOGD(tag,...) ((void)(tag))
#define ESP_LOGI(tag,...) ((void)(tag))
#define ESP_LOGW(tag,...) ((void)(tag))
#define ESP_LOGE(tag,...) ((void)(tag))
#define ESP_LOG_BUFFER_HEX_LEVEL(tag,buf,len,level) ((void)(tag),(void)(buf),(void)(len),(void)(level))
