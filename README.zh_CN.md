# CampusPulse

[English](README.md) · [体验原型](https://pulse.anend.net) · [文档索引](docs/README.md)

CampusPulse 是我们为华中师范大学（CCNU）做的校园观察地图，起点是校园蓝牙
热力图，后来结合华师已有的 GIS、电瓶车停车和候梯问题，加入了设备端的电瓶车
自动识别、候梯区蓝牙事件分析和时间回放。

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

电瓶车现在由设备根据蓝牙广播自动识别。固件解析车厂名称、已知车用模组的厂商
标识等信息，排除已知的手机、外设和办公设备特征，再结合持续在场情况统计车辆。
有明确车辆特征的结果和待确认设备分开，相关规则见
[设备端识别代码](firmware/ai-passport-radar/main/veh_rules.c)。

停车信息以自动识别为主，人工录入保留作补充和核对，不需要逐辆手工确认。这里
统计的是规则识别到的车辆，不是把附近所有蓝牙设备都算成电瓶车。

另一个想解决的问题是电梯等待时间。我们用电梯口的蓝牙观测，检查一批此前稳定
出现的信号是否在接近的时刻一起消失，据此自动找出可能的上梯事件，再分析候梯
情况随时间的变化。目前规则已经能输出候选事件；从这些线索估算实际等待时长，
还需要结合现场数据校准，事件确认所花的时间不能直接当作候梯时长。

我们还加了一条实时和历史共用的时间轴。采集的数据上传后，可以回看同一地点
前后的变化，确认哪些时段有记录、哪些时段缺数据。

![CampusPulse 模拟演示：校园地图与地点详情](docs/images/simulation-desktop.png)

*模拟演示截图。底图来自华师 GIS，人物、车辆和灯光为示意。*

## 页面怎么用

选择一个地点，查看最近的观察；拖动下方横向时间轴，或点击记录标记，就能停在
选定的历史时刻。点击**返回实时**，继续查看最新数据。

<table>
<tr>
<td width="72%"><img src="docs/images/live-timeline-desktop.png" alt="桌面现场观察界面：来源卡片与连续时间轴" /></td>
<td width="28%"><img src="docs/images/replay-mobile.png" alt="手机现场观察界面：游标停在历史时刻" /></td>
</tr>
<tr>
<td>桌面：查看最近观察与同一条时间轴。</td>
<td>手机：停在历史时刻回看。</td>
</tr>
</table>

*这两张界面截图使用测试数据，地点标有“样例”，不是现场实录。*

[截图来源与复现方法](docs/notes/readme-screenshots.md)。

## 体验原型

- [**现场观察**](https://pulse.anend.net/?mode=field)：跟随最近数据，拖动时间轴回看保留历史，再返回实时。
- [**模拟演示**](https://pulse.anend.net/?mode=demo)：探索教学日、周末与雨天的合成场景、活动和动画。

线上原型可能落后于当前代码。现场观察只显示上传的记录，没有数据就留空；
模拟演示用于体验界面，两边的数据分开。

现场时间轴默认显示最近 1 小时，可选 15 分钟／1 小时／24 小时。每类来源最多
返回最新 200 条，截断会明确提示，因此选择 24 小时不代表获得完整录制。真实数据
回看目前依赖在线 API，没有离线文件播放器或自动播放；旧的 `?mode=replay`
链接仍会打开同一条时间轴，停在最新保留记录。

地图只标出已核验位置的采集点，底图上的建筑不代表都有传感器。尚未定位的地点
仍可在数据选择器中查看记录。

## 当前进度

Passport 固件已有蓝牙电瓶车自动识别、配网、策略控制、BLE 聚合与缓存上传。
网页包含地图浏览、实时与历史共用时间轴、人工补充记录与独立模拟演示；云端提供
设备数据接收、持久回执和私有研究存储。

本页截图对应的前端版本目前展示 BLE 汇总窗口，尚未将设备端车辆分类结果接入
地图详情；设备自动识别能力与网页显示内容分别说明。候梯区自动事件识别已在
[候梯开发分支](https://github.com/Aiaid/CampusPulse/tree/codex/elevator-cohort-events)
实现，尚未合并到本页截图对应的版本，也还不是自动预测等待秒数。

接下来要拿设备到现场核对采集、联网和上传，再看记录是否足够支持回放。
准备步骤放在[采集清单](docs/notes/hackathon-delivery.md)，后续安排见[路线图](docs/design/ROADMAP.md)。

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
- [管理账号初始化](docs/specs/admin-auth-v1.md)与[固件链路](docs/notes/firmware-chain.md)
- [CI/CD 与部署](docs/notes/ci-cd.md)
- [来源与复用边界](docs/notes/reuse.md)、[协作约定](AGENTS.md)与[完整文档索引](docs/README.md)
