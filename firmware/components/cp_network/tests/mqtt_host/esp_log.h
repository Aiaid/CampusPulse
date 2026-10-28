#pragma once
#define ESP_LOG_NONE 0
#define ESP_LOGI(tag,...) ((void)(tag),test_log(__VA_ARGS__))
#define ESP_LOGW(tag,...) ((void)(tag),test_log(__VA_ARGS__))
void test_log(const char *,...);
void esp_log_level_set(const char *,int);
