// main/veh_rules.h —— 电动车判据（**唯一**的车判定入口）。
//
// 这里只有三件事：
//   1. 从广播里算"证据位"（EVID_*），供用户勾选/统计；
//   2. 排除表：办公设备品牌、Fast Pair 配件；
//   3. hard_ok()：把手机/外设/品牌/可连接这些硬条件合起来。
//
// 【为什么必须只有一个入口】
// 原来车判定有两套并行实现：scan_class_is_vehicle()（零调用点，判据还写反了）
// 和 scan_table.c 的 vehicle_hard_ok()。前者差点让人改错地方——改完屏幕上
// 一点变化都没有。现在两个旧函数都已删除，判定只在这里。
#ifndef VEH_RULES_H
#define VEH_RULES_H

#include <stdbool.h>
#include <stdint.h>

#include "ad_parse.h"

// ---------------------------------------------------------------------------
// 证据位
// ---------------------------------------------------------------------------
#define EVID_NONE                 0x00u
// A：私有 128 位 UUID。
// [historical session] 首次见到真实命中：`BYD BLE3`（比亚迪数字钥匙，AD = `01,07,09`，
// 即 Flags + 128 位 UUID 列表 + 完整名，RSSI -91）。之前车棚 242 台里 0 命中，
// 是因为车棚那批车走的是厂商数据（0xFF）而不是 128 位 UUID —— 两种做法都存在。
#define EVID_UUID128              0x01u
#define EVID_MANU_LONG            0x02u   // B：厂商数据 >= 8 字节（实测真车 0 命中）
// C：**已废弃，不再置位**。
//
// 原来这里写的是"Appearance 落在车辆段 0x0300~0x03FF"。查 SIG 的 Assigned Numbers
// 会发现**规范里根本没有"车辆"这个类别**，而 0x0300~0x03FF 这一段装的是：
//   Generic Thermometer 0x0300 / Heart Rate 0x0340 / Blood Pressure 0x0380 /
//   Generic HID 0x03C0~0x03FF（键盘 0x03C1、鼠标 0x03C2、**数字笔 0x03C7**…）
// 也就是说这条"证据"非但不指向车，反而把温度计、心率带、手写笔都认成了车。
// 实测印证：本实验室两台华为手写笔的 Appearance 就是 0x03C7。
//
// 现在改成反向用法：Appearance 落在这些**消费电子类别**里 -> 直接排除（见下）。
// 位值保留，避免 NVS 里旧 blob 的语义错位（scan_dev_t.evidence 是持久化的）。
#define EVID_APPEARANCE_VEHICLE   0x04u   // 已废弃（不复位；见上方说明）
#define EVID_LINK_SHORT           0x08u   // D：可连接 + 厂商数据 < 8 字节（**唯一有效**）

// 以下不是"证据"，是**排除标记**，共用 evidence 字节只为省一次签名改动。
// evidence_mask 永远不含它们，所以不参与"命中哪条证据"。
#define EVID_EXCL_FASTPAIR        0x40u   // Fast Pair（耳机/手表/追踪器）
#define EVID_EXCL_GADGET_SVC      0x80u   // 0x16 里的 UUID 属于已知的非车设备
#define EVID_ALL                  0x0Fu

// 厂商数据长度门槛：>= 这个值算"长"（手机/电脑），< 算"短"（车）。
#define SCAN_MANU_LONG_LEN 8

// 排除标记：Appearance 明确写着"我不是车"（手表/电脑/平板/HID/传感器）。
// 见 veh_rules_appearance_is_gadget() 里的分类表。
#define EVID_EXCL_APPEARANCE      0x10u

// 【v34】**正面证据**：广播里有"这台是车"的直接线索（车厂品牌名 / 车厂服务 UUID）。
//
// 为什么要有它——因为"排除法"这条路在原理上走不通：
//   * "不是车"是一个**无穷集合**（打印机、音箱、手表、电视、电饭锅…），
//     每见到一款新设备就得补一条规则，永远补不完（我们已经补了 6 轮）；
//   * "是车"是一个**有限集合**（车厂就那么几十家）。
// 所以判据从"默认是车、逐条排除"改成"**默认不是车、有正面证据才算**"。
//
// 代价必须说清楚：实测**只有 4%~11% 的设备会报名字**（18 份日志统计），
// 而车棚里绝大多数车是不报名字的。所以这个数字会从"上限"变成"下限"——
// 室内必然归零，车棚会明显小于实际台数。为了不丢信息，被排除在外的
// "像车但无正面证据"的设备另算一个数（MAYBE），单独显示。
#define EVID_POSITIVE             0x20u

// 电动车判定的在场门槛。
//
// 【为什么是 10 秒】原来 30 秒是给"站着不动数车"定的：车一直在广播，
// 攒 30 秒很容易。但实际用法是**拿着设备走一趟车棚**——一台车在范围内
// 只待 2~3 秒，横排往返两趟也就 6~10 秒。30 秒门槛等于"走路采集永远数不出车"。
//
// 副作用：判据切换后的 LOADING 也用这个常量，所以从 30 秒变成了 10 秒。
#define SCAN_VEHICLE_DWELL_MS 10000

// 从一包广播算证据位。
uint8_t veh_rules_evidence(const scan_facts_t *f);

// 厂商 ID 是不是办公设备品牌（打印机/复印机/扫描仪）。
bool veh_rules_manu_is_office(uint16_t manu_id);

// 广播名里有没有车厂品牌（yadea / aima / tailg / luyuan / zeeho / byd …）。
// 名单只放**实测见过**或确定只做车的品牌，见 veh_rules.c 里的说明。
bool veh_rules_name_is_vehicle(const char *name, uint8_t len);

// Appearance 是否属于**明确的消费电子类别**（手表/电脑/平板/HID/传感器）。
//
// 为什么这条特别有用：这些设备往往"可连接 + 没有厂商数据 + 没有名字"，
// 和电动车的广播形状**一模一样**。实测那 6 台里的
//   `[observed address omitted]`  Appearance = 0x00C2 = Smartwatch（小米手表/手环）
// 就是靠这一条区分出来的——名字、厂商、UUID 全都没有可用信息。
//
// 代价：真车如果也填了这些类别就会被误排除。实际上真车要么不填 Appearance，
// 要么填 0x0000（Unknown），填成"智能手表"的车不存在。
bool veh_rules_appearance_is_gadget(uint16_t appearance);

// 0x16 service data 里的 16 位 UUID 是否属于**已知的非车设备**。
//
// 为什么要这条：打印机这类设备是"有时发厂商 ID、有时不发"的。
// `[observed address omitted]` 在 [historical session] 那轮带 `manu=0x0065`（HP，被办公表
// 挡住），25 秒后的这一轮完全没发厂商数据，于是"可连接 + 短数据"直接命中。
// **同一台设备、同一间屋子，因为收到哪一包不同，结论就翻转。**
//
// 但它两轮都发了 `0x16 FDF7 ...`。拿 service UUID 当身份比拿厂商 ID 稳，
// 因为它在主广播包里（不依赖对端回 SCAN_RSP）。
bool veh_rules_svc16_is_gadget(uint16_t svc16);

// 硬条件（不含证据位、不含在场时长）：
//   非手机 + 非外设 + 非"可连接且有长厂商数据" + 非办公设备品牌 + 非 Fast Pair。
//
// 参数刻意用基本类型而不是 scan_entry_t：这一层不该知道"扫描表"长什么样，
// 否则模块之间会互相依赖，想单独测这条规则就得把整张表搬进来。
bool veh_rules_hard_ok(bool is_phone, bool is_peripheral, bool connectable,
                       uint8_t evidence, uint16_t manu_id);

#endif  // VEH_RULES_H
