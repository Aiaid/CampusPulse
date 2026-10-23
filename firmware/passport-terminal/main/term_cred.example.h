// term_cred.example.h —— 凭据模板。复制为 term_cred_local.h 后填真实值：
//   Copy-Item main/term_cred.example.h main/term_cred_local.h
// term_cred_local.h 已被 gitignore，真实凭据绝不进仓库、不进日志。
#pragma once

// 2.4GHz Wi-Fi（ESP32-C3 不支持 5GHz）
#define WIFI_SSID "your-ssid"
#define WIFI_PASS "your-password"

// CampusPulse Workers API 根地址，不带尾部斜杠。
// 本地联调指向 wrangler dev 的局域网地址，如 "http://192.168.1.10:8787"；
// 生产环境用 HTTPS 地址，如 "https://campuspulse.<account>.workers.dev"。
#define CP_API_BASE "http://192.168.1.10:8787"

// 操作员令牌：与 Worker 的 OPERATOR_TOKEN 密钥一致（wrangler secret 或
// 本地 .dev.vars）。浏览器与墨水屏不持有该密钥，只有本记录终端持有。
#define CP_OPERATOR_TOKEN "paste-operator-token-here"
