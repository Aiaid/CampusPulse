# 代码归属：哪些是正式功能，哪些只是测试/调试

> 这份清单只回答一个问题：**改代码时哪些能放心动、哪些动了会影响用户、哪些其实早就没用了。**
>
> 盘点时间：**2026-10-21 中午**，对应固件 `FoloToy-AI-Passport-full.bin` **1,674,864 字节**（v34 + codex 的直绘 UI）。
>
> ⚠ 这份清单在 10-21 大改过两次（拆模块 + 换 UI），10-20 版里提到的
> `scan_class.c` / `demo_scan.c` / `ui_pixel*.c` / LVGL 端口**都不是现在的样子**。

---

## 一、正式功能（用户会用到，改这些就是在改产品）

| 文件 | 内容 | 备注 |
|---|---|---|
| `main/page_radar.c` | 页面：布局、绘制、按键、平滑、`[BIKE]` 节拍 | **新 UI**，esp_lcd 直绘 |
| `main/ui_mini.c/.h` | 图元：`ui_render/ui_clear/ui_fill/ui_text/ui_digits` | 单缓冲，**有撕裂问题待修**（见开发实录 §5.35 ①）|
| `main/font_zh.c/.h` | 16×16 中文点阵，135 字（含全部可打印 ASCII + `▲▼`） | 由 `gen_font.ps1` 生成，**不要手改** |
| `main/font_digit.c/.h` | 60 px 大数字（`0123456789-`） | 同上 |
| `main/scan_ble.c/.h` | NimBLE Observer、`on_disc`、启停、快照、开关、sniffer 日志 | 核心 |
| `main/scan_table.c/.h` | 在场表（384×68B）、身份键、指纹合并、车数/手机数、`[BIKE]` 打印 | 核心 |
| `main/ad_parse.c/.h` | **全工程唯一的 AD 遍历入口** | 纯函数，可离线测 |
| `main/dev_phone.c/.h` | 手机识别：厂商白名单、Apple 子类型、外设/手机名字词表 | 纯函数 |
| `main/veh_rules.c/.h` | **唯一的车判定入口**：证据位、排除表、`VEHICLE_BRANDS[]` | 纯函数 |
| `main/dev_diag.c/.h` | 一行诊断文本（同时读手机判定与车证据位） | 只给日志用 |
| `main/main.c` | 初始化、按键队列、`radar_power_off()` | 核心 |
| `components/bsp/*` | 显示/按键/音频/电量 | 板级，尽量别动 |

### 用户能操作的功能

| 功能 | 入口 | 代码位置 |
|---|---|---|
| 手机数 / 电动车数 | 进页面即显示 | `scan_table_count_phone` / `count_vehicle` |
| 手机采样开关 | 焦点在"手机采样"按 OK | `scan_ble_set_phone` |
| 电动车采样开关 | 焦点在"电动车采样"按 OK | `scan_ble_set_evidence` |
| 全部清零（两段确认） | 焦点在"全部清零"按两次 OK | `scan_ble_reset` |
| 串口标定日志 `LOG ON` | **双击 OK** | `scan_ble_set_sniff` |
| 关机进深睡 | **长按 OK** | `radar_power_off()`（`main.c`）|

### 当前判据（v34，用户看到的就是这个）

```
车数 = 在场(10s) + 累计在场≥10s + 可连接 + 厂商数据<8B
       + 非手机/非外设/非办公品牌/非消费电子/非已知外设UUID/非手表电脑HID
       + **名字命中 VEHICLE_BRANDS[]**（正向准入，没有就不算）
```

`VEHICLE_BRANDS[]` 在 `veh_rules.c`，目前 11 个品牌，其中 3 个有实测日志
（`LuYuan-Smart` 绿源 / `ZEEHO-22af44` 极核 / `BYD BLE3` 比亚迪）。
**这是唯一需要长期维护的名单**——补它的依据是 `[BIKE?]` 日志。

---

## 二、诊断 / 标定（可以动，不影响用户）

| 文件 | 内容 | 什么时候用 |
|---|---|---|
| `main/scan_stats.c/.h` | 累计设备表（256 台）+ NVS 落盘 + `[STAT]` 导出 | 离线标定；正式出包可整套摘掉 |
| `[BIKE]` / `[BIKE?]` 日志 | `scan_table_dump_vehicles()`，LOG ON 时每 5 s 一坨 | **查"这台为什么算/不算车"** |
| `[STAT]` 汇总 | `scan_stats_dump()`，进页面时打一次 | 看这一趟走过的地方有哪些设备类型 |

---

## 三、工具（`ai-passport/tools/`）

| 文件 | 用途 |
|---|---|
| `analyze_sniff.py` | 按固件语义离线回放日志；**开头会报"解析失败行数"，≠0 就说明解析器和固件脱节了** |
| `sniff_wait.py` | 先起脚本、等检测到逐包数据再计时（避开"连串口就复位"）|
| `capture_log.py` | 抓 N 秒串口日志；open 后立刻 `setDTR(False)` |
| `verify_firmware.py` | 校验 `full.bin` 布局（**参数是目录**）|
| `README-模块划分.md` | 模块依赖图 + "新功能该放哪" |
| `README-车棚标定.md` | 离线采集流程 + `[STAT]` 判读 |

---

## 四、死代码 / 遗留（可以删，删前确认没人引用）

| 文件 | 状态 |
|---|---|
| `main/ble_radar.c/.h` | 在 CMakeLists 里但**零调用点** |
| `main/demo_radio.c` | 同上（WiFi/NVS 初始化片段，主流程没用到）|
| `components/bsp/src/bsp_display_lvgl.c` | 仍参与编译 → **LVGL 整个库还被链接**，但运行时从不初始化。删掉能省 flash/RAM |
| `main/demo_scan.c` | 旧页面（LVGL）。**已移出 CMake**，但里面的 `[BIKE]` 节拍逻辑还没搬进新 UI（见 §5.35 ②）|
| `main/demo_audio.c` / `demo_battery.c` / `demo_ble.c` / … | 套件自带的其它演示页，已移出 CMake |
| `main/scan_gate.c/.h` | 唤醒状态机，零调用，已移出 CMake |
| `main/scan_class.c/.h` | **已删除**（拆成 ad_parse / dev_phone / veh_rules / dev_diag）|
| `main/ui_pixel*.c` | 旧像素风画布，已移出 CMake |

---

## 五、改动风险提示

| 想改的东西 | 风险 |
|---|---|
| `ui_mini.c` 的渲染循环 | **先修撕裂**（单缓冲 + 异步 DMA），否则任何视觉判断都不可信 |
| `veh_rules.c` 的 `VEHICLE_BRANDS[]` | 安全，只影响"算不算车"；加词比删词安全 |
| `dev_phone.c` 的 `PERIPH[]` / `PHONE_KEYS` | 会影响**手机数**，而且它是车判据的输入之一（"是手机就不算车"）|
| `scan_table.h` 的容量/窗口常量 | 384×68B 是内存大头；改大要先看 heap free |
| `page_radar.c` 的长按分支 | 现在是**关机**，不是返回；改动前先确认唤醒可靠 |
| BSP | 尽量别动，尤其显示初始化与按键 ADC 分压 |
