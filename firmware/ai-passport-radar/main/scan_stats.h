// main/scan_stats.h —— 本轮累计的"每台设备"表（离线标定用）。
//
// ---------------------------------------------------------------------------
// 为什么需要这张表
// ---------------------------------------------------------------------------
//
// 扫描表（scan_table.c）按 10 秒在场窗口滚动，一台设备 10 秒没冒泡就被清掉。
// 所以"拿着设备去车棚转一圈、回来插电脑看"这个用法不成立——回来时车棚里的
// 设备早就过期了。而且串口逐包日志只在连着电脑时才有接收方，没接就等于没记。
//
// 这张表**不按时间过期**，只按 MAC 累加，并且落盘到 NVS（拔线断电也不丢）。
//
// ---------------------------------------------------------------------------
// v2：从"按名字前缀聚合"改成"按 MAC 聚合"
// ---------------------------------------------------------------------------
//
// v1 是按 (厂商 ID, 设备名前缀) 聚合的，实测在车棚里彻底失败：
// 3934 个包里有 **3674 个（93%）没有名字**，全部落进 `(无名)` 一个桶里。
// 最典型的证据是台铃用的那个 BandSpeed 模组（manu=0x0020）：
//   `0x0020 (无名)` 350 包，而 `[observed name omitted]` / `_DF` 加起来只有 36 包。
// 也就是说 10 台车的数据被合并成了 1 行，屏幕上只看得到 7 台。
//
// 现在改成一台设备一条记录（MAC 为键），名字取"见过的第一个非空值"。
// 导出时再按前缀做一次聚合——**聚合是展示层的事，不该影响采样**。
//
// 为什么名字会缺失：BLE 的名字通常放在 SCAN_RSP 里，ADV 包只有 31 字节不带名字。
// 而原先的 DUP_GATE 按 MAC 去重，2.5 秒内的后续包整包丢弃，SCAN_RSP 就被丢了。
// 这一点已在 scan_ble.c 里一并修掉（改成按 MAC + 载荷指纹去重）。
#ifndef SCAN_STATS_H
#define SCAN_STATS_H

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

// 最多记多少台不同设备。车棚实测 45 个签名，实际设备估计 20~40 台；
// 教室那种场景会到 200+，所以留到 256。
// 每条约 36 字节，256 条 ≈ 9KB。
#define SCAN_STATS_DEVS       256
#define SCAN_STATS_NAME_MAX   16

typedef struct {
    uint8_t  mac[6];         // 大端，和日志里打印的 MAC 一致
    uint8_t  manu[2];        // 厂商 ID（小端原样）
    bool     used;
    bool     has_manu;
    char     name[SCAN_STATS_NAME_MAX];   // 见过的第一个非空名字（不含 '\0'）
    uint8_t  name_len;
    uint16_t packets;        // 该设备累计包数（饱和到 65535）
    int8_t   rssi_best;      // 最强 RSSI（dBm）
    uint8_t  type_mask;      // bit0=0x00 可连接, bit1=0x03 不可连接, bit2=其他
    uint8_t  mlen_max;       // 厂商数据最大长度
    // 厂商数据最小长度（255 = 从没见过带厂商数据的包）。
    // 为什么要它：只看 mlen_max 分不清"偶尔一包长"和"一直都很长"。
    // 实测 Apple 的 Continuity 是长短包混发，一批设备整段日志里 manu_len
    // 只有 4 字节 —— 这种设备永远拿不到 EVID_MANU_LONG，会被当成"短数据"。
    uint8_t  mlen_min;
    bool     has_uuid128;
    uint8_t  evidence;       // 命中过的证据位（按位或）
    bool     phone;          // 是否被判成过手机

    // ---- AD 结构画像（v3 新增）----
    // 为什么需要：实验室屏幕上数出的 4 台"电动车"全是打印机，而 type/len/
    // mlen/name 这些字段和真车完全一样。**唯一能区分的是 AD 里到底有哪几种
    // AD Type**（真车靠 0x09/0xFF/0x16 传车架号，打印机是 Flags+名字或
    // Flags+一段 member service data）。
    //
    // 有了这个画像，带着设备去车棚转一圈（不用接电脑），回来就能对比
    // "无名候选"和"打印机"的 AD 结构，判别式才有依据可写。
    uint32_t ad_mask;        // bit n = 见过 AD Type n（0x01/0x09/0x16/0xFF…）
    uint16_t svc16;          // 见过 AD Type 0x16 时，第一个 16 位 service UUID（0=无）
} scan_dev_t;

void scan_stats_reset(void);

// 记一包。on_disc 里调用（调用方已持有扫描表锁）。
// ad_mask：这一包的 AD Type 位图（bit n = AD Type n）。
// svc16  ：这一包里第一个 AD Type 0x16 的 16 位 service UUID（0 = 没有）。
void scan_stats_note(const uint8_t mac[6], bool has_manu, uint16_t manu_id,
                     const char *name, uint8_t name_len,
                     int8_t rssi, uint8_t event_type,
                     uint8_t manu_len, bool has_uuid128,
                     uint8_t evidence, bool is_phone,
                     uint32_t ad_mask, uint16_t svc16);

// 已记录的设备台数。
int scan_stats_count(void);

// 打到串口：先报总数，再按名字前缀聚合展示。返回设备台数。
int scan_stats_dump(void);

// ---------------------------------------------------------------------------
// 掉电保持（NVS）
// ---------------------------------------------------------------------------
//
// **拔掉 USB 就等于断电**，RAM 会清零。实测栽过一次：去车棚转完一圈，
// 回来插线时芯片 uptime 只有 98 秒，数据全没了。
//
// 语义约定：
//   NVS 里放的是"上一趟已经结束的"数据；RAM 里放的是"当前这一趟"。
//   进页面 = 读 NVS + 导出（**不清空**，见下）；出页面 = 把 RAM 写进 NVS。
//
// 为什么导出后不清 NVS：打印那一刻如果串口没连着，数据就打进了空气，
// 而 NVS 已清掉的话这趟就永久丢失。现在只有 RESET 才清。
esp_err_t scan_stats_save(void);
esp_err_t scan_stats_load(bool clear_after);
esp_err_t scan_stats_clear_nvs(void);

#endif  // SCAN_STATS_H
