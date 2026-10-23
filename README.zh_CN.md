# CampusPulse

[English](README.md) · [文档索引](docs/README.md) ·
[路线图](docs/design/ROADMAP.md) · [黑客松方案](docs/design/hackathon-plan.md)

CampusPulse 探索用 BLE 观测描述校园不同地点的活动变化。本公开仓库从新的基线
开始黑客松实现。

## 起点

当前已开始实现 React/Three.js 前端、华师 GIS 瓦片底图，以及 Cloudflare Workers/D1
地点查询与人工观察接口。可在本地运行，步骤见[开发说明](docs/notes/development.md)。
固件、BLE 上传、原始 R2 存档与硬件验证尚未实现；未部署云端服务。

拟定 MVP 组合两个固定 BLE 观测节点、人工停车与候梯记录、校园地图和墨水屏
地点卡，明确区分传感器观测、人工记录与模拟数据。BLE 可见标识数量不能作为精确人数。

## 之前的工作

赛前原型用于参考设计思路和已知硬件约束。首次公开基线不包含旧应用代码、
部署配置、凭据、采集数据或数据库。旧版本的验证结果不能证明新实现已经通过验证。

后续按功能逐步重新实现。实际复用的代码必须先在[复用记录](docs/notes/reuse.md)
中注明来源、归属和许可证兼容性。

## 开发

先阅读[路线图](docs/design/ROADMAP.md)与[项目约定](AGENTS.md)。现有硬件为
AI Passport ×2、LILYGO T-Energy-S3 ×2、微雪 1.54 英寸墨水屏 ESP32-S3 板 ×1。
前端、API 和数据库全部放在 Cloudflare，拟采用 Workers Static Assets、Workers
和 D1。板卡具体版本、数据契约与验收标准仍需核实。
研究模式的原始上传增加私有 R2，详见[上传协议草案](docs/specs/ingest-v1.md)。

凭据与原始观测数据不进入 Git。Python 操作统一使用 `uv`，构建、自动测试和
真机验证分别报告。
