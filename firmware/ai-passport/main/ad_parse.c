// main/ad_parse.c —— 见 ad_parse.h。
//
// 纯函数：不碰 NimBLE / LVGL / FreeRTOS，PC 上可直接编译测试。
#include "ad_parse.h"

#include <stdio.h>
#include <string.h>

// ---------------------------------------------------------------------------
// AD Type 常量（只列这里用得到的）
// ---------------------------------------------------------------------------
#define AD_TYPE_FLAGS        0x01
#define AD_TYPE_UUID16_MORE  0x02
#define AD_TYPE_UUID16_FULL  0x03
#define AD_TYPE_UUID128_MORE 0x06
#define AD_TYPE_UUID128_FULL 0x07
#define AD_TYPE_NAME_SHORT   0x08
#define AD_TYPE_NAME_FULL    0x09
#define AD_TYPE_APPEARANCE   0x19
#define AD_TYPE_SVC_DATA_16  0x16
#define AD_TYPE_SVC_DATA_32  0x20
#define AD_TYPE_SVC_DATA_128 0x21
#define AD_TYPE_MANUFACTURER 0xFF

// ---------------------------------------------------------------------------
// 各字段的解析
// ---------------------------------------------------------------------------

static void set_name(scan_facts_t *f, const uint8_t *p, uint8_t n)
{
    if (f->has_name) return;                 // 先到先得
    if (n > sizeof(f->name)) n = sizeof(f->name);
    memcpy(f->name, p, n);
    f->name_len = n;
    f->has_name = (n > 0);
}

static void parse_manufacturer(scan_facts_t *f, const uint8_t *p, uint8_t n)
{
    if (n < 2) return;
    f->has_manu = true;
    f->manu_id = (uint16_t)(p[0] | (p[1] << 8));
    // 自定义数据的净长度（去掉 2 字节厂商 ID），给证据 B 用。
    f->manu_len = (uint8_t)(n - 2);
    // Apple 的类型字节在厂商 ID 之后第一个字节。
    // 这里顺手存下来，避免上层再回头翻原始载荷（那要额外保存 29 字节/设备）。
    if (f->manu_id == MANU_APPLE && n >= 3) {
        f->apple_subtype = p[2];
    }
}

static void parse_uuid16(scan_facts_t *f, const uint8_t *p, uint8_t n)
{
    for (uint8_t i = 0; (uint8_t)(i + 2) <= n; i = (uint8_t)(i + 2)) {
        const uint16_t u = (uint16_t)(p[i] | (p[i + 1] << 8));
        switch (u) {
        case 0x1812: f->uuid16_mask |= FACTS_UUID16_HID;      break;
        case 0x1813: f->uuid16_mask |= FACTS_UUID16_HID_SVC;  break;
        case 0x180F: f->uuid16_mask |= FACTS_UUID16_BATT;     break;
        case 0x180A: f->uuid16_mask |= FACTS_UUID16_DIS;      break;
        case 0xFD92: f->uuid16_mask |= FACTS_UUID16_XIAOMI;   break;
        case 0xFEBE: f->uuid16_mask |= FACTS_UUID16_BOSE;      break;
        case 0xFE2C:   // Fast Pair
        case 0xFE26:   // Fast Pair 的配套服务（Device Action / Nearby）
            f->uuid16_mask |= FACTS_UUID16_FASTPAIR;
            break;
        default: break;
        }
    }
}

static void parse_appearance(scan_facts_t *f, const uint8_t *p, uint8_t n)
{
    if (n < 2) return;
    f->has_appearance = true;
    f->appearance = (uint16_t)((p[0] << 8) | p[1]);
}

void ad_parse(const uint8_t *data, uint8_t len, scan_facts_t *out)
{
    memset(out, 0, sizeof(*out));
    if (!data || len == 0) return;

    uint8_t i = 0;
    while (i < len) {
        const uint8_t field_len = data[i];
        // 0 是"结束标记"（历史遗留的空数据），也算非法：直接停。
        if (field_len == 0) break;
        // 长度字节之后才是 type，所以至少还要 1 字节。
        if ((uint16_t)i + 1u + field_len > len) break;

        const uint8_t type = data[i + 1];
        const uint8_t *p = &data[i + 2];
        const uint8_t n = (uint8_t)(field_len - 1);   // 去掉 type 字节

        if (type < 32) out->ad_type_mask |= (1UL << type);
        if (type == AD_TYPE_SVC_DATA_16 && n >= 2 && out->svc16 == 0) {
            out->svc16 = (uint16_t)(p[0] | (p[1] << 8));
        }

        switch (type) {
        case AD_TYPE_NAME_SHORT:
        case AD_TYPE_NAME_FULL:
            set_name(out, p, n);
            break;
        case AD_TYPE_APPEARANCE:
            parse_appearance(out, p, n);
            break;
        case AD_TYPE_MANUFACTURER:
            parse_manufacturer(out, p, n);
            break;
        case AD_TYPE_UUID16_MORE:
        case AD_TYPE_UUID16_FULL:
            parse_uuid16(out, p, n);
            break;
        case AD_TYPE_SVC_DATA_16:
            // 0x16 的载荷 = 2 字节 UUID（小端）+ 服务数据。这里只关心 UUID：
            // Fast Pair 的耳机/追踪器就是把 0xFE2C 写在这里的，而它们同样
            // "可连接 + 无厂商数据"，不排掉就会被算成电动车。
            if (n >= 2) parse_uuid16(out, p, 2);
            break;
        case AD_TYPE_UUID128_MORE:
        case AD_TYPE_UUID128_FULL:
            // 128 位 UUID 一个就占 16 字节，一个字段最多 2 个。
            // 只要出现就足够说明"这是私有协议"，具体内容不必解析。
            if (n >= 16) out->has_uuid128 = true;
            break;
        default:
            break;
        }

        i = (uint8_t)(i + 1u + field_len);
    }
}

