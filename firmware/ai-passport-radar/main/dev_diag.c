// main/dev_diag.c —— 见 dev_diag.h。
#include "dev_diag.h"

#include <stdio.h>
#include <string.h>

#include "dev_phone.h"
#include "veh_rules.h"

// ---------------------------------------------------------------------------
// 一行诊断文本
// ---------------------------------------------------------------------------
//
// 这个函数原来叫 ad_describe() 放在解析层，但它要引用"手机厂商/证据位"
// 这类判定结果——等于让最底层反过来依赖上层。现在放在分类模块里，
// 解析层只负责"读出了什么"。
void dev_diag_describe(const scan_facts_t *f, char *buf, size_t len)
{
    if (!buf || len == 0) return;
    buf[0] = '\0';
    if (!f) return;

    char part[48];

    // 厂商数据：ID + 净长度，最有用的一条。
    if (f->has_manu) {
        snprintf(part, sizeof(part), "manu=0x%04X/%uB ", f->manu_id, f->manu_len);
        strncat(buf, part, len - strlen(buf) - 1);
    }
    if (f->has_appearance) {
        snprintf(part, sizeof(part), "appr=0x%04X ", f->appearance);
        strncat(buf, part, len - strlen(buf) - 1);
    }
    if (f->has_uuid128) {
        strncat(buf, "uuid128 ", len - strlen(buf) - 1);
    }
    if (f->uuid16_mask) {
        snprintf(part, sizeof(part), "uuid16=0x%02X ", f->uuid16_mask);
        strncat(buf, part, len - strlen(buf) - 1);
    }
    snprintf(part, sizeof(part), "kind=%s ev=0x%02X",
             dev_phone_advertiser_name(dev_phone_advertiser(f)),
             veh_rules_evidence(f));
    strncat(buf, part, len - strlen(buf) - 1);
}
