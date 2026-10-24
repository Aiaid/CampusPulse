# 模块划分与依赖规则

> 这是 Device Radar（Dev Seen 页面）这条线的**代码结构说明书**。
> 改代码之前先看这里，尤其是「依赖方向」和「新功能该放哪」两节。

## 一、为什么重构

重构前的问题是真实存在过的，不是审美问题：

| 现象 | 后果 |
|---|---|
| 同一份广播载荷被**四个**不同的 AD 遍历各解析一遍（`scan_class_parse` / `extract_name` / `extract_manu_id` / `extract_ad_profile`） | 任何一份边界写错都不报错，只会"偶尔少个字段" |
| 车判定有**两套并行实现**（`scan_class_is_vehicle()` 和 `scan_table.c` 的 `vehicle_hard_ok()`），前者零调用点 | 外部评审按前者提了修改方案，**改完屏幕上一点变化都没有** |
| 手机判定和车判据混在一个文件里 | 车判据要用手机判定的结果（"是手机就不算车"），想省 CPU 关掉手机判定会**直接改坏车数** |
| `scan_class.c` 495 行 = 解析 + 手机判定 + 车证据 + 排除表 + 诊断文本 | 想知道"车判据在哪"要先读完整个文件 |

## 二、现在的模块

```
                    ┌──────────────────┐
                    │   scan_ble.c     │  射频/扫描/调度（NimBLE observer）
                    └────────┬─────────┘
              ┌──────────────┼───────────────┬──────────────┐
              ▼              ▼               ▼              ▼
      ┌──────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐
      │  ad_parse    │ │ dev_phone  │ │ veh_rules  │ │ scan_stats │
      │  载荷解析     │ │ 手机/外设   │ │  车判据     │ │ 累计表+导出 │
      └──────────────┘ └─────┬──────┘ └─────┬──────┘ └────────────┘
                             │              │
                             └──────┬───────┘
                                    ▼
                            ┌──────────────┐
                            │  dev_diag    │  诊断文本（读上面两家）
                            └──────────────┘

      ┌──────────────┐        ┌──────────────┐
      │ scan_table   │◄───────│  demo_scan   │  页面（布局/绘制/按键/平滑）
      │ 在场表+计数   │        └──────────────┘
      └──────────────┘
```

| 模块 | 文件 | 职责（只做这一件事） |
|---|---|---|
| **ad_parse** | `ad_parse.{h,c}` | 遍历一次 AD 结构，填 `scan_facts_t`：名字、厂商 ID/长度、Appearance、16 位 UUID、128 位 UUID、AD 类型位图、首个 0x16 UUID。**全工程唯一的 AD 遍历入口。** |
| **dev_phone** | `dev_phone.{h,c}` | 手机厂商白名单、Apple Continuity 子类型、名字关键词表、`dev_phone_is_phone()` / `dev_phone_is_peripheral()`、广播者身份猜测、手机数的 RSSI 门槛常量 |
| **veh_rules** | `veh_rules.{h,c}` | 证据位 `EVID_*`、办公设备品牌表、`veh_rules_evidence()`、`veh_rules_hard_ok()`（唯一的车判定入口）、`SCAN_VEHICLE_DWELL_MS` |
| **dev_diag** | `dev_diag.{h,c}` | 把解析 + 分类结果拼成一行诊断文本（串口日志） |
| **presence**（原 `scan_table`） | `scan_table.{h,c}` | 身份键、载荷指纹、槽位分配、`observe`、`prune`、dwell、滞回状态机，以及**只读**的计数（LIVE / 手机 / 电动车 / top） |
| **stats** | `scan_stats.{h,c}` | 离线累计签名表（按 MAC）+ NVS 落盘 + `[STAT]` 导出（诊断用，正式版可整体摘掉） |
| **sdr** | `scan_ble.{h,c}` | NimBLE observer 启停、扫描参数、去重门限、采样开关、快照 |
| **dashboard** | `demo_scan.c` | 这一页的全部：布局、绘制、按键、显示平滑 |

`dev_class.h` 只是把 `ad_parse.h` / `dev_phone.h` / `veh_rules.h` 转发出去，**为了少改调用点**。
新代码请直接 include 对应的模块头。

## 三、依赖方向（只能往下，不能往上）

```
dashboard ──► sdr ──► { ad_parse, dev_phone, veh_rules, stats, presence }
                          ▲            ▲           │
                          └────────────┴───────────┘
                                   dev_diag
```

- **ad_parse 不认识任何判定**：它只回答"广播里写了什么"。所以 `dev_phone_describe()`
  （要引用手机厂商和证据位）被迫搬到了 `dev_diag.c` —— 这就是依赖方向在起作用。
- **dev_phone 不认识车**：它不知道 `EVID_LINK_SHORT` 是什么。
- **veh_rules 不认识扫描表**：`veh_rules_hard_ok()` 的入参全是基本类型，
  不接收 `scan_entry_t`。这样这条规则可以脱离整张表单独测。
- **presence 不认识判定**：`vehicle_hard_ok()` 只是一层薄包装，把条目字段摊开喂给
  `veh_rules_hard_ok()`。存表的人不该知道什么叫电动车。

**新增规则时的判断方法**：如果新代码要同时用到"手机"和"车"两边的结论，
它属于 `dev_diag` 或更上层，**不要**塞回 `dev_phone` 或 `veh_rules`。

## 四、新功能该放哪

| 你想做的事 | 放哪 |
|---|---|
| 解析一个新的 AD 字段（如 TX Power、Service Data 32 位） | `ad_parse`：加字段到 `scan_facts_t` + 在 `ad_parse()` 的分派里填 |
| 加一家手机厂商 | `dev_phone`：`ad_parse.h` 加 `MANU_*`，`dev_phone_vendor()` 加 case |
| 加一类"不是车"的品牌或协议 | `veh_rules`：`veh_rules_manu_is_office()` 或 `veh_rules_hard_ok()` |
| 改"在场"的判定（窗口、dwell、滞回） | `scan_table` 的 `SCAN_*` 常量与 `tick_*` |
| 改某个数字的显示方式 | 只动 `demo_scan.c`，**不要**去改计数函数 |
| 加一个像"离线标定"这样的新诊断能力 | 新开模块，`stats` 已经是个例子 |
| 临时调试输出 | `dev_diag`（分类）或 `scan_ble` 的 sniff 分支（逐包） |

## 五、还剩一处没拆

`demo_scan.c`（约 540 行）仍然把**布局创建 / 绘制 / 按键 / 平滑**放在一个文件里。
它不再混判据（那是最大的问题），但后续如果要加第二个页面或第二种视图，
应该拆成：

- `dash_view.c`：创建 LVGL 对象 + 一个 `dash_view_draw(const scan_snapshot_t *)`
- `dash_page.c`：enter/exit/key/timer 与显示平滑

拆的时候要注意 LVGL 对象的生命周期与 z 序（色块必须先于文字创建），
以及**所有 LVGL 调用必须在 `bsp_lvgl_lock()` 内**——这一页曾经因为漏锁而
死在看门狗里（见开发实录 §5.10）。

## 六、已经删掉的东西

| 符号 | 为什么删 |
|---|---|
| `scan_class.c/.h` | 拆成 `ad_parse` / `dev_phone` / `veh_rules` / `dev_diag` |
| `scan_class_is_vehicle()` | 零调用点，判据还是被推翻的 `!connectable` |
| `scan_class_pick()` | 零调用点，同上 |
| `scan_class_name()` | 声明了但从来没有实现 |
| `scan_gate.c`（已从构建移除） | `scan_gate_reset/feed` 零调用点 |
| `extract_name()` / `extract_manu_id()` / `extract_ad_profile()` | 与 `ad_parse` 重复的 AD 遍历 |
