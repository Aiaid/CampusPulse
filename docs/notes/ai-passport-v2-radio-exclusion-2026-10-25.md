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
