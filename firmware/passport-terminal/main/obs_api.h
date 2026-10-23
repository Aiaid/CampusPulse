// obs_api.h —— CampusPulse Workers API 客户端（docs/specs/web-api-v0.md）。
//
// 端点：GET /api/v1/places（公开）、POST /api/v1/observations（Bearer 认证）、
// DELETE /api/v1/observations/:id（Bearer 认证）。
// 服务器只在 Origin 头「存在且不匹配」时拒绝写入，本固件不发 Origin，合规。
//
// 调用前必须 net_link_ensure() 成功。所有函数都是阻塞的，
// 只在 obs 工作线程里调用。
#pragma once

#include <stdbool.h>

#define OBS_PLACE_MAX 8

typedef struct {
    char id[32];      // 如 "east-parking"
    char name[64];    // UTF-8 中文名（缺字由字体兜底画占位框）
    char kind[12];    // "activity" / "parking" / "elevator"
} obs_place_t;

// 拉取地点列表。返回地点数量（0..OBS_PLACE_MAX），负数为失败。
int obs_api_fetch_places(obs_place_t *out, int max);

// 提交观察记录（body 为完整 JSON 文本）。返回 HTTP 状态码：
// 201=新写入，200=同 ID 同体重试确认，409=同 ID 不同体冲突，0=网络层失败。
int obs_api_post_observation(const char *json_body);

// 撤销记录（幂等）。返回 HTTP 状态码，0=网络层失败。
int obs_api_delete_observation(const char *id);
