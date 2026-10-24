// main/veh_rules.c —— 见 veh_rules.h。
//
// 纯函数：不碰 NimBLE / LVGL / FreeRTOS。
#include "veh_rules.h"

#include <stddef.h>
#include <string.h>

#include "dev_phone.h"

// ---------------------------------------------------------------------------
// 证据位
// ---------------------------------------------------------------------------

uint8_t veh_rules_evidence(const scan_facts_t *f)
{
    uint8_t ev = 0;
    if (!f) return 0;

    // A. 私有 128 位 UUID —— 车厂自定义协议的最强标志。
    //    标准外设用 16 位 UUID（HID 0x1812、Battery 0x180F），不会带 128 位。
    if (f->has_uuid128) ev |= EVID_UUID128;

    // B. 厂商数据够长 —— 车机常发车架号/电量/里程。
    if (f->has_manu && f->manu_len >= SCAN_MANU_LONG_LEN) ev |= EVID_MANU_LONG;

    // C. 【已废弃】原来这里是"Appearance 落在车辆段"。
    //    查规范后发现 0x0300~0x03FF 根本不是车辆段（详见图头宏定义处的说明），
    //    所以这一位不再置位。Appearance 现在只用于**排除**（见下面）。

    // D. 可连接 + 厂商数据很短 —— 车棚实测的唯一有效判据（见 scan_class.h）。
    if (f->connectable && f->manu_len < SCAN_MANU_LONG_LEN) {
        ev |= EVID_LINK_SHORT;
    }

    // 排除标记（不是证据）：Fast Pair 一定是配件。
    if (f->uuid16_mask & FACTS_UUID16_FASTPAIR) {
        ev |= EVID_EXCL_FASTPAIR;
    }

    // 正面证据一：车厂品牌名。
    //
    // ⚠ 名字的覆盖率陷阱（2026-10-22 停车场实抓）：休眠的车发短 ADV
    // （len=13，不带名字），名字只在 SCAN_RSP 里，而休眠车应答率实测
    // ~0.2%~0.5%——站着看 5 分钟，大多数车永远拿不到名字。
    // 所以光靠名字的口径 = "醒着的车 + 运气好的车"。名字仍然是强证据，
    // 但它只是证据一，不是唯一证据。
    if (f->has_name && veh_rules_name_is_vehicle(f->name, f->name_len)) {
        ev |= EVID_POSITIVE;
    }

    // 正面证据二：厂商 ID 是已知的车规模组厂（不用等名字，短 ADV 里就有）。
    //
    // 实测依据（2026-10-22 停车场，同一位置 5 分钟）：
    //   0x0020（BandSpeed，台铃等车用的中控/防盗模组）：35 个不同 MAC，
    //          0 个被手机判据命中；前一天车棚的 TL_* 也全是它。
    //   0x1010：`EBIKE(xx:xx)` 系列通用电动车模组的 ID（4 个 MAC）。
    // 风险记录在案：这是"见过的都是车"的经验名单，和名字白名单同一性质，
    // 发现误伤时在下面注释里补反例。
    if (f->has_manu &&
        (f->manu_id == 0x0020u || f->manu_id == 0x1010u)) {
        ev |= EVID_POSITIVE;
    }

    // 排除标记：Appearance 明确是消费电子（手表/电脑/HID/传感器）。
    if (f->has_appearance && veh_rules_appearance_is_gadget(f->appearance)) {
        ev |= EVID_EXCL_APPEARANCE;
    }

    // 排除标记：UUID 属于已知的非车设备（打印机等）。
    //
    // **两条解析路径都要判**，因为它们不是同一件事：
    //   0x16 service data 里的 UUID  -> facts.svc16
    //   0x02/0x03 UUID 列表里的 UUID -> facts.uuid16_mask
    // 本轮实测漏掉的 `C4:60:0A:4E:3B:77` 正是后者（`03 03 92 FD`），
    // 只判 0x16 的话它照样被算成车。
    if ((f->svc16 != 0 && veh_rules_svc16_is_gadget(f->svc16)) ||
        (f->uuid16_mask & (FACTS_UUID16_XIAOMI | FACTS_UUID16_BOSE))) {
        ev |= EVID_EXCL_GADGET_SVC;
    }
    return ev;
}

bool veh_rules_manu_is_office(uint16_t manu_id)
{
    // 每一条都从 Bluetooth SIG 厂商 ID 全表里查出来的，没有一条凭记忆。
    static const uint16_t OFFICE[] = {
        0x0065,   // HP, Inc.
        0x011B,   // Hewlett Packard Enterprise
        0x0040,   // Seiko Epson
        0x0004,   // Toshiba
        0x018B,   // Konica Minolta
        0x01A9,   // Canon
        0x01F1,   // Zebra Technologies（标签/条码打印机，和得力那台同类）
        0x025D,   // Lexmark
        0x065F,   // Ricoh
        0x0755,   // Brother
        0x041E,   // Dell
        0x0381,   // Sharp
        0x02EA,   // Fujitsu
    };
    for (size_t i = 0; i < sizeof(OFFICE) / sizeof(OFFICE[0]); i++) {
        if (manu_id == OFFICE[i]) return true;
    }
    return false;
}

// ---------------------------------------------------------------------------
// 已知的非车设备：按 0x16 service UUID 识别
// ---------------------------------------------------------------------------
//
// 只有**实测确认过身份**的才往里加，每条都要能说出是哪台设备、哪天的日志。
// 车厂不会注册这些 member service，所以不会误杀真车；但也正因为是白名单式的，
// 它只解决"见过的"，不解决"没见过的"——这仍然是打地鼠，只是把地鼠钉在
// 一个比厂商 ID 更稳的字段上（service UUID 在主广播包里，不依赖 SCAN_RSP）。
typedef struct {
    uint16_t    svc;
    const char *what;
} gadget_svc_t;

static const gadget_svc_t GADGET_SVC[] = {
    // HP 打印机。两台独立设备都是 `Flags + 16 FDF7 <28字节>`：
    //   `5C:60:BA:2C:C2:07`（同一轮带 manu=0x0065，确认 HP）
    //   `F2:4E:A4:80:E5:DB`（上一轮 manu=0x0065；这一轮完全不发厂商数据，
    //    只靠这条才能挡住）
    { 0xFDF7, "HP 打印机" },
    // 小米系设备。`C4:60:0A:4E:3B:77` 与上一轮的 `C4:61:0A:4E:3B:77` 是同一台
    // （后缀相同，只是随机地址换了），那一轮带 manu=0x038F。
    // 这条设备把 0xFD92 放在 **UUID 列表**里而不是 service data 里，
    // 所以它由 facts.uuid16_mask 的 FACTS_UUID16_XIAOMI 位命中——
    // 表里这一行是给"别的设备用 0x16 发 FD92"准备的，两处都保留。
    { 0xFD92, "小米设备" },
    // Bose 音箱。`77:96:55:DC:6F:FC` 发 `Flags + UUID16 BEFE + 厂商数据`，
    // 名字 `LE-Bose Revolve II Sound` 只在偶尔的包里出现——名字没到的那几轮，
    // 它就是"可连接 + 短厂商数据 + 无名"，被算成车。
    // 按 UUID 判比按名字判稳（名字要靠 SCAN_RSP）。
    // 注：它报的厂商 ID 是 0x0601，而 SIG 表里 0x0601 是 Schrader Electronics
    // （胎压监测），不是 Bose —— 所以千万别拿 0x0601 当身份，会误伤。
    { 0xFEBE, "Bose 音箱" },
};

// ---------------------------------------------------------------------------
// 正面证据：车厂品牌名
// ---------------------------------------------------------------------------
//
// 这份名单是**准入表**，不是排除表——只有在榜上的才可能是车。
// 所以每一条都必须"只做车"，否则会把别的东西误判成车（那是这个方案唯一怕的错）。
//
// 实测见过的（都有日志可查）：
//   `LuYuan-Smart`   绿源电动车
//   `ZEEHO-22af44`   极核（春风动力旗下电摩）
//   `BYD BLE3`       比亚迪数字钥匙（AD = 01,07,09，带 128 位 UUID）
//
// 其余是同类车厂，按"只做两轮车"补的。
// **刻意没放 "micar"**：那个名字（`MiCarB4EA9E17BD`）到底是小米汽车、小米滑板车
// 还是某个米家设备，目前没有证据；猜错的方向是"把非车算成车"，正是要避免的。
static const char *const VEHICLE_BRANDS[] = {
    "yadea",     // 雅迪
    "aima",      // 爱玛
    "tailg",     // 台铃
    "luyuan",    // 绿源
    "zeeho",     // 极核
    "byd",       // 比亚迪
    "ninebot",   // 九号
    "segway",    // 赛格威
    "soco",      // 速珂
    "sunra",     // 新日
    "niu-",      // 小牛（带连字符：单独 "niu" 会命中 genius 之类）
    // ---- 2026-10-21 车棚实测补录（[STAT] 签名表，共 256 台 / 4814 包）----
    // "^" 开头 = 只匹配名字的【开头】（防子串误伤，见匹配函数）。
    "^yd",       // 雅迪 `YD57035623`：13 台成排。裸 "yd" 会命中 Cody 之类，锚定
    "^tl_",      // 台铃 `TL_BEUOZB_` / `TL_BGPSBEOZB_` / `TL_GPSJLXW_`：11 台成排。
                 // "tailg" 匹配不到 TL_ 开头，这是当天车数为 0 的主因之一
    "xiaodao",   // 小刀 `XiaoDao_D0D5`：3 台成排
    "lima",      // 立马 `LIMA-409701`：1 台
    "^niu",      // 小牛 `NIU Link D26A`：1 台。锚定版 "niu"（覆盖 NIU Link 与 NIU-）
    "smartbike", // 通用名 `Qgj-SmartBike`：1 台
    "bdb-pke",   // PKE 模块车 `bdb-PKE-7F4F`：两趟车棚都见（10-20 三台、10-21 两台）
    // ---- 2026-10-21 第二趟停车场补录（[STAT]，256 台 / 2834 包）----
    "^ebike",    // `EBIKE(24:BD)`：通用 E-BIKE 防盗器/中控广播，自描述
    "^zub",      // `ZUB_bjq_002006`：车棚实测出现，品牌码待现场确认（疑似钻豹）
    // 同趟见到但身份未确认、**暂不收录**：`Q_BASH_`、`GANA23268LHABHY6`、
    // `NGNyj6OBcUUTFs4I`——等现场目视核对后再说，宁可少算。
};

bool veh_rules_name_is_vehicle(const char *name, uint8_t len)
{
    if (!name || len == 0) return false;
    for (size_t i = 0; i < sizeof(VEHICLE_BRANDS) / sizeof(VEHICLE_BRANDS[0]); i++) {
        const char *k = VEHICLE_BRANDS[i];
        // "^" 前缀 = 锚定：只匹配名字开头（如 "^yd" 命中 `YD57035623`，
        // 但不会命中 `CodyWatch`）。
        const bool anchored = (k[0] == '^');
        if (anchored) k++;
        const size_t kl = strlen(k);
        if (kl > len) continue;
        const size_t last_off = anchored ? 0 : (size_t)(len - kl);
        for (size_t off = 0; off <= last_off; off++) {
            size_t j = 0;
            while (j < kl) {
                char a = name[off + j];
                char b = k[j];
                if (a >= 'A' && a <= 'Z') a = (char)(a - 'A' + 'a');
                if (b >= 'A' && b <= 'Z') b = (char)(b - 'A' + 'a');
                if (a != b) break;
                j++;
            }
            if (j == kl) return true;
        }
    }
    return false;
}

// ---------------------------------------------------------------------------
// Appearance：明确的消费电子类别
// ---------------------------------------------------------------------------
//
// 数值全部来自 SIG《Assigned Numbers》的 Appearance 表（2024-10 版），
// 不是猜的。分类 = 高 10 位，子类 = 低 6 位。
//
//   0x0080~0x008F  Generic Computer（含 0x0083 Laptop、0x0087 Tablet、
//                                  0x0086 Wearable computer）
//   0x00C0~0x00C2  Generic/Sports/Smart Watch
//   0x0300~0x03FF  Thermometer / Heart Rate / Blood Pressure / HID
//                  （0x03C7 Digital Pen、0x03C1 Keyboard、0x03C2 Mouse…）
//   0x0440~0x044F  Running/Walking Sensor
//   0x0480~0x048F  Cycling（码表、速度/踏频/功率传感器）
//   0x0540~0x057F  Generic Sensor（温湿度、门磁、烟感…）
//
// 注意 0x0040（Generic Phone）不在这里——手机由 dev_phone_is_phone() 处理，
// 而且"是手机"和"不是车"是两件不同的事，混在一起会掩盖判据。
bool veh_rules_appearance_is_gadget(uint16_t appearance)
{
    if (appearance >= 0x0080 && appearance <= 0x008F) return true;   // 电脑/平板
    if (appearance >= 0x00C0 && appearance <= 0x00C2) return true;   // 手表
    if (appearance >= 0x0300 && appearance <= 0x03FF) return true;   // 体温计/心率/血压/HID
    if (appearance >= 0x0440 && appearance <= 0x044F) return true;   // 运动传感器
    if (appearance >= 0x0480 && appearance <= 0x048F) return true;   // 骑行传感器
    if (appearance >= 0x0540 && appearance <= 0x057F) return true;   // 各类传感器
    return false;
}

bool veh_rules_svc16_is_gadget(uint16_t svc16)
{
    for (size_t i = 0; i < sizeof(GADGET_SVC) / sizeof(GADGET_SVC[0]); i++) {
        if (GADGET_SVC[i].svc == svc16) return true;
    }
    return false;
}

bool veh_rules_hard_ok(bool is_phone, bool is_peripheral, bool connectable,
                       uint8_t evidence, uint16_t manu_id)
{
    if (is_phone) return false;           // 手机永远不算车
    // 外设（鼠标/耳机/键盘）不算车——但有正面证据的豁免：
    // 台铃系 BandSpeed 模组的 SCAN_RSP 里带 HID(0x1812)+电量(0x180F)
    // 服务（手机靠近解锁/遥控用），会被 HID 规则误标成外设；
    // 而 peripheral 标记是黏性的，一次命中永久排除（2026-10-22 实抓：
    // 5 台持续在线的台铃因此全灭）。名字/模组白名单比 HID 规则可信。
    if (is_peripheral && !(evidence & EVID_POSITIVE)) return false;

    // 可连接本身**不是**排除理由：靠近解锁要求手机能连上车，真车全是可连接广播。
    // 只有"可连接 + 长厂商数据"才排除——长数据是手机/电脑的特征。
    //
    // 【2026-10-21 车棚实测修正】报了车厂品牌名（EVID_POSITIVE）的不适用这条：
    // 雅迪（YD57035623，mlen=23）和爱玛（AIMA-DE5EF7，mlen=24）就是
    // 可连接 + 长厂商数据——车机状态帧本来就长。名字白名单比长度可信，
    // 这条排除曾经把现场最大的两簇车（13+12 台）全部误杀。
    if (connectable && (evidence & EVID_MANU_LONG) &&
        !(evidence & EVID_POSITIVE)) return false;

    // 办公设备品牌不是车。实验室实测那 4 台"电动车"里 3 台是 HP。
    if (manu_id != 0 && veh_rules_manu_is_office(manu_id)) return false;

    // 消费电子品牌（Apple / Microsoft / 手机厂）不是车。
    // 为什么要单独一条：Apple 的 Continuity 长短包混发，**短包只有 4~7 字节**，
    // 整段日志可能一次长包都不发，于是"可连接 + 短数据"直接命中判据。
    if (manu_id != 0 &&
        (manu_id == 0x004Cu || manu_id == 0x0006u ||
         dev_phone_vendor(manu_id))) {
        return false;
    }

    // Fast Pair 配件（耳机/手表/追踪器/音箱）。
    if (evidence & EVID_EXCL_FASTPAIR) return false;

    // 已知非车设备的私有服务（打印机等），见 veh_rules_svc16_is_gadget。
    if (evidence & EVID_EXCL_GADGET_SVC) return false;

    // Appearance 自己写着"我是手表/电脑/HID/传感器"，见 veh_rules_appearance_is_gadget。
    if (evidence & EVID_EXCL_APPEARANCE) return false;
    return true;
}
