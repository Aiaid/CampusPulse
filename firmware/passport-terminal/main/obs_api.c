// obs_api.c —— 实现见 obs_api.h。本文件为本基线新写。
#include "obs_api.h"

// 真实凭据在 term_cred_local.h（gitignore，不进仓库）；
// 缺失时退回模板占位值，保证无凭据也能编译（提交会被拒属预期）。
#if __has_include("term_cred_local.h")
#include "term_cred_local.h"    // CP_API_BASE / CP_OPERATOR_TOKEN
#else
#include "term_cred.example.h"
#endif

#include "cJSON.h"
#include "esp_crt_bundle.h"
#include "esp_http_client.h"
#include "esp_log.h"

#include <stdio.h>
#include <string.h>

static const char *TAG = "obs_api";

#define RESP_BUF_SIZE  2048
#define HTTP_TIMEOUT_MS 10000

// esp_http_client 事件回调：把响应体攒进静态缓冲。
// 静态而不是栈：2048B 放任务栈上有溢出风险（4KB 栈）。
static char s_resp[RESP_BUF_SIZE];
static int s_resp_len;

static esp_err_t on_http(esp_http_client_event_t *evt)
{
    if (evt->event_id == HTTP_EVENT_ON_DATA && evt->data_len > 0) {
        const int room = RESP_BUF_SIZE - 1 - s_resp_len;
        const int take = evt->data_len < room ? evt->data_len : room;
        if (take > 0) {
            memcpy(s_resp + s_resp_len, evt->data, take);
            s_resp_len += take;
            s_resp[s_resp_len] = '\0';
        }
    }
    return ESP_OK;
}

static void set_common(esp_http_client_handle_t h, bool with_auth)
{
    esp_http_client_set_header(h, "Accept", "application/json");
    if (with_auth) {
        static char auth[160];
        snprintf(auth, sizeof auth, "Bearer %s", CP_OPERATOR_TOKEN);
        esp_http_client_set_header(h, "Authorization", auth);
    }
}

static esp_err_t open_client(esp_http_client_handle_t *out, const char *url,
                             esp_http_client_method_t method)
{
    esp_http_client_config_t cfg = {
        .url = url,
        .method = method,
        .timeout_ms = HTTP_TIMEOUT_MS,
        .event_handler = on_http,
        // 本地 wrangler dev 是 HTTP，该回调只对 HTTPS 生效；生产环境用它验证书。
        .crt_bundle_attach = esp_crt_bundle_attach,
        .buffer_size = 1024,
    };
    s_resp_len = 0;
    s_resp[0] = '\0';
    *out = esp_http_client_init(&cfg);
    return *out ? ESP_OK : ESP_ERR_NO_MEM;
}

int obs_api_fetch_places(obs_place_t *out, int max)
{
    if (!out || max <= 0) return -1;
    char url[160];
    snprintf(url, sizeof url, "%s/api/v1/places", CP_API_BASE);

    esp_http_client_handle_t h;
    if (open_client(&h, url, HTTP_METHOD_GET) != ESP_OK) return -1;
    set_common(h, false);

    int count = -1;
    if (esp_http_client_perform(h) == ESP_OK &&
        esp_http_client_get_status_code(h) == 200) {
        cJSON *root = cJSON_Parse(s_resp);
        // 契约：{ "places": [ { "id", "name", "kind", ... } ] }（见 web-api-v0）。
        cJSON *arr = cJSON_GetObjectItem(root, "places");
        if (cJSON_IsArray(arr)) count = 0;
        cJSON *p;
        cJSON_ArrayForEach(p, arr) {
            if (count >= max) break;
            cJSON *id = cJSON_GetObjectItem(p, "id");
            cJSON *name = cJSON_GetObjectItem(p, "name");
            cJSON *kind = cJSON_GetObjectItem(p, "kind");
            if (!cJSON_IsString(id) || !cJSON_IsString(kind)) continue;
            snprintf(out[count].id, sizeof out[count].id, "%s", id->valuestring);
            snprintf(out[count].name, sizeof out[count].name, "%s",
                     cJSON_IsString(name) ? name->valuestring : id->valuestring);
            snprintf(out[count].kind, sizeof out[count].kind, "%s", kind->valuestring);
            count++;
        }
        if (root) cJSON_Delete(root);
    } else {
        ESP_LOGW(TAG, "拉取地点失败：HTTP %d", esp_http_client_get_status_code(h));
    }
    esp_http_client_cleanup(h);
    return count;
}

int obs_api_post_observation(const char *json_body)
{
    char url[160];
    snprintf(url, sizeof url, "%s/api/v1/observations", CP_API_BASE);

    esp_http_client_handle_t h;
    if (open_client(&h, url, HTTP_METHOD_POST) != ESP_OK) return 0;
    set_common(h, true);
    esp_http_client_set_header(h, "Content-Type", "application/json");
    esp_http_client_set_post_field(h, json_body, (int)strlen(json_body));

    int status = 0;
    if (esp_http_client_perform(h) == ESP_OK) {
        status = esp_http_client_get_status_code(h);
        ESP_LOGI(TAG, "POST observations -> %d", status);
        if (status >= 400) ESP_LOGW(TAG, "响应体：%s", s_resp);
    } else {
        ESP_LOGW(TAG, "POST 网络层失败");
    }
    esp_http_client_cleanup(h);
    return status;
}

int obs_api_delete_observation(const char *id)
{
    char url[200];
    snprintf(url, sizeof url, "%s/api/v1/observations/%s", CP_API_BASE, id);

    esp_http_client_handle_t h;
    if (open_client(&h, url, HTTP_METHOD_DELETE) != ESP_OK) return 0;
    set_common(h, true);

    int status = 0;
    if (esp_http_client_perform(h) == ESP_OK) {
        status = esp_http_client_get_status_code(h);
        ESP_LOGI(TAG, "DELETE observations/%s -> %d", id, status);
    }
    esp_http_client_cleanup(h);
    return status;
}
