# CampusPulse 上传协议 v1 草案

日期：2026-10-23。状态：**设计草案，尚无新固件/服务端实现**。
本文定义拟采用的行为，数值为应用自身的初始限制，不是 Cloudflare 平台配额。
参考[赛前二进制协议](../upstream/pre-hackathon/wire-v0.md)与
[车辆广播规则](../upstream/pre-hackathon/vehicle-rules.md)，不兼容旧 80 字节格式。
示例全部为合成数据；示例 MAC、名称、计数不来自现场捕获。

## 1. 决策：指标与证据并行

**设备可以上传指标，也可以上传 MAC 和蓝牙广播包。主接口从第一版就区分这两条
数据流，地图读取聚合指标，研究端保留逐包证据供重新解析。**

| 方案 | 保留什么 | 能做什么 | 缺失什么 |
| --- | --- | --- | --- |
| 只传指数 | 一个分值、算法版本及质量/采样信息 | 低带宽展示趋势 | 无法还原算法错误、包内容与地址变化 |
| 窗口聚合 | 报告数、可见标识数、RSSI 摘要、采集质量、可选指数 | 地图趋势、同节点时间比较 | 不能用新规则重新分析原始广播 |
| 地址窗口摘要 | 每个观测地址的次数、RSSI、名称/服务等摘要 | 研究重复出现与候选信号 | 仍丢失逐包变化；本版预留为后续独立流 |
| 逐包观测 | 时间、地址/类型、RSSI、报告类型、完整 AD 字节 | 重解析、版本化分类、受控对照 | 数据量大；仍不是实际人数/车辆数 |

推荐：产品节点始终上传窗口与状态；需要研究车辆特征的采样任务启用
**窗口＋原始包双流**。不把“只传最终指数”作为唯一长期数据契约。
初次实现支持窗口、逐包、状态三个流；地址摘要不混入逐包数组，后续单独扩展。

本协议适用于全部五台采集设备（T-Energy-S3 ×2、AI Passport ×2、微雪墨水屏板
×1），均先实现采集、持久缓存与直接上传，再增加交互/显示。板卡共用协议与核心
逻辑，分别配置分区、队列预算和批次大小；不因带屏幕就仅作下行终端。
详见[硬件设计](../design/hackathon-plan.md#2-五台硬件的分工)。

**存储优先约束：联网时边采边上传，离线日志只作为有界缓冲。** 原始流不等待
30 秒统计窗口结束，也不等待日志接近写满；发送调度、缓存水位和满空间处理
是协议的一部分，见第 12 节。持续确认吞吐若小于采集吞吐，再及时发送也会积压。

## 2. 模式、来源与采集配置

服务端为每个节点登记不可变的 `placement_id` 和 `capture_config_id`：

- placement 绑定地点和有效区间。移动节点创建新 placement；离线旧数据仍携带
  旧 placement，不能按节点今天的位置重新归属。
- config 记录扫描参数、重复过滤开关、原始采集策略、地址策略、配置版本、
  可写流、采集任务以及接收截止时间 `accept_until`。
- `metrics` 配置只接收窗口/状态；`research_raw` 配置额外允许逐包流。
  研究配置可使用真实 MAC；是否允许由节点/任务权限决定，不能由请求自行开启。
- `dataset` 是 `field`、`controlled_test` 或 `demo`。测试信标及模拟数据有独立
  配置与数据集；上传凭据只能写登记的数据集，不能靠客户端自报获得权限。
  受控信标标记来自已知试验配置，不能仅凭可伪造的广播内容认定身份。
- 原始采集为 `all` 或明确的确定性抽样，例如每 N 条选一条；抽样规则写入 config。
  指标和状态使用独立队列预算，原始流积压不能吞掉健康信息。

指标与原始包可能分先后到达。窗口必须说明原始选择、跳过、落盘失败数量；
“指标窗口已确认”不代表对应原始包已确认。

## 3. 地址策略

逐包记录的 `identity` 只能采用以下一种结构：

| scheme | 字段 | 含义 |
| --- | --- | --- |
| `mac` | `address`、`address_type` | 上传观测到的六字节地址，供受限研究使用 |
| `window_token` | `token`、`address_type` | 仅同节点、同启动、同窗口可关联的令牌 |
| `none` | 无地址字段 | 只研究包内容，不支持地址层关联 |

MAC 使用小写常规显示顺序，例如 `02:00:00:00:00:01`；适配器必须将 NimBLE
内部字节序转换一次，不能把字节反序当成不同设备。`address_type` 为
`public/random/public_identity/random_identity/unknown`，保留栈实际报告语义；
identity 类型不等于本系统完成了身份解析，不推断 IRK、真实身份或永久硬件地址。

令牌算法为 HMAC-SHA256，取前 16 字节，编码成 32 位小写十六进制：

```text
HMAC(K_node_identity,
  UTF8(node_id + "\n" + boot_id + "\n" + decimal(window_seq) + "\n" +
       address_type + "\n" + lower_case_mac))[:16]
```

密钥按节点独立配置，与上传凭据分开，绝不上传；所有分隔字段禁止换行。
令牌不能跨节点/窗口去重，也不能抵抗原始载荷自身携带标识的关联。
名称、厂商数据和 Service Data 可能包含可关联信息，因此隐藏/哈希 MAC **不等于
整条广播匿名化**。原始与解析后数据仍按同一私有研究权限处理。

## 4. HTTP 与公共信封

| 方法 / 路径 | 功能 | 权限 |
| --- | --- | --- |
| `POST /api/v1/ingest` | 三个流的可靠批次上传 | 每节点 bearer 凭据，限定节点/配置/流/数据集 |
| `GET /api/v1/device/config` | 查询已登记的配置、服务端上限和截止时间 | 同节点凭据；只读，不由服务端任意下发脚本 |
| `GET /api/v1/places/:id/summary` | 公众聚合指标和时效 | 公开、字段筛选后的只读接口 |
| `GET /api/v1/research/batches/:id` | 查询原始批次与解析/分类版本 | 独立研究员权限，禁止公开缓存 |

人工观察使用独立的 `POST /api/v1/observations`，不是 BLE 报告；其完整编辑与
纠错契约另定，不以此文宣称已经实现。浏览器操作员身份不能作为设备写入凭据。

上传要求 HTTPS 证书校验、`Content-Type: application/json`、
`Authorization: Bearer <device credential>`、`X-Body-SHA256: <hex digest>`。
hash 是**实际 UTF-8 请求体字节**的 SHA-256，不含 HTTP headers；它用于一致性
核对，不替代认证。v1 不接受压缩请求；不记录 Authorization 或完整请求体到普通日志。

公共信封：[窗口示例](examples/ble-windows.request.json)、
[原始包示例](examples/ble-reports.request.json)、
[状态示例](examples/node-status.request.json)。配套的
[合成配置](examples/capture-config.fixture.json)用于说明相同配置下三流的关联，
不是已经实现的配置接口响应。

| 字段 | 规则 |
| --- | --- |
| `protocol` | 固定字符串 `campuspulse/1` |
| `batch_id` | 设备生成 UUIDv4，批次落盘时固定；重试保持不变 |
| `node_id` | 预配置非 MAC 的逻辑 ID，1–64 个 `[a-z0-9_-]`；绑定凭据 |
| `boot_id` | 每次启动产生的新 UUIDv4，恢复队列保留旧 boot；不能复用旧启动 ID |
| `placement_id` / `capture_config_id` | 服务端登记的不可变 ID，字符集同 node_id |
| `dataset` | `field/controlled_test/demo`，与配置一致 |
| `stream` | `ble_windows/ble_reports/node_status`，每批只有一种 |
| `firmware_version` | 非空构建标识，最长 80 字符 |
| `items` | 同节点、boot、配置、流；协议硬上限 128 条、64 KiB；实际遵守该节点配置的更低上限。初始小板配置为 32 条、16 KiB |

结构字段采用白名单；未知字段/流/枚举以 422 拒绝，不悄悄忽略误拼。
升级通过新协议版本或明确的可选字段修订，不擅自复用旧字段含义。
数字必须有限，计数为整数；序号和时间不得使用浮点近似。
正文重复 JSON 键须拒绝，不能让不同解析器取不同值。

每条 `seq` 从 1 开始，范围 1..4294967295，**按 boot＋stream 独立编号**。
耗尽后结束流并开启新 boot/session，不回绕。逐包 seq 在每个 host discovery
callback 时、过滤/排队前分配，故主动抽样、排队丢失也会形成可解释的序号间隔。
这是 host 报告序号，不是空口包序号。若 controller 自行过滤/丢失，seq 无法证明它。

批内 seq 严格递增，允许缺号。批次持久化后成员、次序与编码字节全部固定，
不能在重试时更新健康计数、UTC、配置或重新分包。

## 5. 时间与扫描口径

每条含 `time`：`mono_ms` 是启动以来毫秒整数，`utc_ms` 为 Unix UTC 毫秒或
`null`，`clock_epoch` 是本 boot 内校时段编号，`uncertainty_ms` 为非负估计或
`null`（未知）。未校时必须 `utc_ms=null`，不能填 0、收包时刻或主机当前时间。
发生 UTC 跳变/重校时时增加 epoch；单调时间仍用于排序。跨校时段窗口标记质量
异常，必要时不给 UTC。后续时间映射是额外派生数据，不修改已提交原记录。

服务器另存 `received_at`，只表示接收时间。补传和 UTC 未知数据不因为刚收到就
进入“当前活动”。未知 UTC 只能在明确的相对时间/未知时间视图呈现。

`scan_enabled_ms` 表示应用确认扫描器处于启用状态的累计时长，**不是实际 RF
接收时长**；扫描 interval/window 和共存调度造成的差异必须说明。协议不使用
无法直接测量的“有效空口接收时长”字段，也不承诺获取 RF 信道、CRC 或完整 PDU。

## 6. `ble_windows`：窗口、基础指标与可选指数

`seq` 即本 boot 的窗口号，窗口为 `[time.mono_ms-duration_ms, time.mono_ms)`。
建议时长 30 秒，允许 1–300 秒的部分窗口，注明提前关闭/暂停等质量标记。

| 字段 | 含义 |
| --- | --- |
| `duration_ms` | 实际窗口长度，1000..300000 |
| `scan_enabled_ms` | 0..duration_ms |
| `reports_seen` | callback 层收到的报告数 |
| `reports_aggregated` / `aggregation_drops` | 进入本窗口聚合的报告数 / 明确丢失数量 |
| `adv_reports` / `scan_response_reports` | 已聚合的 ADV 与 SCAN_RSP 数量，二者之和等于 reports_aggregated |
| `visible_identifiers` | 以观测地址＋地址类型去重后的窗口内数量，不上传集合本身 |
| `unique_table_capacity` / `unique_table_overflow` | 容量与溢出；溢出时数量只是已保留标识的下界 |
| `rssi` | 已聚合报告的有效 RSSI 样本数、min/max/mean；无有效样本时三项为 null |
| `raw_capture` | `mode`（off/all/sampled）、selected_reports、intentional_skips、pressure_skips、drops |
| `indices` | 可选数组：metric/value/unit/algorithm_id/calibration_id |
| `quality_flags` | 缺失、部分窗口、时间跳变、表满等明确信号，不能用 null 或零暗示正常 |

窗口关闭前应完成有界聚合清算，`reports_seen=reports_aggregated+aggregation_drops`；
队列中的报告必须按采集时的窗口标记归属。无法完成清算则不发布“完整窗口”，
上报状态中的窗口丢失/处理故障。已提交窗口不可原地补写。
RSSI 样本数不大于已聚合报告数；可见标识数不大于已聚合报告数。

raw mode 为 all/sampled 时，selected＋intentional_skips＋pressure_skips=reports_seen，
`drops` 是 selected 中未能进入持久队列的数量；mode=off 时这四项均为 0。
pressure_skips 是预先声明的空间背压策略暂停原始保存期间的报告数，必须单独
显示为原始覆盖缺失；它不是正常抽样，也不是已选中后才发生的存储失败。
raw ACK 可晚于窗口 ACK，raw 已排队数量不能伪装成已上传数量。
完整性检查还要对照后续 raw 批次与状态，不能只相信窗口自报。

第一种指数 `report_rate` 定义为 reports_aggregated / (scan_enabled_ms/1000)，
单位 `reports_per_scan_enabled_second`，算法 ID 为 `report-rate-v1`。
分母为 0 时不产生指数。它是观测速率，不是人数、密度或准确率。
0–100 相对活跃指数也允许，但须先登记可重现的算法、基线、参数、版本和单位；
没有校准依据不能只上传一个“拥挤 85”。不同设备/配置的分值不能天然比较。

各窗口 unique 不能相加成某时段 unique，更不能跨节点相加当人数。

## 7. `ble_reports`：MAC 与原始广播载荷

每条对应一个 host discovery report，必需字段：

| 字段 | 规则 |
| --- | --- |
| `seq` / `time` | 原始 callback 序号与采集时刻 |
| `window_seq` | 采集时归属窗口；允许原始包先于窗口到达 |
| `identity` | 第 3 节的三选一结构；与 config 权限一致 |
| `rssi_dbm` | -127..126 的整数；栈返回 unavailable 时为 null，不填成 127 dBm |
| `report_type` | adv_ind/adv_direct_ind/adv_scan_ind/adv_nonconn_ind/scan_rsp/unknown |
| `report_type_code` | 原栈类型的 0..255 数值，另由 config 声明 stack/adapter 版本 |
| `format` | v1 固定 `legacy_ad`；扩展广播以后另立格式 |
| `payload_length` / `payload_hex` | 0..31 字节与对应原始小写 hex，字节数必须精确相符 |

保留 callback 返回的 AD bytes，不裁名称、不只保留第一个厂商字段、不做内容去重。
相同内容反复出现也是多条观测；传输重试才做幂等。
SCAN_RSP 是单独记录，不拼进 ADV 形成一个虚构的“原始包”；主动扫描模式写在
config 中。若某 SDK 返回拼接数据，适配器必须按其明确边界拆分，无法还原则
不能冒充此格式。v1 legacy 的 31 字节限制是本项目范围，不宣称 BLE 本身都限于此。

**传输结构非法**（hex 错、长度不符、字段范围错）拒绝整批；**空口 AD 内容
畸形**则仍保存原字节，派生解析标记 malformed，分类返回 unknown。
不因为解析器看不懂或厂商未知就丢弃原始证据。

## 8. 解析与车辆候选是派生结果

由服务端从已保存的 payload 解析，不信任客户端附带的友好名称或分类结论。
研究查询至少返回下面这些字段，并保留源 batch/seq/解析器版本：

- 有序 `elements`：原 AD offset、type、完整 value hex；重复和未知 AD 元素保留。
- `names`：shortened/complete、本来的 name bytes，以及用于显示的 UTF-8 解码文本；
  非法 UTF-8/控制字符只影响显示，不修改证据，网页按文本转义。
- `service_uuids`：16/32/128-bit 来源与规范化 UUID；Service Data 与服务列表分开。
- `manufacturer_data`：公司 ID（小端 uint16）及后面的 vendor bytes，支持多项。
- `service_data`：UUID、原始 data bytes、offset；另保留 Flags、Tx Power、Appearance。
- `parse_status`、`parser_version`、`classification`、`ruleset_version` 和来源引用。

UUID 规范化使用小写标准 128-bit 表示；16/32-bit Bluetooth UUID 按 Bluetooth
base 展开。AD 内 UUID 字节按对应宽度小端转换，不能对整个包随意倒序。
AD 长度包含 type，不包含长度字节；0 结束，越界立即标 malformed。
厂商数据与 Service Data 的内部格式各不相同，不能把它们当同一类设备 ID。
Manufacturer 的 vendor 净长度不含 company ID 两字节，另保留原 AD 长度；
Appearance 必须按小端 uint16 解析。短/完整名称分别保留，不以先到的一条覆盖
后续完整名。相关规范字段应由独立 fixtures 覆盖，不能复制旧解析器后假定正确。

[派生结果示例](examples/ble-reports.derived.json)演示同一个合成原始包的解析。
其中 company ID `65535` 和 `NIU DEMO` 仅为构造输入，不是车型/厂商实测样本。

分类保留 `unknown/e_bike_related/car_related/vehicle_ecosystem`、
`confidence=none/low/medium`、`evidence[]`、`rule_id` 和版本；不把 confidence
当概率。未来规则可增加类别，但不能改写历史分类版本。
同一证据可保留多个候选结果，若 UI 需一个主类别，用独立版本化的优先级规则选择。

旧原型里可借鉴的弱线索包括名称前缀、特定服务 UUID 和厂商 company ID，见历史
规则文档；新系统尚未实现这些规则。单个公司 ID、通用电池/UART 服务、OUI、
RSSI 或随机地址都不能独立确认电动车。名称也能由手机伪装。
不默认连接 GATT、配对、主动查询车辆或发送车辆命令。
按地址合并多条证据时，应在独立派生视图中记录窗口、first_seen/last_seen、ADV
和 SCAN_RSP 数量、观察间隔、有效 RSSI 样本及跨报告证据引用；不能修改原报告。
原始流不按“像不像车”预过滤，否则会丢掉反例并使后续评估带选择偏差。
短载荷指纹＋RSSI 只能形成待验证的关联假设，不能自动合并物理身份；若要研究
跨窗口 dwell，应使用允许该关联的地址策略，window_token 无法跨窗关联。

一个示例广播即使名称是 `NIU DEMO`，也只可得到低置信名称候选，不能得出一辆车。
规则更新写新的派生结果并引用原记录，不改原包，也不追改设备窗口指标。
若基于原包重算窗口，应另存 calculation_id、覆盖率与输入范围，不能覆盖设备原值。

## 9. `node_status`：健康与损失

每批一条状态，仍使用同样的持久上传/ACK；允许降低发送频率或合并尚未封批的
状态，但必须计数 `status_samples_coalesced_total`。已封批数据不可重写。

最小字段：seq/time、uptime_ms、scan_state、wifi_state、free_heap_bytes、
queue_pending（按流）、queue_capacity（按流）、storage_free_bytes、
`loss_totals`、`raw_capture_state` 和 `buffer_health`。battery_mv 可缺省，禁止伪造未读取的电量。

buffer_health 至少包含实际配置的可用日志预算、已用/未确认/可回收字节、最近
采集与 ACK 字节速率、预估满空间秒数、压力等级和暂停原因。ACK 速率只计算
新确认的本地记录字节，重复 ACK 不重复增加吞吐。没有足够样本时速率/预测为
null，不用 0 或无限大的数字伪装成已知。原始暂停时间与 pressure_skips 分别记录。

loss_totals 按 boot 累计：aggregation_drops、raw_queue_drops、storage_drops、
windows_dropped、upload_failures、ack_failures、status_samples_coalesced、raw_pressure_skips。
主动抽样跳过另列，不计入故障丢失；暂停原因、日志满和上传失败分开。
可选报告 Wi-Fi 信号强度，不上传 Wi-Fi SSID、BSSID、账号、密码或设备 token。
原始报告序号间隔、设备自报 losses、控制信标自身序号三者分别解释，不能混算。

## 10. 幂等、持久性与 ACK

保留旧协议原则，但不能只看 HTTP 200 或 accepted 数字：

1. 同一 node＋batch_id 永远对应相同 bytes/hash。相同批次重试返回相同 durable
   receipt；同 ID 不同 hash 返回 409，不覆盖先前数据。
2. 同 node＋boot＋stream 的批次 seq 区间不得重叠（包含已跳过的内部空洞）。
   相同记录不得换 batch_id 重新分包。不同区间可以乱序到达；不能把最大 seq
   当作连续确认水位。服务端必须用数据库内的原子约束/事务验证重叠，不能仅
   在 Worker 里先 SELECT 再 INSERT，避免并发穿透。
3. 窗口和状态：全部验证后，D1 原子提交 records＋receipt，再响应。
4. 原始包：先写私有 R2 不可变对象，确认存储完成；再原子提交 D1 原始批次索引、
   seq 区间、hash 与 receipt。对象 key 含服务端节点命名空间、batch_id、body hash，
   使用条件创建并校验已有对象，禁止无条件覆盖。不同 hash 竞争产生的多余对象
   不能变成成功索引；D1 只允许一个获胜 receipt。
5. R2 成功而 D1 失败，返回 503，设备重试复用已有对象；这不是成功 ACK。
   可能留下未引用对象，清理器须通过 D1 中的批次状态与租期/并发保护协调清理，
   不能单凭一次“查不到 receipt”就删除正在提交的对象。
   MVP 可先禁用孤儿自动清理，定期核查后处理；不要假设 R2 和 D1 有跨产品事务。
6. 只有 R2（如适用）和 D1 receipt 都完成才 HTTP 200。
   分类可异步运行，ACK 不代表已分类成功。失败可重算原始证据。
7. 设备核对 node、boot、stream、batch_id、body_sha256、accepted_count 与
   durability=committed。全部精确匹配才将**该批**标为已确认；本地扇区所有记录
   确认后才能回收。200 HTML、202、数量不符、hash 不符均不能释放数据。

成功响应见 [ACK 示例](examples/ble-reports.ack.json)。`accepted_count` 包含
该批原已保存的记录；重复响应的 received_at/receipt_id 表示首次提交时刻与 ID。
原始批次不能返回对象公开 URL，研究读取必须走授权接口。

接收截止时间由服务器配置决定，不依赖设备 UTC。有效 receipt 保留到该配置
accept_until 之后至少 7 天，期间重复请求可获旧 ACK；过期且没有 receipt 的
旧配置返回 410，不能重新写回已清理的原始数据。设备保留未确认数据并暴露
policy_expired 状态，不能改配置 ID 冒充新采集或无限自动重试。

## 11. 错误与重试

统一 JSON：`error.code`、`error.message`、`error.retryable`、可选字段路径和
request_id。错误信息不回显 MAC、载荷或凭据；没有成功 receipt 就不回收队列。

| HTTP | code / 行为 |
| --- | --- |
| 400 / 415 | JSON、重复键、hash 或 Content-Type 错；停止该批自动重试，保留数据 |
| 401 / 403 | 凭据无效或节点/流/原始模式越权；等待修复配置 |
| 409 | batch_conflict / seq_range_overlap；隔离冲突并上报，禁止覆盖 |
| 410 | capture_config_expired；保留待处理数据，停止自动上传此批 |
| 413 | payload_too_large；验证在任何写入之前完成。明确确认拒绝后才能分成新批；网络超时则先重试原批确认状态 |
| 422 | schema/范围/配置不一致；保留并标错，不逐条部分接受 |
| 429 | rate_limited；遵守 Retry-After |
| 5xx / 超时 | 指数退避＋抖动，1、2、4…最多 60 秒；断网暂停，重连继续原批 |

批次全收或全拒；R2 的未引用对象不算可查询的部分接受。先解析/验证全部结构
再写存储。CPU/解析预算不足时应明确返回可重试错误，不能先 ACK 再补落库。
设备在生成批次前按节点/服务端双方上限选择批大小，C3 可采用小批与流式编码。
水位升高不绕过 Retry-After 或失败退避；上传故障时由背压限制新增原始数据。

## 12. 存储、访问和容量

- D1：节点/配置/placement、窗口、状态、receipt、原始批次索引、版本化派生结果。
  不为每个原始报告立即写一行数据库；原始正文按批次保留在私有 R2。
- 未知/未分类原始批次保持可检索。按任务手动触发研究解析，限制处理范围；
  不在 BLE callback 做 JSON/TLS，也不把大量解析工作塞进上传 ACK 的关键路径。
- 原始、名称、MAC、解析字段只对研究权限开放；公开接口不返回这些字段或 R2 key。
  公众活动趋势与原始研究权限分开。日志只记 ID/hash/计数/错误码。
- 初始建议：原始与含标识的派生结果接收后保留 24 小时，聚合 7 天，公众展示
  近 24 小时。任务可显式延长保留，但 config 必须记录；删除应涵盖原包和派生
  标识字段。receipt 只保留 ID/hash/范围等最小去重信息，不保留原始载荷。
- 采样和节流必须显式记录。环境假设每节点 100 reports/s，32 条/批，则至少约
  270,000 原始上传请求/天/节点；这只是容量算例，不是实测负载或套餐保证。
  低流量按时间触发小批。是否连续全量采集、研究突发采集或抽样，依据实测吞吐、
  内存、掉包与 CF 配额决定，不能用指数流的低数据量预算代替原始流预算。

### 12.1 发送触发：大小、时间、水位，任一满足就发送

建议初始参数，均待真机调整：

| 触发 | 建议行为 |
| --- | --- |
| 原始条数/字节达到目标 | 立即封批，交给上传 worker；上限取本节点与服务端的较小值 |
| 最旧未封批原始报告等待 1 秒 | 即使未满批也发送；1 秒是联网时的封批目标，不是网络交付保证 |
| 日志占用达到 60% | 请求尽快发送未封尾批，唤醒回收 worker，并进入积压告警 |
| 网络恢复 | 立即按 raw FIFO 排空旧批，按流保留控制消息调度机会；不等下一统计周期 |
| 窗口关闭 / 健康故障 | 窗口或诊断进入独立小批；正常状态约 30 秒，故障变化可提早发送 |

同一原始批已封存后不因水位变化而修改内容或 hash。每节点默认一个在途请求，
复用 HTTP/TLS；只有资源与服务端压力测试通过后才增加有限并发。
状态/指标有预留空间与调度预算，不能全被 raw 挤占；也不能频繁发微小诊断
使 raw 永远得不到发送机会。BLE callback 只计数和入队，不等待 HTTPS 或擦除。

节点配置增加 `upload_policy`，明确 max_items、max_body_bytes、flush_max_age_ms、
warn_pct、raw_pause_pct、critical_pct、resume_pct、overload_action。
S3 可在测量后采用更大批次（例如 128 条、64 KiB）减少请求与往返开销；C3
不要求分配同样大的 RAM 缓冲。调整 config 只影响新批，未确认旧批仍按旧配置重试。

### 12.2 本地保存紧凑记录，避免多份正文占空间

本地日志采用紧凑记录、必要索引与批次元数据；JSON 是上传编码，不要求额外
存一份展开后的完整 JSON。原始 AD 已足够重解析，不在板上重复保存所有友好字段。
PSRAM 和 RAM 都不算掉电可恢复空间。

若从紧凑日志重建请求，必须保留编码器版本与批次 hash，保证跨重启/升级的请求
字节完全一致；无法保证时才保存冻结后的请求字节。该取舍必须通过复现测试，
不能为了省空间破坏幂等。每批的本地记录/批次元数据确认持久化后才进入发送状态。

原始与低频控制记录按流组织页/扇区，减少一个未确认记录钉住大块已确认空间。
ACK 后后台及时持久化确认状态并回收；尾扇区虽未填满，但内容全部确认时，也应
支持先安全封闭再回收，不必等整片日志写满。未确认数据绝不参与擦除。
所有预算扣除应用、受保护分区、文件系统/索引和预留空间后计算，不能把标称
8/16 MB Flash 全部当采集容量；新板分区须单独核实。

### 12.3 水位与背压

建议阈值以**实际划给日志的容量**计算，并写入配置：

- 60%：告警、加速发送已有队列和回收，不改变采集语义。
- 80%：默认 `overload_action=pause_raw`，暂停接收新的原始保存任务，继续
  有预算的 BLE 聚合/状态与旧批上传；新增报告计入 pressure_skips，标明原始
  覆盖中断。需要完整逐包实验时可配置 `pause_scan`，暂停整个扫描并标明空档。
- 95% 或预留预算不足：停止新增采集，仍保留网络、确认与回收能力；不再启动
  会占满剩余空间的批次。不执行“覆盖最旧未确认数据”。
- 降到 40% 以下且网络恢复成功后，允许试恢复原始采集，配合冷却与滞回；
  若持续净增长仍为正，维持降级并要求调整吞吐/采样配置，不能宣称恢复全量。

初始可将日志预算至少 10% 留给窗口、状态及确认元数据，并为其分配独立上限；
精确容量取决于板卡布局与记录大小。预留也用尽时明确上报/显示采集暂停，
不允许无界堆分配。不自动只保留“像车”的包，以免丢掉反例；若采用抽样，必须
由配置声明并记录实际比例，和压力暂停、故障丢失分别统计。

### 12.4 按实测净增长估计还能撑多久

以包含日志/索引开销后的本地字节速率估算：

```text
growth_Bps = incoming_local_Bps - newly_acknowledged_local_Bps
time_to_full_s = writable_free_bytes / growth_Bps    # growth > 0 时
```

物理可回收字节与尚不能写入的已确认尾页分别报告；计算必须扣除当前写入/回收
约束和预留空间。尚未完成回收的 ACK 不直接冒充可写空间。
growth<=0 时返回 null 并注明 stable_or_draining；样本不足则 unknown。
暂停 raw 后还应显示暂停前采集速率，避免因为停止入流就显示系统“足够快”。

**仅算例：** 若每条实际占 100 B，100 条/s，完全断网时 1 MiB 可写空间约撑
104.9 秒，4 MiB 约 419.4 秒；不是本项目已测容量。若单在途、每次 ACK 往返
0.5 秒、32 条/批，理想发送上限也只有 64 条/s，仍会积压；需要较大批次、
减少开销或显式调整采样，而不只是把发送定时器调快。

### 12.5 持续上传验收

分别测不同板卡的实际记录占用、峰值入流、ACK 吞吐、回收速度、内存余量与
TLS 往返。联网稳定负载下必须观察到队列可控或净排空；断网后按已确认速率
验证恢复时间。主动测试慢服务端、429、R2/D1 故障、回收失败和日志临界水位，
确认在空间耗尽前执行已声明策略，并能对账暂停/抽样/丢失数量。

## 13. 实现前需通过的检查

- 两个请求并发重试/冲突时，不能产生两份有效 receipt 或覆盖原始证据。
- R2 成功 D1 失败、D1 成功响应丢失、设备 ACK 前后断电均可恢复。
- 校时跳变、未校时、补传、节点迁移、独立流 ACK 不错放时间/地点或提前释放。
- 畸形 AD 能存档，非法 envelope/hex 不能部分入库；ADV/SCAN_RSP 不被悄悄合并。
- MAC、token、none 三种 identity 与配置权限一致；公开接口和日志无原始标识泄露。
- raw 抽样与真实丢失可区别，窗口饱和和无数据不被转换成零人数。
- 原始封批不等待统计窗口；水位、预留空间、压力暂停、回收和恢复有实测证据。
- 用可控信标、不同名称/服务的合成包验证解析；车辆准确率另做人工匹配实验。

本文未提供已实现的 JSON Schema/OpenAPI，字段与跨字段约束以本文和示例为草案。
接口冻结时再生成机器 schema、解析器与契约测试，当前示例校验不代表服务通过验收。

## 14. 平台与规范参考

- [Bluetooth SIG Assigned Numbers](https://www.bluetooth.com/specifications/assigned-numbers/)：AD 类型、服务与公司编号的维护入口；编号归属不证明发射设备类别。
- [NimBLE GAP](https://mynewt.apache.org/latest/network/ble_hs/ble_gap.html)、[ESP-IDF 5.5.3 NimBLE](https://docs.espressif.com/projects/esp-idf/en/v5.5.3/esp32c3/api-reference/bluetooth/nimble/index.html)：报告来自主机栈，需按实际适配器字段验证。
- [Apache NimBLE AD parser](https://github.com/apache/mynewt-nimble/blob/master/nimble/host/src/ble_hs_adv.c)：Appearance 的 get_le16 处理等字段解析参考，仍需针对本项目写 fixtures。
- [D1 batch](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)：SQL 批次事务行为。
- [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)、[一致性模型](https://developers.cloudflare.com/r2/reference/consistency/)：条件写入和对象读写语义；不提供与 D1 的跨产品原子提交。
