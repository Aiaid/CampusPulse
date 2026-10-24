// main/scan_table.h —— BLE 周边设备去重表的纯逻辑实现。
//
// 为什么单独抽一个文件：ESP32-C3 没有 PSRAM，扫描回调运行在 NimBLE host 任务里，
// 必须做到"零动态分配、查表不阻塞"。把这段逻辑与 NimBLE/LVGL 解耦后，
// 就能在 PC 上跑单元测试（tests/），不用每次刷机验证边界。
//
// 设计要点（v2）：
//   1. 地址去重只是【第一层】。指纹去重才是主力——很多设备的随机地址会变，
//      MAC 变了不等于设备变了。
//   2. 计数口径默认是"活跃设备数"（活跃窗口），而不是"在场设备数"（10 秒窗口）。
//      原因见 SCAN_ACTIVE_WINDOW_MS 的注释。
//   3. 本模块不认识"电动车"。它只维护一张"BLE 设备表"，车是不是车由调用方判断。
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// 表容量。
//
// 【实测教训】原来是 128，直接导致了屏幕数字的大幅波动，原因很硬：
//
//   现场 60 秒内出现 242 台不同 MAC（教室，265 包/秒），
//   而 5 秒窗口内同时在场的约 190 台 —— 128 个槽根本装不下。
//   于是每来一台新设备，就要淘汰一台"最久未更新"的。
//   实测那段 60 秒里发生了 2275 次淘汰（约 38 次/秒），
//   而被淘汰的设备往往只是 3~4 秒没发包（完全正常），
//   下一包来了再插回去 —— 屏幕数字就这样一秒抖好几次。
//   表现是 LIVE 被死死钉在 128（容量上限），手机数在 86~96 之间跳。
//
//   现在 384：实测同一段日志里淘汰次数归零，LIVE 从"钉在 128"
//   变成真实值 189（5 秒口径）/ 210（10 秒口径）。
//
// 内存：每项 68 字节（不是旧注释写的 24 字节，那个数字早就过时了），
// 384 项 = 26 KB。C3 没有 PSRAM，但 400KB SRAM 里这是可接受的代价——
// 用 26KB 换掉每秒 38 次的无谓淘汰，很划算。
//
// 超容量后仍然是淘汰"最久未更新"的（近似 LRU），而不是丢弃新设备：
// 新出现的东西通常才是用户想看的。
#define SCAN_TABLE_CAPACITY 384

// 身份键长度：BLE 地址 6 字节（大端，见 scan_table_make_key）。
#define SCAN_KEY_LEN 6

// 匿名广播（地址全 0）用 0xA0 打头合成键。BLE 地址的高两字节是公司 ID，
// 不会取到 0xA0xx 这种组合，所以打这个标记不会和真实地址冲突。
#define SCAN_KEY_ANON_TAG 0xA0

// 【在场】窗口：连续多久没再出现，就判定这台设备离开了范围。
//
// 【实测教训】原来是 5 秒，依据是"正常设备 2 秒内一定发一包"。
// 现场抓了 60 秒日志（教室，265 包/秒，242 台设备）之后这个依据被推翻了：
//
//   设备级广播间隔（只看 >=3 包的 230 台）
//     P50 = 2002ms   P75 = 3010ms   P90 = 4011ms   max = 19448ms
//     间隔 > 5 秒的：11 台（5%）
//     间隔 > 3 秒的：62 台（27%）
//
// 也就是说 P90 那批设备间隔 4 秒，**只要丢一个包就超过 5 秒**，
// 于是它们周期性掉出窗口、再被下一包拉回来。这就是手机数
// 在 86~96 之间跳（峰峰 10）的主要来源，与表容量无关——
// 模拟里把容量加到 384 之后淘汰归零，这个 10 依然存在；
// 只有把窗口拉到 10 秒才降到 7。
//
// 10 秒的代价：离场判定慢 5 秒、表里同时存活的条目更多（所以容量也一起加了）。
// 换来的是覆盖 P95 左右的实际广播间隔，不再把"慵懒但一直在"的设备
// 当成"刚走又回来"。
//
// 【[historical session] 实验】用户主场景是车棚（设备密度远低于教室 265 包/秒），
// 觉得 10 秒出场延迟太慢，试 8000：出场 ~9 秒。若密集场景数字开始抖，
// 调回 10000；若 8000 也稳，可再试 7000。改的就是这一行。
//
// 【[historical session] 自适应】这个常量现在是【最长档】。计数/显示路径走
// scan_table.c 的 live_window_ms()：在场 <=9 台时自动切 3 秒短窗
// （波动天然小，换出场速度），>=15 台回 8 秒（滞回防抖）。
// prune / dwell 重置等"销毁性"路径仍固定用这里的最长档。
#define SCAN_LIVE_WINDOW_MS 8000

// dwell 重置的断档阈值：设备沉默超过这个时长，"在场多久"才重新累计。
// 必须明显大于在场窗口（8s）：WiFi 对时每 3 分钟让 BLE 断粮 ~3-5s，
// 叠加车自身 ~4s 的广播周期，断档会超过 8s——若用 SCAN_LIVE_WINDOW_MS
// 当阈值，每次对时都把 dwell 清零，车永远攒不够 10s，
// 界面"等待 10s"每 3 分钟循环一次（[historical session] 实测）。
#define SCAN_DWELL_GAP_MS 20000

// 【已废弃】电动车 RSSI 半径门槛（原 SCAN_VEHICLE_RSSI_MIN = -70）。
//
// [historical session] 停车场实测把它证伪了：车的 BLE Beacon 发射功率极低，
// 2~3 米点空白距离读数就是 -78~-96（最强包 -63~-80），同一距离不同车
// 能差 30dB——比"10 米和 30 米的信号差"还大。任何阈值都圈不出稳定的
// 半径，-70 的实际效果是"几乎全拦死"（42 台真车只算上 1 台）。
// 判据反转后白名单已经是足够强的过滤器，半径闸的收益抵不上误杀。
// 手机的范围门槛（SCAN_PHONE_RSSI_MAX=-80）不受此影响：手机发射功率正常。

// 指纹合并的有效期，故意比在场窗口短。
//
// 为什么单独拎出来：合并的判据是"新地址 + 同载荷指纹 + 时间接近"，
// 窗口越长越容易把**两台同型号设备**（同一个 fp）误合并成一台。
// 而合并真正要解决的场景——同一台设备刚换了随机地址——间隔只有几秒。
// 所以在场窗口可以放宽到 10 秒，合并窗口仍然保守地留在 5 秒。
#define SCAN_FP_MERGE_WINDOW_MS 5000

// ---------------------------------------------------------------------------
// 进入 / 退出 状态机（滞回 + RSSI 中位数）
// ---------------------------------------------------------------------------
//
// ⚠ 默认关闭（SCAN_GATE_ENABLE = 0）。原因见下面「实测教训」。
//
// 为什么不能只看"最近一次出现"：弱信号设备的包是断续的，只看最后一次，
// 它会随着一包进来、又随着漏一包出去，屏幕数字大幅抖动。
//
// 三个设计要点：
//
// 1) 【滞回】进入和退出用不同的 RSSI 门槛（-85 / -90）。
//    如果两边同一个阈值，一台停在 -87 dBm 左右的设备会在线两侧来回翻。
//
// 2) 【中位数】判 RSSI 用最近 5 次的中位数，不用瞬时值，单包异常不影响结论。
//
// 3) 【双条件退出】"连续若干秒没收到" 或 "中位数跌破退出阈值" 才移除。
//
// 状态机用一个 8 位位图：bit0 = 本秒是否收到，bit1 = 上一秒……
//   窗口内命中几次  = popcount(bits & 0x1F)
//   连续 4 秒没收到 = (bits & 0x0F) == 0
//
// ---- 实测教训（[historical session] 晚，务必先读）----
//
// 这套参数在真实数据面前是错的：
//   * 120 台设备的 RSSI 中位数，中位数是 **-86.2**；**51% 低于 -85**。
//     也就是说进入门槛一开就挡住一半人。
//   * "5 秒内命中 3 个不同秒"要求设备至少 2 秒一包。而不少安卓机 3~5 秒才发一包，
//     5 秒窗口里最多采到 1~2 个秒，**永远进不去**。
//
// 结果：车站/宿舍这种人少、信号弱的场景，屏幕上直接是 0。
// 所以默认回到"5 秒窗口 + 只看最后一次"的老行为，先把"能数到"保住。
// 要重新启用，先把 SCAN_GATE_RSSI_ENTER 放到 -95 以下、ENTER_HITS 降到 2，
// 并且**必须先在现场抓 LOG ON 看真实的 RSSI 分布**再定值。
#define SCAN_GATE_ENABLE          0
#define SCAN_GATE_SAMPLE_MS      1000   // 采样节拍：每秒一格
#define SCAN_GATE_WINDOW_S       5      // 进入判定的时间窗（秒），必须 <= 8
#define SCAN_GATE_ENTER_HITS     2      // 窗口内至少这么多秒收到过 -> 进入
#define SCAN_GATE_EXIT_MISS_S    4      // 连续这么多秒没收到 -> 退出
#define SCAN_GATE_RSSI_ENTER   (-95)    // 进入所需的最低 RSSI 中位数（原来 -85 太严）
#define SCAN_GATE_RSSI_EXIT    (-100)   // 跌破这个值就退出（滞回）
#define SCAN_TTL_MS            10000    // 兜底：这么久完全没更新，直接过期
#define SCAN_RSSI_HIST_LEN         5    // 中位数窗口长度（奇数）

// prune 用的过期窗口。
//
// 状态机开着时必须用 TTL（10 秒）——条目要活够时间，退出判定才跑得完；
// 用 5 秒清掉的话，条目会在判退出之前消失，滞回等于没生效。
// 状态机关着时用 5 秒，和"在场"口径一致，也少占表容量。
#define SCAN_PRUNE_WINDOW_MS \
    (SCAN_GATE_ENABLE ? SCAN_TTL_MS : SCAN_LIVE_WINDOW_MS)

// 【短窗】窗口：比在场窗口更严格，用于"刚刚还很活跃"的判断。
// 给上层做瞬时变化检测（比如"这一秒突然多了 3 台"）时用，比 5 秒更灵敏。
#define SCAN_SHORT_WINDOW_MS 2000

// 【活跃】窗口：较宽口径，专供**唤醒判定**使用。
//
// 为什么唤醒要用宽窗口：唤醒看的是"人数规模的变化趋势"，不是"某台设备在不在"。
// 待机时收音机是断续开的（比如每 2 秒听 200ms），某台设备恰好落在一个空档里
// 没被听到——用 5 秒窗口会把它误判为离场，环境数忽高忽低，唤醒逻辑就误触发。
// 15 秒的宽窗口把这个抖动吸收掉，同时环境本身（有没有人、多少人）的变化尺度
// 是分钟级的，15 秒的迟滞对它毫无影响。
#define SCAN_ACTIVE_WINDOW_MS 15000

// 广播里带的可读名（AD Type 0x08 完整名 / 0x09 缩短名）最长留这么多。
// 真实设备名很少超过这个长度；截断比不做上限安全。
#define SCAN_NAME_MAX 16

// 指纹：广播载荷的 32 位哈希。用途是把"换了地址但广播内容一模一样"的设备认成一台。
// 载荷超过这个长度就不算指纹了——太长的载荷多半是动态厂商数据，不稳定。
#define SCAN_FP_MAX_LEN 31

// 指纹撞车判定：同一指纹、两份不同 MAC、RSSI 相差不超过这个值就合并。
// 合并只在 SCAN_LIVE_WINDOW_MS 内有效——设备离开 5 秒以上再回来，算新的一次。
// 两个真实设备在同一个房间里信号强度几乎不可能差 3dB 以内，
// 而同一台设备的随机地址切换时 RSSI 基本不变。
#define SCAN_FP_MERGE_RSSI_DB 6

typedef struct {
    uint8_t key[SCAN_KEY_LEN];   // 身份键（已按统一字节序排好）
    bool key_is_anon;            // key 是合成的（匿名广播），不参与任何地址类判断
    int8_t rssi;                 // 最近一次信号强度，dBm
    uint8_t rssi_peak;           // 最强一次（存 |rssi|），用于排序"最近的设备"
    bool used;
    bool has_name;                        // 收到过可读名
    uint8_t name_len;
    char name[SCAN_NAME_MAX];             // 不含 '\0'，用 name_len 截取
    uint16_t fp;                          // 最近一次载荷指纹（0 = 无）
    uint8_t manu_id[2];                   // 厂商 ID（小端原样；0 有效表示没有）
    uint32_t last_seen_ms;                // 最近一次出现的时刻（单调时钟，毫秒）
    uint32_t first_seen_ms;               // 本段【连续】观测的起点，被 prune 判死就重置

    // ---- 分类（见 scan_class.h）----
    uint8_t cls;                 // scan_class_t：0=未分类 1=手机 2=电动车
    bool cls_decided;            // 是否已做过"是不是手机"的判定（判定一次就缓存）
    bool connectable;            // 最近一次观测的广播是否可连接
    uint32_t dwell_ms;           // 累计在场时长（跨过短暂断档）
    uint32_t dwell_base_ms;      // 本段在场起点；断档超过 SCAN_DWELL_GAP_MS 则重置

    // ---- 进入/退出状态机（见 SCAN_GATE_*）----
    int8_t rssi_hist[SCAN_RSSI_HIST_LEN];  // 最近几次 RSSI，算中位数
    uint8_t rssi_hist_len;                 // 已填数量（<= SCAN_RSSI_HIST_LEN）
    uint8_t rssi_hist_pos;                 // 环形写指针
    uint8_t gate_bits;                     // bit0=本秒是否收到，bit1=上一秒……
    uint32_t gate_last_ms;                 // 位图的相位基准（每次前进整秒）
    bool counted;                          // 是否已进入"计入选场"状态
    uint8_t evidence;            // 这台设备命中的证据位（EVID_*，见 scan_class.h）
    bool peripheral;             // 明显是外设（HID/鼠标/耳机），永远不算车
    uint8_t advertiser;          // 未知广播者的身份猜测（ADV_KIND_*，见 scan_class.h）
} scan_entry_t;

typedef struct {
    scan_entry_t entries[SCAN_TABLE_CAPACITY];
    uint32_t total_seen;    // 累计发现过的"设备段"：一段连续观测算一个。
                            // 注意它会随时间窗口变化——同一台长时间离开再回来的设备
                            // 会被记成两段。作为"累计不同设备数"只能当量级参考。
    uint32_t last_prune_ms;
} scan_table_t;

// ---------------------------------------------------------------------------
// 身份键
// ---------------------------------------------------------------------------

// 把 6 字节地址规范化成身份键。
//
// NimBLE 的 addr.val 是【小端】（val[0] 是打印地址的最后一个字节），而
// ble_gap_adv_addr_type_to_str 之类的辅助函数又按大端处理，很容易搞反。
// 这里统一转成大端，同时把"同一物理地址的不同地址类型"归一：
// 顺序版本（public）和 RPA（random）的区分保留，因为它们本来就是不同身份。
//
// 为什么必须在这里处理：地址字节序搞反不会报错，只会让日志里显示的 MAC
// 和系统设置里看到的对不上——这种 bug 在真机上极难发现。
void scan_table_make_key(const uint8_t addr_val_le[6], uint8_t addr_type,
                         uint8_t out[SCAN_KEY_LEN]);

// 合成匿名广播的键。seed 随便给个自增值即可，只要同一时刻不同设备不撞。
void scan_table_make_anon_key(uint32_t seed, uint8_t event_type,
                              uint8_t out[SCAN_KEY_LEN]);

// 计算广播载荷指纹。len 超过 SCAN_FP_MAX_LEN 返回 0（不参与指纹合并）。
uint16_t scan_table_fingerprint(const uint8_t *data, uint8_t len);

// ---------------------------------------------------------------------------
// 表操作
// ---------------------------------------------------------------------------

void scan_table_reset(scan_table_t *t);

// 记录一次观测。返回 true 表示这是一个新设备段（首次出现，或已过期后重新出现）。
// now_ms 必须是单调递增的毫秒时钟。
// name/name_len 可为 NULL/0：没有名字时保留上一次已知的名字。
// fp 为 0 表示不做指纹合并。
// is_phone 为本次解析出的"像不像手机"；connectable 为广播类型是否可连接。
// 两者都只在首次判定时被采纳（cls_decided 之后忽略），避免同一设备多次广播
// 因为字段缺失导致判定来回翻转。
bool scan_table_observe(scan_table_t *t, const uint8_t key[SCAN_KEY_LEN],
                        bool key_is_anon, int8_t rssi,
                        const char *name, uint8_t name_len,
                        uint16_t fp, uint16_t manu_id, bool has_manu,
                        uint32_t now_ms);

// 带分类信息的观测（推荐入口）。cls_is_phone/connectable/evidence/peripheral
// 由调用方用 scan_class_* 算好后传入。
bool scan_table_observe_classified(scan_table_t *t,
                                   const uint8_t key[SCAN_KEY_LEN],
                                   bool key_is_anon, int8_t rssi,
                                   const char *name, uint8_t name_len,
                                   uint16_t fp, uint16_t manu_id, bool has_manu,
                                   bool cls_is_phone, bool connectable,
                                   uint8_t evidence, bool peripheral,
                                   uint8_t advertiser,
                                   uint32_t now_ms);

// 下一台电动车需要再累计多久（毫秒）。
//
// 什么时候用：用户改勾选之后，界面要显示 `LOADING Ns`。但"30 秒"只是
// 从零开始时的最坏情况——如果现场已经有一批设备在场 200 秒了，换判据后
// 它们其实是**立刻**就该算进去的。这里返回"最接近达标的候选还差多久"，
// 让倒计时说出真话。
//
// 返回 0 表示：已经不需要再等了（有设备够格，或者正在等待的候选不足 1 秒）。
// 没勾任何证据时也返回 0——那不是"等待"，是"关闭"。
uint32_t scan_table_next_vehicle_wait_ms(const scan_table_t *t, uint32_t now_ms,
                                         uint8_t evidence_mask);

// 剔除超过 window_ms 未出现的条目。window_ms 传 0 用 SCAN_ACTIVE_WINDOW_MS。
// 内部限流：同一毫秒内重复调用只做一次。
void scan_table_prune(scan_table_t *t, uint32_t now_ms, uint32_t window_ms);

// 当前在场的设备数量（默认用 SCAN_ACTIVE_WINDOW_MS 口径）。
size_t scan_table_count(const scan_table_t *t, uint32_t now_ms);

// 指定窗口的在场设备数。UI 想显示"10 秒内活跃"就传 SCAN_LIVE_WINDOW_MS。
size_t scan_table_count_window(const scan_table_t *t, uint32_t now_ms,
                               uint32_t window_ms);

// 累计发现过的不同设备数（估算）。含已过期设备，不清零。
uint32_t scan_table_total(const scan_table_t *t);

// ---------------------------------------------------------------------------
// 分类统计（见 scan_class.h）
// ---------------------------------------------------------------------------

// 手机数量：5 秒在场窗口内，被判定为手机的设备数。
//
// 注意这里用的是【在场窗口】而不是累计在场时长——手机只要还在附近就算。
size_t scan_table_count_phone(const scan_table_t *t, uint32_t now_ms);

// 电动车数量。
//
// evidence_mask 是用户勾选的证据位（EVID_*）。传入 0 表示不判车，返回 0。
// 判定条件见 scan_class_is_vehicle。
//
// 这个函数是纯读的：它用每个条目已缓存的 evidence 位现算，不需要重新收广播。
// 所以勾选变化能立刻反映——但"在场 30 秒"这个时间条件仍在条目里，
// 见 scan_table_restart_vehicle_timer。
// 把**当前被计入车数**的每一台逐条打到串口（标定用）。
//
// 为什么需要它：屏幕上的数字是"结果"，但要判断这个结果对不对，必须知道
// 究竟是哪几台、凭什么进来的。离线回放做不到这一点——**设备的 dwell 是从
// 它第一次出现开始累计的**，而抓包往往晚于页面启动，于是"早就进来、现在
// 还在广播"的设备在日志里只显示三五秒，会被回放判成"在场不足 10 秒"。
// 固件自己知道真实的 dwell，所以让它直接说是谁。
//
// 只在 LOG ON（sniff）开着时调用，避免平时刷日志。
int scan_table_dump_vehicles(const scan_table_t *t, uint32_t now_ms,
                             uint8_t evidence_mask);

// "像车但没有正面证据"的台数。判据与 count_vehicle 完全相同，只是**要求
// 没有** EVID_POSITIVE。它回答的是"如果只看形状、不看身份，会有几台"，
// 用于让用户知道"确认 0 台"背后还有多少不肯定的东西。
size_t scan_table_count_vehicle_maybe(const scan_table_t *t, uint32_t now_ms,
                                      uint8_t evidence_mask);

size_t scan_table_count_vehicle(const scan_table_t *t, uint32_t now_ms,
                                uint8_t evidence_mask);

// "这 N 台里有多少台是 Apple/Google/… 广播的"。
//
// 用途：车数明显不对时，一句话定位污染源。10 楼数出 27 辆，看这个就明白
// 全是楼里的手机和电脑，不是楼下的车。
//
// kind 传 ADV_KIND_*（见 scan_class.h）。
size_t scan_table_count_vehicle_kind(const scan_table_t *t, uint32_t now_ms,
                                     uint8_t evidence_mask, uint8_t kind);

// 把所有条目的电动车计时清零，让它们重新累计 30 秒。
//
// 什么时候调用：用户改动了证据勾选之后。原因——车数是个"观察结论"，
// 换了判据就应该重新观察，否则旧判据下攒的 30 秒会被新判据直接继承，
// 屏幕上会瞬间跳出一个用户没预期的大数字。
//
// 手机计时不受影响：手机判定跟证据无关。
void scan_table_restart_vehicle_timer(scan_table_t *t, uint32_t now_ms);

// 按上次观测时间刷新所有条目的 dwell_ms。
// 为什么单独一个函数：dwell 是个"随时间增长"的量，只有主循环定时调用
// 才能保证 UI 读数不滞后。observe 只负责把 dwell_base_ms 续上。
void scan_table_tick_dwell(scan_table_t *t, uint32_t now_ms);

// 推进"进入/退出"状态机（见 SCAN_GATE_*）。每秒调用一次即可，
// 内部按 SCAN_GATE_SAMPLE_MS 自己限流，所以像 tick_dwell 一样每包都调也没关系。
//
// 它做三件事：
//   1) 把"本秒收到没有"压进位图，并把位图随时间左移；
//   2) 未计数 -> 已计数：窗口内命中够数 且 RSSI 中位数达标；
//   3) 已计数 -> 未计数：连续若干秒没收到 或 中位数跌破退出阈值。
// 另外顺手做 TTL 兜底：超过 SCAN_TTL_MS 完全没更新的条目直接判死。
void scan_table_tick_confirm(scan_table_t *t, uint32_t now_ms);

// 查 key 对应的槽位号，找不到返回 -1。
int scan_table_find(const scan_table_t *t, const uint8_t key[SCAN_KEY_LEN]);

// 按指纹找一个可合并的条目：同 fp、不同 key、RSSI 接近。
// 返回槽位号，没有返回 -1。调用方拿到后自己把新键并进去。
int scan_table_find_fp_match(const scan_table_t *t, uint16_t fp,
                             const uint8_t key[SCAN_KEY_LEN], int8_t rssi,
                             uint32_t now_ms, uint32_t window_ms);

// 把一个身份键并进已有槽位（地址轮换）。

typedef struct {
    int8_t rssi;
    uint8_t key[SCAN_KEY_LEN];
    bool key_is_anon;
    uint8_t name_len;                  // 0 = 没收到名字
    char name[SCAN_NAME_MAX];          // 不含 '\0'
    uint16_t fp;
    uint8_t manu_id[2];
    uint32_t age_ms;                   // 距最近一次出现的时间
} scan_view_t;

// 遍历结果：填 buf，按"信号最强"降序返回实际条数（不超过 max）。
size_t scan_table_top(const scan_table_t *t, uint32_t now_ms,
                      scan_view_t *buf, size_t max);
