// obs_store.c —— 实现见 obs_store.h。本文件为本基线新写。
#include "obs_store.h"

#include "esp_log.h"
#include "nvs.h"

#include <stdio.h>
#include <string.h>

static const char *TAG = "obs_store";

#define NVS_NS "outbox"

// nvs_handle_t 在 IDF 5.x 是整数句柄（非指针），0 表示未打开。
static nvs_handle_t s_nvs;

// 每个槽位一个 key："s0".."s15"。槽位内容为 JSON blob。
// 删除即 nvs_erase_key；读取时按槽位序扫描，跳过空槽。
// 槽位复用策略：put 找第一个空槽。这保证 get 的 index 序 = 槽位序，
// 而槽位序近似等于入队序（先入队的占低槽位；出队造成的空洞被新记录
// 填补时顺序可能不再严格，但幂等重试不依赖严格顺序）。

static void slot_key(int slot, char out[4])
{
    snprintf(out, 4, "s%d", slot);
}

void obs_store_init(void)
{
    if (s_nvs) return;
    if (nvs_open(NVS_NS, NVS_READWRITE, &s_nvs) != ESP_OK) {
        ESP_LOGE(TAG, "NVS 命名空间打开失败；待提交队列不可用");
        s_nvs = 0;
    }
}

int obs_store_count(void)
{
    if (!s_nvs) return 0;
    int n = 0;
    char key[4];
    for (int i = 0; i < OBS_STORE_CAPACITY; i++) {
        slot_key(i, key);
        size_t len = 0;
        if (nvs_get_blob(s_nvs, key, NULL, &len) == ESP_OK && len > 0) n++;
    }
    return n;
}

bool obs_store_put(const char *json_body)
{
    if (!s_nvs || !json_body) return false;
    const size_t len = strlen(json_body) + 1;
    if (len > OBS_STORE_BLOB_MAX) {
        ESP_LOGE(TAG, "记录过大（%d 字节），拒绝入队", (int)len);
        return false;
    }
    char key[4];
    for (int i = 0; i < OBS_STORE_CAPACITY; i++) {
        slot_key(i, key);
        size_t old = 0;
        if (nvs_get_blob(s_nvs, key, NULL, &old) == ESP_OK) continue;  // 已占用
        if (nvs_set_blob(s_nvs, key, json_body, len) != ESP_OK) return false;
        if (nvs_commit(s_nvs) != ESP_OK) return false;
        ESP_LOGI(TAG, "已入队槽位 %d（%d 字节）", i, (int)len);
        return true;
    }
    ESP_LOGW(TAG, "队列已满（%d 条）", OBS_STORE_CAPACITY);
    return false;
}

bool obs_store_get(int index, char *buf, int len)
{
    if (!s_nvs || !buf || len <= 0 || index < 0) return false;
    char key[4];
    int seen = 0;
    for (int i = 0; i < OBS_STORE_CAPACITY; i++) {
        slot_key(i, key);
        size_t need = 0;
        if (nvs_get_blob(s_nvs, key, NULL, &need) != ESP_OK || need == 0) continue;
        if (seen++ != index) continue;
        if ((int)need > len) return false;
        return nvs_get_blob(s_nvs, key, buf, &need) == ESP_OK;
    }
    return false;
}

bool obs_store_remove(const char *id)
{
    if (!s_nvs || !id) return false;
    char key[4];
    char blob[OBS_STORE_BLOB_MAX];
    for (int i = 0; i < OBS_STORE_CAPACITY; i++) {
        slot_key(i, key);
        size_t need = sizeof blob;
        if (nvs_get_blob(s_nvs, key, blob, &need) != ESP_OK) continue;
        blob[sizeof blob - 1] = '\0';
        // JSON 里 id 定长 36 字符 UUID，用子串匹配即可，不必完整解析。
        if (!strstr(blob, id)) continue;
        if (nvs_erase_key(s_nvs, key) != ESP_OK) return false;
        nvs_commit(s_nvs);
        ESP_LOGI(TAG, "槽位 %d 已出队（id=%s）", i, id);
        return true;
    }
    return false;
}
