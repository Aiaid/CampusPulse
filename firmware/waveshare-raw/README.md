> **2026-10-31:** 旧 USB-v2 配网适配器及构建开关已移除；该工程仅保留独立离线 TF/CPRAW 记录。当前联网、物理 USB bootstrap 和 V3 小统计入口为 [waveshare-v3](../waveshare-v3/README.md)。下文配网实验记述为历史，不再可编译。V2 板卡型号、USB 导出格式及 CPRAW 格式并非旧采集协议，保持不变。

# 微雪 BLE raw 记录固件

独立的 ESP-IDF 5.5.3 工程，目标为 ESP32-S3-ePaper-1.54 V2（8 MB Flash、
8 MB OPI PSRAM）。这是重新设计后的首版软件，不使用旧 Passport 的采集管线。
当前离线写 TF 卡，已加入四页中文 LVGL UI：设备诊断、BLE 活动、车辆线索、
候梯观测。车辆分析和候梯预测未启用，界面中的未知项保持 `--`。

## 记录内容

- 被动扫描 1M/Coded PHY、保留重复报告；没有按地址去重或每窗口四条配额。
- 保存 SDK 交付的传统/扩展广播报告原始字节、地址类型、RSSI、PHY、分片状态、
  接收序号和本机单调时间。扩展片段按 SDK 交付状态保存，不冒充已重组的完整广播。
- RTC有效时追加UTC时间锚点；USB可信校准后记录新锚点，不重写旧报告或旧文件。
- 预分配 1024 个 PSRAM 槽位；接收回调不写盘、不等待磁盘、不动态分配。
- 记录写入 TF 的 `cpraw/` 目录，约 16 MiB 分段；每次新建文件，不覆盖旧录制。
  每秒请求一次文件同步，记录 CRC、统计和正常/异常终止事件。
- 卡空间低于预留阈值时先停止扫描、尝试排空缓冲，再同步并卸载。实际写入失败、
  短写、磁盘满、同步失败和缓冲溢出会分别反映在日志或记录计数中。

“raw”是 SDK 交付的广播报告，不是含射频通道、完整链路层头和空口 CRC 的抓包。
当前扫描不主动请求 scan response，也不建立 periodic sync。射频/控制器之前的
漏收不可由软件零丢包推断。缓冲是有限的；掉电可能损失最后一次同步后的内容，
TF 控制器的写缓存也影响实际持久性。一次7,258条 raw 和一次四页并发5,183条
试跑完成同步/安全停止；实板持续速率、饱和捕获和断电恢复仍未证明。
详见[首轮验收](../../docs/notes/waveshare-raw-first-acceptance.md)。

## 操作

1. 使用已经格式化、兼容 ESP-IDF FatFs 的 TF 卡；固件从不自动格式化。
2. 启动时挂载卡并创建新段，BLE 初始化成功后开始记录。默认串口不打印地址、
   payload或卡序列号；显式READ导出会传输raw字节，应由本机工具私有保存。
3. 通过 USB 串口发送一行 `STOP`，等待 `SAFE TO REMOVE`，再取卡。
   `LOW SPACE; CARD SAFE` 表示空间预警后收尾完成；`BLE ERROR; CARD SAFE`
   表示扫描异常，但卡已正常卸载。`STORAGE ERROR` 不表示完整保存成功。
4. 停止后重新启动开启新会话；没有恢复录制命令。
5. BOOT（GPIO0）短按切页；USB `PAGE`也可切页。可选 USB 配网实验版
   增加第五页：长按 BOOT 约2秒先安全停录，再进入 USB 配网模式；电脑向导
   显式开始配网时也会先执行安全停录。仅插线不会自动进入配网。配网结束后需
   重启以开始新的录制会话。
6. PWR（GPIO18）长按约1秒请求安全关机：先停止/排空/同步/卸载、显示关闭状态，
   松开后释放GPIO17电池保持并深睡眠。启动时先等待PWR松开，不把开机长按当关机。
   USB能继续给VSYS供电，因此USB下是软件睡眠；PWR低唤醒。存储/准备失败保持供电。
   实际按键、电池模式关机/唤醒仍待按压验证。

## 只读导出与校时

物理USB命令按整行接收。`FILES`只在writer结束后挂载只读导出视图，输出卡/分区
容量、最多128个raw文件的索引/大小、当前文件索引及是否截断；不会输出文件名。
`READ <index> <offset>`最多返回512字节及CRC32，`CLOSE`关闭导出并卸载。
录制活跃时拒绝导出，关机开始后拒绝新的读取/校时。
`TIME <UTC Unix秒>`校准并读回PCF85063，范围2000–2099；停止收尾期间拒绝校时，
已结束会话的校时只用于RTC/后续会话，不承诺写回已关闭文件。
`CLOCK`只读输出RTC UTC、返回值和状态寄存器，便于辨别OS/STOP与I2C读取失败。
当前卡数据/容量核对与RTC实测见[文件审计](../../docs/notes/waveshare-raw-file-audit.md)。

诊断页显示网络状态（本版关闭）、内部 RAM/PSRAM/TF/缓冲占用、运行时间及错误。
BLE 页显示接收速率、近60秒接收/写入和分箱趋势；车辆页保留未分析状态与同步
报告数；候梯页显示 RSSI 统计/趋势与未启用估计。电池经 V2 的 GPIO4/ADC1
通道3、1:2 分压读取，仅在 ADC 校准和采样有效时显示电压。百分比是 3.0–4.2 V
线性粗估，受负载和充电影响，并非电量计；该电路不能确认电池是否存在、USB
供电或充电状态。容量和实际放电曲线未验证，剩余时间显示 `--`。电池实板测试
尚未完成。RTC有效时诊断页
显示UTC+8日期/时间。未经过当前boot主机校准的RTC时间不冒充本boot已校准状态。
`written` 仅表示标准 I/O 接受的报告；`synced` 表示最近成功完成同步的报告数。
屏幕是快照，常规目标每2秒更新，换页/关键状态通知显示任务立即处理。
仅变化矩形走局刷，无变化跳过；首次/换页/错误恢复/关机用全刷，累计20次
局刷或距全刷60秒后的下一次变化会全刷清屏，大于90%的变化包围区域也走全刷。
局刷保留屏幕逻辑供电，关机再off；失败后重建完整基线。
本机首轮实测局刷704–720ms、全刷约1909ms，见
[局刷验收](../../docs/notes/waveshare-partial-refresh.md)。
四页软件视觉验证见 [UI QA](../../docs/notes/waveshare-raw-ui-qa.md)。

## 构建与检查

激活 ESP-IDF 5.5.3 的 S3 工具链及 Python 环境，执行 `bash build.sh`，
默认版本为 `0.1.5-battery`，可用 `RAW_VERSION` 指定版本。
可选的 `0.1.8-usb-v2-experiment` 使用构建开关 `RAW_ENABLE_USB_PROVISION_V2`
与 `CONFIG_RAW_USB_PROVISION_V2` 显式启用原有 v2 USB 配网；默认构建仍离线。
长按 BOOT、安全停录和 USB begin/info 在实板通过；浏览器向导、真实 Wi-Fi/TLS、
保存和恢复尚未实板验收。它不实现 v3 配置或任何上传，也不会自动联网。
依赖由 `main/idf_component.yml` 固定为 LVGL 9.5.0；离线环境可用
`RAW_LVGL_PATH` 指定同版本源码（例如本机已下载的官方 managed component）。
脚本使用 `uv`、全新外部构建目录，并检查目标、依赖、分区和独立镜像；不操作设备。
只生成 bootloader、partition table、application 三个独立镜像；刷写前须另行核对
实板版本、现有分区和数据，并保留设备备份，不能整片擦除。

```sh
UV_CACHE_DIR=/tmp/campuspulse-raw-uv uv run --no-project python -m unittest discover -s tests -v
UV_CACHE_DIR=/tmp/campuspulse-raw-uv uv run --no-project python tools/decode.py /path/to/capture.bin
```

解码默认只输出汇总；显式 `--records` 才包含地址和 payload。原始录制和详细解码
结果应私有保存，不进入 Git。格式和截断处理见 [FORMAT.md](FORMAT.md)。

`tools/archive_uploader.py` 可对已导出的单个文件准备私有、不可变的本机归档
副本，并在明确执行上传时核对服务端持久回执；重试保留同一批次。它不会删除
原件或本机副本，也不自行从 USB 读取。服务端当前默认关闭且未部署，工具仅完成
合成和本地服务测试，不代表实机自动上传可用。接口见
[CPRAW 归档契约](../../docs/specs/cpraw-archive-v1.md)。

离线协议证据基线可运行 `uv run --no-project python tools/extract_evidence.py FILE`。
输出按单个分段汇总 AD 类型、公司编号、服务和 Appearance，默认不输出地址、名称、
原始载荷或 128 位 UUID；分片与异常分别计数，不推断设备类别或总量。容量超限时
拒绝输出部分结果。它不改变设备采集，也不代表线上上传或识别已经完成。

## 驱动依据和许可

TF 使用 SDMMC 1-bit：CLK39、CMD41、D0=40。依据为微雪官方
[V2 SD 示例](https://github.com/waveshareteam/ESP32-S3-ePaper-1.54/blob/aaf395c1bbd86f7c5b7a2f9f0401241ff5c44956/02_Example/ESP-IDF/V2/04_SD_Card/components/sdcard_bsp/sdcard_bsp.c)。
SSD1681 驱动源于本项目此前自写的墨水屏驱动；新录制代码为本项目编写，未另行声明开源许可。
LVGL 9.5.0 是 MIT 依赖，许可与字体信息随其源码提供；未复制旧应用的网络、
统计或身份逻辑。依赖许可副本位于 [licenses/](licenses/README.md)，随镜像保留。
复用记录见 `docs/notes/reuse.md`。
V2 电池电路参考[官方原理图](https://github.com/waveshareteam/ESP32-S3-ePaper-1.54/blob/aaf395c1bbd86f7c5b7a2f9f0401241ff5c44956/04_Hardware/Schematics/ESP32-S3-Touch-ePaper-1.54-Schematic.pdf)
和[对应 ADC 示例](https://github.com/waveshareteam/ESP32-S3-ePaper-1.54/blob/aaf395c1bbd86f7c5b7a2f9f0401241ff5c44956/02_Example/ESP-IDF/V2/01_ADC_Test/components/adc_bsp/adc_bsp.c)。
