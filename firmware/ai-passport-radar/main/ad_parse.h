// main/ad_parse.h —— 广播载荷解析（**全工程唯一的 AD 遍历入口**）。
//
// 拆出来的原因：这段逻辑原来散在四个地方——
//   scan_class.c 的 ad_parse()
//   scan_ble.c   的 extract_name() / extract_manu_id() / extract_ad_profile()
// 四份遍历各自处理边界，任何一份写错都不会报错，只会"偶尔少个字段"。
// 现在只有 ad_parse() 一份，其余模块一律读 scan_facts_t。
//
// 这一层只回答"广播里写了什么"，不做任何判定。
#ifndef AD_PARSE_H
#define AD_PARSE_H

#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>

// ---------------------------------------------------------------------------
// 厂商 ID
// ---------------------------------------------------------------------------
//
// ⚠ 每一个值都必须查 Bluetooth SIG 的厂商 ID 列表再填，不能凭记忆。
// 真实翻车案例：本以为 0x0157 是小米，一查是 Anhui Huami（华米手表）；
// 小米是 0x038F。填错的结果是"手表全算成人、手机一个数不到"，而且不会报错。
#define MANU_MOTOROLA 0x0008
#define MANU_APPLE    0x004C
#define MANU_SAMSUNG  0x0075
#define MANU_GOOGLE   0x00E0
#define MANU_LENOVO   0x02C5
#define MANU_HUAWEI   0x027D
#define MANU_XIAOMI   0x038F
#define MANU_MEIZU    0x03AB
#define MANU_ONEPLUS  0x072F
#define MANU_OPPO     0x079A
// vivo：0x0837 是 SIG 新分配的，0x8486 是社区逆向文档里的旧标记。
#define MANU_VIVO_NEW 0x0837
#define MANU_VIVO_OLD 0x8486
#define MANU_REALME   0x08A4
#define MANU_NUBIA    0x08CA
#define MANU_HONOR    0x09C6

// Apple Continuity 的子类型（厂商数据第 3 字节）
#define APPLETYPE_HANDOFF       0x0C
#define APPLETYPE_NEARBY_INFO   0x0F
#define APPLETYPE_NEARBY_ACTION 0x10

// ---------------------------------------------------------------------------
// GAP Appearance
// ---------------------------------------------------------------------------
#define APPEARANCE_GENERIC_PHONE 0x0040
#define APPEARANCE_HID_MIN      0x03C0
#define APPEARANCE_HID_MAX      0x03C4

// 16 位 UUID 位图（只记这里用得到的几个）
#define FACTS_UUID16_HID        (1u << 0)   // 0x1812 HID
#define FACTS_UUID16_HID_SVC    (1u << 1)   // 0x1813 HID over GATT
#define FACTS_UUID16_BATT       (1u << 2)   // 0x180F Battery
#define FACTS_UUID16_DIS        (1u << 3)   // 0x180A Device Information
#define FACTS_UUID16_FASTPAIR   (1u << 4)   // 0xFE2C/0xFE26 Fast Pair（耳机/手表/追踪器）
// 0xFD92：小米系设备的私有 16 位服务（实测 `[observed address omitted]`）。
// 注意它出现在 **UUID 列表（0x02/0x03）** 里，不在 service data（0x16）里——
// 这两种位置是两条不同的解析路径，只判 0x16 会漏掉它（本轮就漏了）。
#define FACTS_UUID16_XIAOMI     (1u << 5)   // 0xFD92（实测小米系）
// 0xFEBE：实测 Bose 音箱的私有服务（`LE-Bose Revolve II Sound`）。
// 同样出现在 UUID 列表（0x02/0x03）里，不是 service data。
#define FACTS_UUID16_BOSE       (1u << 6)   // 0xFEBE（实测 Bose 音箱）

// 一次解析的结果。字段全是"从广播里读到的"，没有判定结论。
typedef struct {
    bool has_manu;          // 有厂商自定义数据（AD Type 0xFF）
    uint16_t manu_id;       // 厂商 ID，规范小端：Apple 读出来是 0x004C
    uint8_t apple_subtype;  // Apple 厂商数据的类型字节（manu_id==Apple 时有效，0 = 无）
    uint8_t manu_len;       // 厂商自定义数据的长度（不含厂商 ID 2 字节）
    bool has_appearance;    // 有 GAP Appearance（AD Type 0x19）
    uint16_t appearance;    // Appearance 值，小端编码：Generic Phone = 0x0040
    uint16_t uuid16_mask;   // 出现过的 16 位 UUID（按位或，只记常用的几个，见 UUID16_*）
    bool has_uuid128;       // 有 128 位 UUID（AD Type 0x06/0x07）—— 私有协议的最强标志
    bool has_name;
    // 名字缓冲。取 24 是因为现场实测里最长的一类是
    // `[observed name omitted]`（20 字节）——重构前 sniff 日志打的是原始
    // 载荷里的完整名字，重构后改打这个缓冲，16 就不够了（日志会截断，
    // 虽然扫描表本身只存 16 字节，SCAN_NAME_MAX 没变）。
    char name[24];          // 不含 '\0'
    uint8_t name_len;
    bool connectable;       // 广播类型是"可连接"（ADV_IND / ADV_DIRECT_IND）
    bool scannable;         // 广播类型"可扫描"（ADV_SCAN_IND）

    // ---- AD 结构画像（诊断用）----
    // 哪些 AD Type 出现过（bit n = Type n，只记 0..31），以及第一个 0x16 的 UUID。
    // 用途：判断"这台像车的设备"和"真车"的广播结构差在哪。
    // 实测那 4 台假车分别是 `01,09`（得力打印机）和 `01,16/FDF7`（HP）。
    uint32_t ad_type_mask;
    uint16_t svc16;
} scan_facts_t;

// 解析一包广播。out 会被整体清零后再填，可重复使用同一个变量。
void ad_parse(const uint8_t *data, uint8_t len, scan_facts_t *out);

#endif  // AD_PARSE_H
