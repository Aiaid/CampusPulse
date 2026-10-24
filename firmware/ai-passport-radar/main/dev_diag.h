// main/dev_diag.h —— 分类结果的诊断文本（串口日志用）。
//
// 单独一个模块的原因：它同时要用"手机判定"和"车证据位"两边的结论，
// 放在任何一边都会让那个模块反向依赖另一个。诊断输出本来就该在最上层。
#ifndef DEV_DIAG_H
#define DEV_DIAG_H

#include <stddef.h>

#include "ad_parse.h"

// 把一包广播的解析 + 分类结果格式化成一行（不含 MAC/RSSI，那些调用方自己拼）。
void dev_diag_describe(const scan_facts_t *f, char *buf, size_t len);

#endif  // DEV_DIAG_H
