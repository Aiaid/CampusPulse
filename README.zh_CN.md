# CampusPulse

当前设备链路为 **V3 原生 MQTT/TLS → 杭州 EMQX → Cloudflare**，
设备仅凭匹配的 CF 应用层持久回执回收队列。当前 V3 应用通过物理 USB 设置，
历史蓝牙／热点接入路径已退役；保留 MQTT 身份和旧采集记录不会恢复旧设备协议。
详见 [V3-only 迁移记录](docs/notes/v3-only-migration-2026-10-31.md)、
[正式 MQTT 运维](docs/notes/mqtt-production.md)和[公开 CA 说明](firmware/certs/README.md)。
密码、私钥和配网材料不进入 Git；构建、部署和实际设备验收分别记录。

[English](README.md) · [体验原型](https://pulse.anend.net) · [文档索引](docs/README.md)

**Hackathon 截止时间：北京时间 2026 年 10 月 25 日 20:00（UTC+8，即 UTC 12:00）。**
仓库快照标签：[`hackathon-2026-10-25`](https://github.com/Aiaid/CampusPulse/tree/hackathon-2026-10-25)。
该标签保留历史前端及 README 快照，整理时间晚于上述截止时间；当前源码遵循 V3-only 迁移。

CampusPulse 是我们为华中师范大学（CCNU）做的校园观察地图，起点是校园蓝牙
热力图，后来结合华师已有的 GIS、电瓶车停车和候梯问题，探索车辆证据、候梯区
事件和时间回放。当前 V3 固件上传有界 BLE 小统计；车辆识别与等待时间估计仍需研究和现场校准。

## 从其他学校的蓝牙热力图说起

用蓝牙观察校园活动，已经有学校做过尝试。比如圣母大学的
[N-Distance](https://wireless.nd.edu/research/collaborative-intelligent-radio-systems-for-congested-wireless-environments/)，
通过参与者的手机位置和蓝牙相遇记录，生成校园接触热力图，用来观察哪些地方、
哪些时段接触较多。它需要参与者安装应用并携带信标。

也有更接近我们硬件方案的尝试：黑客松项目
[CrowdMap](https://devpost.com/software/crowdmap-2tqdch) 用 ESP32 扫描附近的
蓝牙广播，将统计结果上传到网页，展示随时间变化的热力图。

这些项目给了我们一个出发点：用蓝牙信号观察地点附近的活动，再把变化放到地图上。

## 结合华师的情况

华师已经有一套[官方校园 GIS](https://gis.ccnu.edu.cn/)，建筑、道路和地点都有
现成的底图。我们直接接入这张地图，把采集点和记录放到对应位置，方便按熟悉的
地点查看。

另一个考虑是电瓶车。学校在[南湖校区的安全检查报道](https://www.ccnu.edu.cn/info/1073/37372.htm)
中就提到过“难停、乱停”的问题，并提出改造、扩建停车位。对我们来说，除了看
哪里活动多，也想知道：某个停车点最近停了多少车，这个情况是什么时候看到的，
一天里又有什么变化。

当前 V3 固件提取有界 BLE 统计，并携带版本、质量与丢失计数。默认
`unclassified-v1` 规则将观测到的标识保留为 `unknown`，不会把附近每个蓝牙
设备认成车辆，也不会把标识数换算成人数或停车数量。早期 Radar 规则与已有采集
记录保留作历史研究证据，人工停车观察仍是独立的补充与核对来源。

候梯区蓝牙可见性变化可以提供研究用候选事件，但不能证明已经上梯或某个人等待
了多久。已完成的人工候梯记录作为历史参考，经过校准的自动等待时间仍不可用。

我们还加了一条实时和历史共用的时间轴。采集的数据上传后，可以回看同一地点
前后的变化，确认哪些时段有记录、哪些时段缺数据。

![CampusPulse 当前模拟演示：校园地图与图书馆详情](docs/images/hackathon-demo-desktop.png)

*模拟演示截图。底图来自华师 GIS，人物、车辆和灯光为示意。*

## 页面怎么用

选择一个地点，查看最近的观察；拖动下方横向时间轴，或点击记录标记，就能停在
选定的历史时刻。点击**返回实时**，继续查看最新数据。

<table>
<tr>
<td width="72%"><img src="docs/images/hackathon-field-desktop.png" alt="线上桌面现场观察：图书馆上传记录与推测场景" /></td>
<td width="28%"><img src="docs/images/hackathon-field-mobile.png" alt="线上手机现场观察：图书馆页面" /></td>
</tr>
<tr>
<td>桌面：查看已上传观察与同一条时间轴。</td>
<td>手机：查看同一线上现场观察界面。</td>
</tr>
</table>

*截图采自 2026 年 10 月 25 日截止时间之后的线上前端。现场卡片展示已上传记录，
保留原始时间和质量标记；人物、车辆动画是推测示意，按要求采用 2 倍绘制数量，
不代表实测人数或车辆数。*

[截图来源与复现方法](docs/notes/readme-screenshots.md)。

## 体验原型

- [**现场观察**](https://pulse.anend.net/?mode=field)：跟随最近数据，拖动时间轴回看保留历史，再返回实时。
- [**模拟演示**](https://pulse.anend.net/?mode=demo)：探索教学日、周末与雨天的合成场景、活动和动画。

线上原型可能落后于当前代码。现场观察保留最后上传的记录及原始时间、过期状态；
观测输入驱动演示渲染时明确标为推测场景，示意数值不会写成现场记录或补入历史缺口。

现场时间轴默认显示最近 1 小时，可选 15 分钟／1 小时／24 小时。每类来源最多
返回最新 200 条，截断会明确提示，因此选择 24 小时不代表获得完整录制。真实数据
回看目前依赖在线 API，没有离线文件播放器或自动播放；旧的 `?mode=replay`
链接仍会打开同一条时间轴，停在最新保留记录。

地图只标出已核验位置的采集点，底图上的建筑不代表都有传感器。尚未定位的地点
仍可在数据选择器中查看记录。

## 后台管理与数据链路

当前设备使用 **原生 MQTT/TLS → 杭州 EMQX → Cloudflare**。网关必须收到 CPV3
帧，返回精确匹配的 CF 应用层持久回执；broker 送达本身不足以回收本地队列。
为兼容已部署的 broker ACL，保留 `cp/v1` topic 命名，它不代表仍接受 V1 设备
载荷。MQTT 身份与私有配网材料不进入 Git。

[管理工作台](https://pulse.anend.net/admin)保留账号、Passkey、设备身份、地点部署、
站点设置和审计。V3 配置基于设备实际能力快照进行校验，发布不可覆盖的策略分配，
并等待设备明确 ACK。发布、设备确认、统计入库是不同状态；未上报 V3 能力的设备
不会被虚构一个能力配置。当前 V3 应用使用物理 USB，历史 BLE／设备热点接入已退役。

诊断与私有证据来自 V3 能力、分配、ACK、租约和已入库统计；缺失指标保留未知。
公开地图读取合格 V3 现场统计，保留原始 policy ID 和 assignment generation，
不回退到 V1/V2 传感器记录。人工观察仍独立保存。已有 V1/V2 D1 记录、回执和
私有 R2 对象完整保留；旧设备上传／控制接口返回 404，旧保留期清理停止。
保留历史数据不代表每类退役记录都有当前 UI 读取入口。

![历史管理工作台：样例设备联系和配置状态](docs/images/admin-overview.png)

*历史本地后台界面，使用浏览器内样例，名称标有“样例”。截图早于 V3-only 迁移，
不代表当前 V3 控制台或硬件验收结果。*

正常云端上传为小统计和状态，当前生产配置关闭云端 raw 和逐地址上传。
本地 TF 研究记录与独立受开关控制的私有 CPRAW 归档各有保管与验收边界。
D1 保存带版本的 V3 记录和持久回执；已有私有 R2 历史数据继续保留。

详见 [V3-only 迁移记录](docs/notes/v3-only-migration-2026-10-31.md)、
[V3 小统计契约](docs/specs/v3-small-statistics.md)和[管理账号安全](docs/specs/admin-auth-v1.md)。

## 共用固件与板级适配

当前联网应用是 [Waveshare V3](firmware/waveshare-v3/README.md)和
[T-Energy-S3 V3](firmware/t-energy-v3-trial/README.md)，共用有界 `cp_v3_*`
采集、统计、控制、队列和传输组件，各板的引脚、供电、显示与 Flash 布局独立。
两种应用均等待物理 USB 设置，并保留各自有界运行限制；这不代表五台设备已具备
无人值守部署固件。

| 板型 | 可用代码与验证状态 |
| --- | --- |
| FoloToy AI Passport / ESP32-C3 | BSP、字体、许可证与历史证据保留；V1/V2 联网应用入口已退役，不声称已有当前 C3 V3 应用。 |
| LILYGO T-Energy-S3 / ESP32-S3 | [V3 应用](firmware/t-energy-v3-trial/README.md)，有界统计、MQTT 与 checkpoint 恢复；早期生产 MQTT 验收仅对应当时所测镜像。 |
| Waveshare ESP32-S3-ePaper-1.54 V2 | [V3 应用](firmware/waveshare-v3/README.md)，本地 TF、MQTT 与中文 UI。“V2”是硬件版本，与已退役的设备协议无关。 |

![历史设备诊断界面：样例存储和队列](docs/images/admin-device-diagnostics.png)

*历史界面的示意测量，连同来源记录保留；早于 V3-only 诊断，不是实机测量。*

独立的[离线 raw recorder](firmware/waveshare-raw/README.md)、CPRAW 格式、BSP
与 V3 本地 TF 依赖继续保留。兼容读取旧 NVS 凭据用于保护设置，不恢复旧上传协议；
源码退役不会转换、重放或删除历史 Flash 队列。Passport 受保护数据和分区必须保留，
不能把其布局套到 S3 板，也不能整片擦除。

详见[固件说明](firmware/README.md)、
[T-Energy 有界运行时](firmware/t-energy-v3-trial/BOUNDED_RUNTIME.md)与
[生产验收记录](docs/notes/v3-production-release-2026-10-31.md)。

## 当前进度

网页保留官方 GIS、双地图、实时／历史共用时间轴、独立图层、人工观察和独立模拟。
示意人物、车辆和光照保留来源，不填补现场记录缺口。V3 传感器读取保留策略／分配
版本、时间、误差与质量；未知类别和人数估计仍为未知，候选事件不转换为实测候梯时间。

[早期有界生产验收](docs/notes/v3-production-release-2026-10-31.md)记录了两块板的
实际 MQTT、精确回执和计划重启 checkpoint 核对。本轮 V3-only 清理通过 1,170 项
仓库测试、生产构建、MQTT 网关／浏览器检查及新 S3 构建／host 验证。发布状态以
实际 main CI／部署工作流为准；本轮未重新刷机或对新镜像做实机验收。
历史 D1/R2 数据完整保留，退役范围为
旧设备协议与应用路径。长时间离线、任意断电、饱和负载、电池校准和现场推断验证
仍待完成。详见[迁移记录](docs/notes/v3-only-migration-2026-10-31.md)与
[路线图](docs/design/ROADMAP.md)。

## 黑客松提交与现场演示

当前硬件运行还不够稳定，持续采集与上传仍在调试。设备长期无人看管地放在露天
也容易被偷，因此目前采用有人值守、临时布置的方式演示。本次黑客松提交的原型
可随时联系安排现场演示，携带设备展示实际采集、校内 Wi-Fi 上传与网页查看流程。

![实际运行：图书馆现场观察与已上传记录时间轴](docs/images/field-operation-desktop.png)

*用户提供的实际运行页面截图。图中 16 个 BLE 标识已标注“已达上限”，不代表
16 个人，活动图标仅作示意；此时的候梯信息仍待观测。*

## 在本地运行

使用 **Node.js 24**，在仓库目录执行：

```sh
npm ci
npm run build
npm run db:migrate
cp .dev.vars.example .dev.vars
```

编辑已被忽略的 `.dev.vars`，将 `OPERATOR_TOKEN` 换成随机本地凭据。
需要管理后台初始化时，另外设置独立的 `ADMIN_TOKEN`；凭据不要进入源码或截图。

启动 API：

```sh
npm run dev:api
```

在另一个终端启动前端：

```sh
npm run dev
```

打开 [localhost:5173](http://localhost:5173/?mode=field)。Vite 将 `/api` 转发到
8787 端口的 Worker。新建本地数据库没有现场记录，可切换模拟演示体验视觉交互。
运行 `npm test` 与 `npm run build` 完成自动检查；更多配置见[开发说明](docs/notes/development.md)。

## 技术与文档

技术栈为 React 19、Vite、TypeScript/JavaScript 与 PixiJS/Canvas/CSS；前端与 API
使用 Cloudflare Workers Static Assets／Workers，数据库为 D1，研究原始数据使用
私有 R2。固件采用 ESP-IDF/FreeRTOS。GitHub 保存源码并运行 CI，Cloudflare 托管应用。

- [架构说明](docs/notes/architecture.md)与[网页 API](docs/specs/web-api-v0.md)
- [管理账号初始化](docs/specs/admin-auth-v1.md)与 [V3 固件](firmware/README.md)
- [V3 配置](docs/specs/device-v3.md)、[MQTT 契约](docs/specs/device-v3-mqtt.md)与[迁移边界](docs/notes/v3-only-migration-2026-10-31.md)
- [CI/CD 与部署](docs/notes/ci-cd.md)
- [来源与复用边界](docs/notes/reuse.md)、[协作约定](AGENTS.md)与[完整文档索引](docs/README.md)
