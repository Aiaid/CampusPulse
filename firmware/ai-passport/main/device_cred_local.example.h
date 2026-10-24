// device_cred_local.example.h —— 本地设备身份/凭据的模板。
//
// 用法：把本文件【复制】为 device_cred_local.h 并填入真实值。
// device_cred_local.h 已在 .gitignore 里——凭据写死在设备里可以，
// 但不该跟着仓库走（同 wifi_cred_local.h 的规矩）。
#pragma once

// 服务端 device_nodes 表里登记的节点 ID（拼 batch_id 用）。
#define DEVICE_NODE_ID "node-001"

// 服务端签发的设备凭据（上传器 POST 时的 Bearer token；服务端用它的
// SHA-256 查 device_nodes 认证）。
//
// 默认留空是有意的：上传器以"空串 = 未配置"休眠。如果占位符写成非空
// 中文，直接复制不改就会拿着那句中文去 POST、永远 401 重试
// （2026-10-23 联调时发现的坑）。
#define DEVICE_CREDENTIAL ""
