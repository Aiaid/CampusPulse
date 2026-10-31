#pragma once
#include <stddef.h>
typedef int esp_err_t; typedef int nvs_handle_t; typedef int nvs_type_t;
#define NVS_TYPE_BLOB 0x42
#define ESP_OK 0
#define ESP_FAIL -1
#define ESP_ERR_NVS_NOT_FOUND 1
#define ESP_ERR_NVS_TYPE_MISMATCH 2
#define NVS_READONLY 0
#define NVS_READWRITE 1
typedef struct { size_t used_entries,free_entries,available_entries,total_entries,namespace_count; } nvs_stats_t;
esp_err_t nvs_open(const char *,int,nvs_handle_t *);
esp_err_t nvs_find_key(nvs_handle_t,const char *,nvs_type_t *);
esp_err_t nvs_get_blob(nvs_handle_t,const char *,void *,size_t *);
esp_err_t nvs_set_blob(nvs_handle_t,const char *,const void *,size_t);
esp_err_t nvs_erase_key(nvs_handle_t,const char *);
esp_err_t nvs_commit(nvs_handle_t);
void nvs_close(nvs_handle_t);
esp_err_t nvs_get_stats(const char *,nvs_stats_t *);
