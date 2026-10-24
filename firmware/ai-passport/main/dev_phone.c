// main/dev_phone.c —— 见 dev_phone.h。
//
// 纯函数：不碰 NimBLE / LVGL / FreeRTOS。
#include "dev_phone.h"

#include <stddef.h>
#include <string.h>

// ---------------------------------------------------------------------------
// 厂商 ID 白名单
// ---------------------------------------------------------------------------
//
// 为什么需要这张表：BLE 广播里没有"我是手机"这个字段，只能从厂商 ID 反推。
// 但厂商 ID 只说明**品牌**，不说明**品类**——同一家既做手机，也做耳机、手表、
// 手环、路由、电视。所以这张表只是"可能是手机"的**候选集**，
// 真正的排除靠后面那道名字关键词（buds/watch/band/tws/pen…）。
//
// 这就是为什么"把所有厂商加进来"能提高召回、但永远不可能做到"精确数手机"：
// 手机不带名字，配件带名字 —— 只能靠这个不对称性去赌。
bool dev_phone_vendor(uint16_t id)
{
    switch (id) {
    case MANU_GOOGLE:
    case MANU_SAMSUNG:
    case MANU_VIVO_NEW:
    case MANU_VIVO_OLD:
    case MANU_HUAWEI:
    case MANU_HONOR:
    case MANU_XIAOMI:
    case MANU_OPPO:
    case MANU_ONEPLUS:   // OPPO 子品牌，但有自己的 ID
    case MANU_REALME:
    case MANU_MEIZU:
    case MANU_NUBIA:
    case MANU_LENOVO:
    case MANU_MOTOROLA:
        return true;
    default:
        return false;
    }
}

static bool apple_subtype_is_phone(uint8_t sub)
{
    switch (sub) {
    case APPLETYPE_HANDOFF:
    case APPLETYPE_NEARBY_INFO:
    case APPLETYPE_NEARBY_ACTION:
        return true;
    default:
        return false;
    }
}

// ---------------------------------------------------------------------------
// 设备名兜底
// ---------------------------------------------------------------------------

static bool name_contains_ci(const char *name, uint8_t len, const char *needle)
{
    const size_t nl = strlen(needle);
    if (nl == 0 || len < nl) return false;
    for (size_t i = 0; i + nl <= len; i++) {
        size_t j = 0;
        for (; j < nl; j++) {
            char a = name[i + j];
            char b = needle[j];
            if (a >= 'A' && a <= 'Z') a = (char)(a - 'A' + 'a');
            if (b >= 'A' && b <= 'Z') b = (char)(b - 'A' + 'a');
            if (a != b) break;
        }
        if (j == nl) return true;
    }
    return false;
}

static bool name_looks_like_peripheral(const scan_facts_t *f)
{
    if (!f->has_name) return false;
    static const char *const PERIPH[] = {
        "mouse", "keyboard", "kbd", "trackpad", "touchpad",
        "buds", "earbud", "airpod", "headphone", "headset", "speaker",
        "watch", "band", "pen", "stylus", "printer",
        // 耳机/音频品牌。实测漏网：`iKF-King Pro`（头戴耳机）被算成车。
        // 只加"只做音频/配件"的品牌词；**不加 sony**——索尼做手机，
        // 加了会把 Xperia 的设备名兜底也挡掉，那会伤到手机数。
        "ikf", "qcy", "edifier", "soundcore", "baseus", "jbl", "bose",
        // 得力：只做打印机/文具，不做车。实测 `DELI_M2024DWs_56D0ES`
        // 用 `Flags + 完整名` 广播，既没厂商数据也没 service data，
        // 除了名字没有任何可用特征。
        "deli",
        // Windows 默认机器名。实测在新实验室里，屏幕上的"4 台电动车"
        // 有 2 台就是 `DESKTOP-3T3N0S6` 和 `LAPTOP-CPJ18I7O`——
        // 它们发 `Flags + UUID16(0x180A) + 128位UUID`，可连接、无厂商数据、
        // 无 Appearance，和电动车的广播形状**完全一样**，唯一能认出来的就是名字。
        //
        // 带连字符是有意的：`desktop-` / `laptop-` 不会被别的产品名撞上
        // （单独一个 "pad" 就会命中 touchpad、Tabata 之类）。
        "desktop-", "laptop-",
        // "tws" 是必须的：vivo/OPPO/小米的真无线耳机名字里常写 "xxx TWS xx"，
        // 而这些名字**同时**含品牌词（vivo/oppo/xiaomi）——
        // 不在这里排掉，is_phone() 的厂商分支排了也会被名字兜底重新捞回来。
        // （同一个坑见 tests/scan_class_ref.py 里的 "Pixel Buds"）
        "tws",
    };
    for (size_t i = 0; i < sizeof(PERIPH) / sizeof(PERIPH[0]); i++) {
        if (name_contains_ci(f->name, f->name_len, PERIPH[i])) return true;
    }
    return false;
}

static bool name_looks_like_phone(const scan_facts_t *f)
{
    if (!f->has_name) return false;
    static const char *const KEYS[] = {
        "iphone", "galaxy", "pixel", "redmi", "huawei", "honor",
        "oneplus", "oppo", "vivo", "xiaomi", "mi ", "realme",
    };
    for (size_t i = 0; i < sizeof(KEYS) / sizeof(KEYS[0]); i++) {
        if (name_contains_ci(f->name, f->name_len, KEYS[i])) return true;
    }
    return false;
}

// ---------------------------------------------------------------------------
// 判定
// ---------------------------------------------------------------------------

bool dev_phone_is_phone(const scan_facts_t *f)
{
    if (!f) return false;

    // B. Appearance 明确写了"电话"——最强证据，先看它。
    if (f->has_appearance && f->appearance == APPEARANCE_GENERIC_PHONE) {
        return true;
    }

    if (f->has_manu) {
        // A. 已知手机厂商：Apple 之外的全部在 dev_phone_vendor() 里查表。
        //    这些厂商的 ID 同时被手机、平板、耳机、手表、手环、路由使用，
        //    所以只在**没有**携带常见配件特征名称时认作手机。
        //
        //    这里没有解析 Fast Pair 的 service data（对 C3 的 RAM 不划算），
        //    用名字做粗筛是刻意的折中：手机广播通常不带名字，配件通常带名字，
        //    这个不对称性就是唯一可用的判据。
        if (dev_phone_vendor(f->manu_id)) {
            // 这里**调 name_looks_like_peripheral()，不要自己列几个词**。
            //
            // 原来这里是手写的 buds/watch/band/tws 四个词，于是每个新配件
            // 都要在"外设表"和"这里"各加一次，漏一处就翻车：
            //   * vivo TWS 3e   -> 厂商分支排了，名字兜底又捞回来（v12 踩过）
            //   * 华为 M-Pencil -> 两边都没排，一支手写笔被算成一部手机（刚踩）
            // 现在只有一份定义（PERIPH[]），加词只需改一处。
            if (!name_looks_like_peripheral(f)) {
                return true;
            }
        }
        // C. Apple：必须看 Continuity 子类型，不能只看厂商 ID。
        //    这就是"严格"的落点：AirPods(0x01/0x07)、Watch(0x0A)、
        //    AirDrop(0x05) 都不算手机。
        if (f->manu_id == MANU_APPLE) {
            return apple_subtype_is_phone(f->apple_subtype);
        }
    }

    // D. 名字兜底。
    //
    // 关键：先排掉"名字里带外设特征"的，再匹配手机关键词。
    // 否则 "Pixel Buds" 会因为含 "pixel" 被判成手机——
    // 实测这条确实会翻车（tests/scan_class_ref.py 抓到过）。
    if (name_looks_like_phone(f) && !name_looks_like_peripheral(f)) {
        return true;
    }

    return false;
}

bool dev_phone_is_peripheral(const scan_facts_t *f)
{
    if (!f) return false;

    // HID 外观：键盘 / 鼠标 / 组合设备 / 摇杆 / 手柄。
    // 这是最硬的证据——规范里写明了这些就是人机输入设备。
    if (f->has_appearance &&
        f->appearance >= APPEARANCE_HID_MIN &&
        f->appearance <= APPEARANCE_HID_MAX) {
        return true;
    }

    // 广播里带 HID / HID over GATT 服务。
    if (f->uuid16_mask & (FACTS_UUID16_HID | FACTS_UUID16_HID_SVC)) return true;

    // Fast Pair：耳机、音箱、手写笔配件。
    if (f->uuid16_mask & FACTS_UUID16_FASTPAIR) return true;

    // 名字兜底：能认出来就别猜了。
    if (name_looks_like_peripheral(f)) return true;
    return false;
}

// ---------------------------------------------------------------------------
// 身份猜测（只用于解释，不参与判定）
// ---------------------------------------------------------------------------

static const char *const KIND_NAMES[ADV_KIND_COUNT] = {
    "unknown", "apple", "google", "samsung", "microsoft", "namephone",
};

const char *dev_phone_advertiser_name(uint8_t kind)
{
    return (kind < ADV_KIND_COUNT) ? KIND_NAMES[kind] : "?";
}

uint8_t dev_phone_advertiser(const scan_facts_t *f)
{
    if (!f) return ADV_KIND_UNKNOWN;

    if (f->has_manu) {
        switch (f->manu_id) {
        case MANU_APPLE:   return ADV_KIND_APPLE;
        case MANU_GOOGLE:  return ADV_KIND_GOOGLE;
        case MANU_SAMSUNG: return ADV_KIND_SAMSUNG;
        case 0x0006:       return ADV_KIND_MICROSOFT;   // Microsoft
        default: break;
        }
    }

    if (f->has_name && name_looks_like_phone(f) && !name_looks_like_peripheral(f)) {
        return ADV_KIND_NAMEPHONE;
    }
    return ADV_KIND_UNKNOWN;
}

