# T-Energy-S3 硬件与板级定义

核查日期：2026-10-23。性质：**厂商仓库资料整理**，不是手头板卡的实测结果。
官方仓库 revision `68a74854ce0443377d186786bf3478484a0813e0`（与外壳调研同一版本）。
原理图 `project/T-Energy-S3_V1.0.pdf` 本轮**未能获取**（下载返回 502），
所有引脚结论仅来自仓库内代码与配置，未经万用表或实物核对。

来源稿由用户于 2026-10-23 提供，SHA-256
`ab6786afd4c90738c6be806d0f55b57eacaec178f80e6d910d78937653c1d459`。
文中数值已落实到 `firmware/t-energy-s3/` 的板级配置，共享固件链的移植方式见
[T-Energy-S3 移植方案](../design/tenergy-s3-port.md)。厂商代码未逐行复制，见[复用记录](../notes/reuse.md)。

## 结论

这块板对 CampusPulse 采集节点的价值在于：**它什么都不接**。
没有屏幕、没有外设总线、没有音频，只需要片内 BLE 扫描 + Wi-Fi 上传 + 一个电池 ADC。
因此板级适配的工作量不在引脚，而在 **PSRAM 模式、Flash 分区和 USB 控制台**三处配置。

## 厂商规格

| 项 | 值 | 备注 |
| --- | --- | --- |
| 型号 | T-Energy-S3_V1.0（2024-04-10） | 仓库只有这一个版本 |
| 模组 | ESP32-S3-WROOM-1 | 芯片 ESP32-S3-R8 |
| Flash | 16 MB | `boards/esp32s3_flash_16MB.json` |
| PSRAM | 8 MB，**Octal SPI** | `board_build.memory_type = qio_opi` |
| 电池 | 18650 | 带电池座 |
| 充电芯片 | HX6610S | — |
| 充电保护 | IP3005A | — |
| USB | Hardware CDC and JTAG（原生 USB） | `ARDUINO_USB_MODE=1`，占 GPIO19/20 |
| 板载按键 | BOOT-0 | 用于强制下载 |

## 板级定义（厂商代码实际给出的事实）

| 项 | 定义 | 来源 |
| --- | --- | --- |
| 电池电压 ADC | `BATTERY_VOLTAGE_DATA = 3`（GPIO3） | `libraries/Mylibrary/pin_config.h`，全文仅此一行 |
| 电池电压换算 | `analogReadMilliVolts(IO3) * 2` | `examples/Original_Test/Original_Test.ino`，**板上为 1/2 分压** |
| ADC 衰减 | `ADC_ATTENDB_MAX`，12 bit | 同上 |
| 外部 UART | 接 Uart0 | README FAQ |
| 默认分区表 | `default_16MB.csv`（Arduino 16MB 方案，3 MB APP + 9.9 MB FATFS） | `platformio.ini` |
| Flash 模式 | QIO，80 MHz | `boards/esp32s3_flash_16MB.json` |

**除 GPIO3 外，厂商代码没有定义任何引脚的用途。** `pin_config.h` 只有一行。
`Original_Test.ino` 里有一大段被注释掉的 `pinMode(GPIO_NUM_xx)` 列表
（0、1、2、3、4、5、6、7、8、9、10、11、12、13、14、17、18、21、35、36、37、
38、39、40、41、42、43、44、45、46、47、48），但那是空引脚翻转测试，
**不能当作"这些脚都可用"的依据**：它与 Octal PSRAM 的引脚占用存在明显冲突
（见下方未核实项）。

## 对固件的三个直接影响

| 事项 | 要求 | 依据 |
| --- | --- | --- |
| PSRAM 模式必须选 Octal | `CONFIG_SPIRAM_MODE_OCT=y`。选成 Quad 会导致 PSRAM 初始化失败或启动异常 | `qio_opi` |
| PSRAM 默认**未启用** | 厂商示例里 `-D BOARD_HAS_PSRAM` 是注释掉的，Arduino 设置表却写 "PSRAM: OPI PSRAM"，需自己打开 | 仓库两处自相矛盾 |
| 分区表要重做 | 默认 3 MB APP + 9.9 MB FATFS 不适合本项目：我们不需要文件系统，需要的是**大块数据分区**放有界队列 | `default_16MB.csv` |
| 控制台配置有矛盾 | `platformio.ini` 里 `ARDUINO_USB_CDC_ON_BOOT=0`（走外部 UART），README 的 Arduino 表格写 "USB CDC On Boot: Enabled"，两者冲突；需实机确认日志从哪个口出来 | 仓库两处自相矛盾 |
| 电池电压要乘 2 | ADC 读到的是一半分压，直接上报会低一半 | `* 2` |

## 未核实项

- 原理图 PDF 未获取，**没有完整的引脚功能表**（是否有 LED、RTC、额外 I2C 等）。
- Octal PSRAM 通常占用 GPIO33–37（flash 占 GPIO26–32），若成立则
  `Original_Test.ino` 注释里的 35/36/37 不可用作普通 IO；此点需按
  ESP32-S3-WROOM-1 datasheet 与实物核对，本仓库未验证。
- `Deep_Sleep_Wake_Up` 示例的唤醒源与实测电流本轮未读、未测。
- 电池分压电阻的实际阻值、ADC 线性度、低电压保护阈值均未测。
- 手头两块板是否为同一批次、丝印版本是否一致，未核对。

## 本项目在代码中的落实

`firmware/t-energy-s3/` 只承接上文可以直接从厂商资料推导的部分：

| 落点 | 文件 | 对应事实 |
| --- | --- | --- |
| Flash 16 MB / QIO / 80 MHz | `sdkconfig.defaults` | 板级 JSON |
| Octal PSRAM 8 MB | `sdkconfig.defaults` | `qio_opi` |
| 小 APP + 大 `storage` 数据分区 | `partitions.csv` | 取代 `default_16MB.csv` |
| 控制台选 UART0 | `sdkconfig.defaults` | 取 `platformio.ini` 一侧，**仍待实机确认** |
| 电池 ADC：GPIO3、12 bit、满衰减、×2 | `main/board.c` | `pin_config.h` 与示例 |

尚未落实：BLE 扫描、Wi-Fi 上传、有界持久队列、断电计数。这些属于
[路线图](../design/ROADMAP.md) P0 后续条目，本固件只做上电自检，
不能作为采集节点或射频可用性的证据。

## 来源

- [LILYGO T-Energy-S3 仓库](https://github.com/Xinyuan-LilyGO/T-Energy-S3)（PIN 定义、板级 JSON、platformio 配置）
- [ESP32-S3-WROOM-1 datasheet](https://www.espressif.com/sites/default/files/documentation/esp32-s3-wroom-1_wroom-1u_datasheet_en.pdf)（引脚复用，本轮未逐一核对）
- 外壳资料见 [t-energy-s3-enclosure.md](t-energy-s3-enclosure.md)

以上均为厂商公开资料，不构成手头板卡的验收结果。
