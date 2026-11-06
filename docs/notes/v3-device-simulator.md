# V3 本地模拟设备

状态：本地软件联调工具。运行真实应用 Worker、CPV3 网关、RPC Durable Object、
服务绑定和独立临时 D1；Broker 收发由本机模拟。默认活动为合成数据，也支持明确标记的
历史 CPRAW 统计回放；默认属于 `controlled_test`。显式 `--view live` 可把合成虚拟
设备接入隔离本地环境的正常 live 链路，不代表当前现场、硬件或生产原生 MQTT/TLS
验收。历史回放不能用于此 live 模式。

## 启动

使用项目的 Node 24 和锁定依赖：

```sh
npm ci
npm run dev:simulator
```

打开 <http://127.0.0.1:5174/__simulator>。一个命令同时启动控制台、Vite 前端、
真实本地 API 和 `sim-v3-01` 模拟设备，无需另开 `dev:api`、迁移数据库或配置
`.dev.vars`。端口占用时直接失败，不接管已有服务：

```sh
npm run dev:simulator -- --port 5194 --window-ms 30000 --scenario busy
```

`--window-ms` 支持 `1000`（默认联调加速）、`30000`、`60000`。1 秒是合成统计窗口，
UTC 与租约仍使用实际时间，不修改服务器时钟或协议校验。

只监听 `127.0.0.1`，请使用命令打印的完整地址；控制操作检查 Host 和同源 Origin。
`Ctrl+C` 停止本次环境。每次启动都创建新的临时数据库、随机凭证和启动身份；
不会读取现有设备凭证、生产环境配置、采集记录或 Wrangler 本地数据库。

## 用虚拟设备调试正常 live 界面

```sh
npm run dev:simulator -- --view live --scenario busy
```

打开 <http://127.0.0.1:5174/?mode=field&place=library>。此时它就是一台虚拟设备：
正常登记能力、接收策略、提交应用 ACK、续租和上传小统计；正常现场 API 从本次独立
临时 D1 读取数据，前端使用与实体设备相同的 live 卡片、刷新和历史时间轴，无额外
模拟数据读取分支。控制台可切换安静、繁忙、丢失和离线，观察后续窗口变化。

仅这个明确启用的本地启动模式使用 `field` / `site_observation` 策略和批次。
`synthetic-statistics/1` 能力声明、软件板型和后台数据来源仍标记合成设备；它不是
生产采集。没有放宽生产 API 的数据集筛选，也不连接生产数据库、EMQX 或实体设备。
默认受控测试、历史 CPRAW 回放继续保留原有隔离；`--view live` 与 `--replay` 互斥。

## 控制场景

| 场景 | 行为 |
| --- | --- |
| 安静 `quiet` | 每 bin 2 个合成可见标识、4 个 worker 报告 |
| 繁忙 `busy` | 每 bin 12 个合成可见标识、48 个 worker 报告 |
| 模拟丢失 `loss` | 注入 callback/aggregation 损失、扫描缺口及对应质量位 |
| 离线 `offline` | 暂停网络请求；保留一个窗口和一个状态批次，队列满或租约过期后暂停采集 |
| 故障 `failed` | 发布新一代受控策略并由模拟设备提交真实 `resource_exhausted` 失败 ACK |

离线后切回安静或繁忙可观察原始冻结批次补传。退出故障场景会发布另一代策略，
成功 ACK 后恢复。重启按钮创建新 boot 并发布绑定该 boot 的策略，保留本次数据库历史；
未取得匹配回执的数据或控制请求会阻止重启。停止整个进程会清空本次临时环境。

上传失败按所属策略的最小延迟、指数退避、最大延迟和次数重试；达到上限仍保留
冻结字节。修复问题后点击“重试冻结批次”重新允许尝试，不改变批次身份或内容。
右侧显示实际设备状态、序号、待发哈希、重试/损失计数、不可用原因和网关请求数。

## 前后端联调

点击“自动登录本地管理后台”，进入“设备管理”，打开“V3 模拟设备（合成测试）”：

1. “V3 能力与应用状态”显示合成能力、期望 generation 和设备 ACK。
2. “V3 运行诊断”和“V3 上传与保管回执”显示真实本地 D1 中的统计、质量和回执。
3. 选择 `sim-v3-library` 部署和“受控测试”（本地 live 模式选择“现场”），
   可以准备、校验并发布下一代策略。
   后台默认生成 60 秒或 30 秒窗口；调试时也可在策略 JSON 中改为
   `window_ms:1000`、`bin_ms:1000`，再校验、发布。
4. 发布后刷新设备状态，确认已应用 generation；发布成功本身不是设备应用成功。

默认模拟器只接受受控测试；显式本地 live 模式只接受匹配的 `field` /
`site_observation`。两者都要求原始记录关闭、仅窗口统计和状态上传。后台发布的不匹配
数据集、原始上传或事件报告策略会得到失败 ACK。允许声明 rolling 且 `report_mode:off` 的
策略以调试后台默认配置；不实现实际 BLE 历史跟踪或候选事件生成。

调试登录会签发独立的真实管理员会话，不修改生产认证代码。退出后可从控制台再次
登录；需要新的近期认证会话时同样重新进入此入口。模拟账号没有可用密码，账号密码、
Passkey、凭证轮换和 USB 配网不是本工具的验收范围。

“查看前台”打开同一本地 API 支持的正常现场前端。默认模式的 `controlled_test`
不会填入现场视图，可检查空态和隔离行为；显式本地 live 模式则使用上述虚拟设备的
本地 `field` 记录。`?mode=demo` 是独立的场景演示，不用于调试设备 live 链路。
设备统计和工程来源可在后台验证。BLE 可见标识不是人数，合成分类
保留为 unknown，未生成校准人口或车辆总数。

## 协议与持久性边界

模拟设备完成能力登记 → 配置 GET → 协商与应用/失败 ACK → 租约 → 小统计上传。
路径适配器将原始 JSON 包装为 CPV3 八字节头和现有 `cp/v1` 请求 topic，交给仓库原有
网关与 RPC 检查，通过私有 `MqttDeviceApi` 服务绑定访问真实后端。
回包按 topic 匹配并解码两字节状态；统计只有在完整 durable receipt 与冻结请求的
哈希、策略、boot、流及序号等全部匹配后才出队。没有后端验证绕过。

只有 Broker 输入与回复发布器使用本地软件替身：没有连接 EMQX、实际 MQTT socket、
TLS 握手或真实射频。设备能力中的 durable media 是模拟声明，实际待发队列仅存在
当前进程内；`queuePersistence:session-only`、`powerLossRecovery:false` 始终可见。
该工具不证明 Flash/TF 存储、任意断电恢复、设备容量或生产链路可用。

## 验证和实现位置

```sh
npx vitest run tests/v3-simulated-device.test.ts
npm run test:simulator
npm run build
```

运行时测试使用真实 workerd/D1 检查窗口校验、精确回执、丢失响应重试、退避上限、
离线恢复、失败 ACK 和租约。浏览器检查启动完整本地环境，覆盖五种场景、重启、
后台准备/校验/发布策略、退出后重登、回执关联、现场隔离、同源检查和手机布局。
浏览器验收阻断学校地图请求，地图服务可用性单独验证。

2026-11-06 本地 live 补全验证：10 项模拟设备测试、更新后的完整浏览器 smoke 和
TypeScript 检查通过。浏览器覆盖正常现场卡片从安静 2 个到繁忙 12 个标识的刷新、
同源 summary/history 接口、时间轴历史选择与返回实时、后台合成来源，以及原有受控
测试隔离。实际内置浏览器另核对繁忙 12 → 安静 2、历史 12 → 返回实时 2；学校 GIS
图块正常显示。没有提交、部署或生产数据变更。这些有限软件检查不证明真实设备、
射频、原生 MQTT/TLS 或持续可靠性。

- 启动和本地路由：[`scripts/v3-simulator.mjs`](../../scripts/v3-simulator.mjs)
- 设备运行时：[`scripts/lib/v3-simulated-device.mjs`](../../scripts/lib/v3-simulated-device.mjs)
- 控制页面：[`scripts/lib/v3-simulator-page.mjs`](../../scripts/lib/v3-simulator-page.mjs)
- 运行时测试：[`tests/v3-simulated-device.test.ts`](../../tests/v3-simulated-device.test.ts)
- 浏览器检查：[`scripts/v3-simulator-browser-smoke.mjs`](../../scripts/v3-simulator-browser-smoke.mjs)

复用来源见 [reuse](reuse.md)；正式协议见 [V3 MQTT](../specs/device-v3-mqtt.md)
与 [小统计](../specs/v3-small-statistics.md)。

## 喂入已保存的 CPRAW

先只读验证源文件，用固件同一份 `cp_v3_stats/stats.c` 生成统计。需要本机 C 编译器；
共享库只在临时目录生成，原始地址与 payload 不进入回放文件或日志：

```sh
uv run --no-project python scripts/prepare-v3-cpraw-replay.py \
  --input captures/raw-algorithm-study-20261029/source/segment-00.bin \
  --input captures/raw-algorithm-study-20261029/source/segment-01.bin \
  --input captures/raw-algorithm-study-20261029/source/segment-02.bin \
  --output captures/my-v3-replay/windows.json \
  --window-ms 1000 --windows 12 --offset-ms 373000

npm run dev:simulator -- --port 5175 --replay captures/my-v3-replay/windows.json
```

按同一 session 的实际顺序逐个传入 `--input`。导入器对所有文件校验两遍，包括选取区间
之外的帧；CRC 错误、截断、跨 session、重复/倒退序号或同类帧时间倒退均拒绝。
前向序号缺口单独报告。`--offset-ms` 从第一条报告向上对齐到毫秒后计算。
最多选 120 个完整窗口，支持 1 秒联调窗口和实际 30/60 秒窗口；不压缩源窗口时长。
输出目录为 0700、文件为 0600；使用新的输出路径，保留原有产物。

回放界面显示“历史采集 · 测试回放”，保留源单调时间、源文件哈希与原始 RTC 声明，
使用新的测试 boot/策略/租约和当前测试时间发送。原始采集时钟精度不提升为当前时钟
精度。扫描覆盖只由明确扫描/停止等事件建立；缺失时保持覆盖未知（0 毫秒并置质量位）。
`r` 和 `l` 的入口计数/损失指本次回放向统计核心交付的报告；原采集器累计计数单独保存，
不会替代每窗口原始丢失情况或证明空口完整性。

回放结束后不循环、不生成额外合成窗口。离线和故障控制仍可使用；繁忙/丢失合成场景
在历史回放模式下禁用。发布与来源窗口不匹配的 cadence 会收到失败 ACK。
重启可从来源第一窗重新回放，使用新 boot 和 generation，原数据库历史仍保留。

自动核对整条链路：

```sh
npm run test:replay -- --replay captures/my-v3-replay/windows.json \
  --output captures/my-v3-replay/acceptance.json --port 5196
uv run --no-project python -m unittest discover -s tests -p test_v3_cpraw_replay.py -v
```

验收启动独立本地环境，逐窗比较 C 核心产物和 D1 规范化记录，检查每条状态与回执、
原始/重映射时间边界、后台实际浏览器显示、回放终止及现场隔离。
退出后保留私有报告并关闭验收实例。后台列表有上限，所有窗口的完整比较直接读取
这个隔离 D1，不把有界页面误称为完整导出。已有真实数据结果见
[2026-11-06 验收](v3-data-replay-acceptance-2026-11-06.md)。
