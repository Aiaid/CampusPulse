# AI Passport v2 射频独占修复与验证（2026-10-25）

分支：`feat/passport-ble-memory-diag`。设备：COM5 Passport `cp_4c11ae2fd82c`。
前置联调与崩溃取证见 `feat/passport-v2-field-test` 分支的
`docs/notes/ai-passport-v2-acceptance-2026-10-25.md`。

## 问题

完成配网后，设备每次启动 BLE 采集即崩溃重启（5 分钟 10 次）：
`npl_freertos_sem_init` / `ble_hs_init` / `ble_hs_event_start_stage2`
断言（分配失败型）。

## 定位（全部为本机实测，非推测）

| 步骤 | 证据 |
| --- | --- |
| 堆插桩（`ff37974`） | BLE 重建前 free≈62 KB、最大块 24 KB；历史最低 1.7 KB（TLS 峰值） |
| 堆门禁实验 | 阻止低内存断言，5 分钟零复位，但采集仍无法启动 |
| 任务级插桩 | `nimble_port_init` 单次消耗约 60 KB（61,536→1,136 B），host 任务创建失败 rc=-1 |

结论：无 PSRAM 的 ESP32-C3 上，Wi-Fi 驱动 + TLS 会话与 NimBLE 主机+控制器
**不能同时驻留内存**。与旧固件 2026-10-24 的实测注释（BLE 常驻后 Wi-Fi
初始化内存不足）一致；v2 的共存假设在该板上不成立。

## 修复（本分支）

- `cp_runtime` 增加射频相位机：`RADIO_NETWORK`（Wi-Fi 独占：联系/租约/上传，
  禁止启动 BLE）与 `RADIO_COLLECT`（Wi-Fi 完全拆除后重建 BLE 扫描）。
- 切换：采集满 60 秒、有积压或租约不足 30 秒 → 网络相位；网络相位 8–45 秒，
  上传排干后回到采集。网络重启失败时在剩余租约内恢复采集。
- `cp_pipeline` 保留堆门禁作安全网（低内存时优雅失败，绝不进断言路径）。
- sdkconfig 削峰：Wi-Fi 动态收/发缓冲 32→16、RX BA 6→3、mbedTLS 收包
  16 KB→8 KB。

## 验证（5 分钟，14:19–14:24 CST）

- 设备：两个完整 采集→网络→采集 循环；BLE discovery 正常启动；
  0 断言、0 异常复位、0 看门狗；Wi-Fi 拆除后堆回升至 ~110 KB。
- 后台：`config_state=applied`、`activation=applied`、
  `applied_config_id=cfg-cp4c11ae2fd82c-ct-01`、`contact_state=recent`；
  网络相位联系时如实上报 `capture_state=paused`。
- 原始日志：`captures/ai-passport-v2-exclusive-20261025.log`（本地忽略）。

## 残留边界

- 每个网络相位 BLE 暂停约 15–45 秒；扫描暂停尚未计入状态上报（待补）。
- 批量 ACK 逐条对账、断网/断电恢复、30 分钟以上长跑未做。
- DIAG 日志为取证用，合入 main 前应降级或移除。
- 第二台 Passport、T-Energy-S3、墨水屏板均未验证。

## 长跑与存储水位观察（同日，约 11 分钟，被人工中止）

三次服务端 node_status 对账（设备 uptime 206 s / 351 s / 616 s）：

| 指标 | T1 | T2 | T3 |
| --- | --- | --- | --- |
| storage_free_bytes | 2,064,384 | 1,683,456 | 1,474,560 |
| 待传 address_summaries | 170 | 200 | 215 |
| 待传 ble_windows / node_status | 2 / 1 | 3 / 1 | 4 / 2 |
| upload_failures（瞬时，均重试） | 2 | 7 | 10 |
| ack_failures / storage_drops / 各类丢失 | 0 | 0 | 0 |
| address_table_overflow_reports | 1,260 | 2,805 | 4,067 |

解读：

- 修复有效：全程无复位无断言；ACK 精确对账零失败、存储零丢失。
- **写满风险真实存在**：台架环境 MAC 轮换密集，64 键地址表持续溢出
  （溢出报告只计数不入库），摘要产速远超上传排干速度。前 3.4 分钟净写入
  ~10 KB/s，随后降至 ~2.6 KB/s → ~1.0 KB/s（网络相位在追积压，趋势收敛
  但未达平衡）。4 MB 队列已用 63%，越过策略 warn 60%；按当前速率
  约 24 分钟后写满，热点中断则更快。overload_action 仅为 pause_raw，
  raw 已关，写满前没有更强的刹车。
- 建议（后续，需与管理者对齐）：积压时延长网络相位直到排干而非 45 秒
  硬上限；高水位时暂停扫描入新窗口；或降低摘要粒度（bin 10 s）。
- 长跑日志因采集中止方式丢失（脚本在键盘中断时未落盘缓冲），
  服务端三次快照已存档于 `captures/soak-check-*.json`。

## TLS 连接复用实验（已回退）

为提升上传吞吐，尝试了网络相位内复用 keep-alive TLS 连接（每请求握手
2–5 秒是当时最大开销）。真机结果：复用时上一响应被提前中止读取的
残留字节卡死后续请求，设备 5 分钟连续读取超时、策略请求无法完成，
屏幕停在 wait policy。已回退该实验，恢复到「相位机 + 门禁 + 削峰」版本
并重新烧录验证 5 分钟：循环正常、零断言零复位，服务端确认
`config_state=applied`，且回退后网络相位把积压从 309 批排到 177 批、
Flash 剩余从 196 KB 回升到 2.0 MB——排干能力本身不差，瓶颈在相位
时长与积压策略。

正确实现连接复用的前提：响应必须读取完整（或干净关闭残余流）后才能
复用连接；现有的"HEAD 提前中止读取"技巧与复用不兼容。留作后续优化。
