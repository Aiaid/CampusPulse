// main/dev_phone.h —— 手机 / 外设识别。
//
// 这一层只回答两个问题：
//   1. 这台设备像不像"人身上的手机"？   -> dev_phone_is_phone()
//   2. 它明显是外设（耳机/手表/键鼠）吗？ -> dev_phone_is_peripheral()
//
// 为什么单独一个模块：这段判定被**两个指标**共用——手机数要用它，
// 车判据也要用它（"是手机就不算车"）。它原来和车判据混在一个文件里，
// 结果改车的判据时要顺手理解手机的逻辑，改手机的逻辑又会悄悄改坏车数。
//
// 注意：BLE 广播里没有"我是手机"这个字段，厂商 ID 只说明**品牌**不说明**品类**
// （同一家既做手机也做耳机手表）。所以这里本质上是"品牌 + 名字关键词"的赌，
// 只能保证在封闭小空间里准（电梯实测 ±1），不要按"精确人数"去用。
#ifndef DEV_PHONE_H
#define DEV_PHONE_H

#include <stdbool.h>
#include <stdint.h>

#include "ad_parse.h"

// 广播者的身份猜测。只用于诊断行和统计，不参与判定。
typedef enum {
    ADV_KIND_UNKNOWN = 0,   // 没认出来
    ADV_KIND_APPLE   = 1,   // Apple 厂商数据（手机/Mac/耳机/手表都算）
    ADV_KIND_GOOGLE  = 2,   // Google 厂商数据
    ADV_KIND_SAMSUNG = 3,   // Samsung 厂商数据
    ADV_KIND_MICROSOFT = 4, // Microsoft（Windows / Surface 中继广播）
    ADV_KIND_NAMEPHONE = 5, // 广播名里明确是手机型号
    ADV_KIND_COUNT
} adv_kind_t;

// 厂商 ID 是否属于已知的手机品牌（见 ad_parse.h 里的 MANU_* 表）。
bool dev_phone_vendor(uint16_t manu_id);

// 这台设备像不像手机。内部顺序：Appearance -> 厂商 ID（排除配件名）-> 名字兜底。
bool dev_phone_is_phone(const scan_facts_t *f);

// 明显是外设（HID 外观 / HID 服务 / Fast Pair / 名字含 mouse、buds…）。
bool dev_phone_is_peripheral(const scan_facts_t *f);

// 身份猜测（只用于诊断）。
uint8_t dev_phone_advertiser(const scan_facts_t *f);
const char *dev_phone_advertiser_name(uint8_t kind);

// 手机数的"范围"门槛：只数这个信号强度以上的手机。
// 需求是"判断室内是否拥挤"，不是"数清周围所有人"；不加门槛时楼里的设备
// 穿透进来也会被算，晚上楼下没人也会显示十几个。
//
// [historical session] 实测标定（教学楼大厅，vivo X100）：室内衰减远超自由空间，
// -75 实际只对应 3~4 米（8 米处实测 -87）。放宽到 -80 ≈ 5 米量级，
// 语义="同一房间"（用户拍板，见实录 §5.46）。
#define SCAN_PHONE_RSSI_MAX (-80)


#endif  // DEV_PHONE_H
