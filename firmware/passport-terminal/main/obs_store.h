// obs_store.h —— NVS 待提交队列（离线兜底）。
//
// 断网 / 服务器不可达时，未提交的观察记录先存进 NVS（24KB 分区，16 个槽位，
// 每槽 ≤OBS_STORE_BLOB_MAX 字节的 JSON 文本），联网后由 obs 工作线程自动重试。
// 记录自带 UUIDv4，服务器按 ID 幂等去重（重复提交返回 200），
// 所以重试不会产生重复记录。
//
// NVS 自带磨损均衡；每条记录只在「提交失败入队 / 提交成功出队」时各写一次，
// 写入频率远低于闪存寿命量级。
#pragma once

#include <stdbool.h>

#define OBS_STORE_CAPACITY  16
#define OBS_STORE_BLOB_MAX  512

// 打开 NVS 命名空间（幂等）。调用前需 nvs_flash_init() 已成功。
void obs_store_init(void);

// 待提交条数。
int obs_store_count(void);

// 入队一份 JSON 记录。队列满返回 false（界面应提示用户并保留界面上的数据）。
bool obs_store_put(const char *json_body);

// 按入队顺序读第 index 条（0 最早）。无此条返回 false。
bool obs_store_get(int index, char *buf, int len);

// 按记录里的 "id" 字段移除一条。无此条返回 false。
bool obs_store_remove(const char *id);
