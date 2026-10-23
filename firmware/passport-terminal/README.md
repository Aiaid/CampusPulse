# passport-terminal — CampusPulse AI Passport 现场记录终端

在 AI Passport（ESP32-C3，240x320 屏，三按键）上运行的人工观察记录终端：
选择地点 → 记录停车数量范围或候梯时长 → 通过 HTTPS 提交到 CampusPulse
Workers API（`docs/specs/web-api-v0.md`），本地确认与云端确认分开显示，
失败进入 NVS 待提交队列自动重试。

## 准备凭据

```powershell
Copy-Item main/term_cred.example.h main/term_cred_local.h
```

然后填入 Wi-Fi 名称/密码、API 地址和操作员令牌（Worker 的
`OPERATOR_TOKEN` 密钥）。`term_cred_local.h` 已被 gitignore，不会进仓库。

本地联调时 API 地址指向 `wrangler dev` 的局域网地址（HTTP 即可），例如
`http://192.168.1.10:8787`；生产环境用 Workers 的 HTTPS 地址。

## 构建与烧录

使用 ESP-IDF 5.5.3（现有 Passport 参考工具链）。首次构建会从组件注册表
拉取 `espressif/button`，需要联网。

```powershell
idf.py build
```

烧录必须遵守 AI Passport 布局约束：**禁止整体擦除 Flash**，`cardid`
分区（0x356000）是设备身份保护区。只烧三个分开的镜像：

```powershell
esptool.py --chip esp32c3 -p COMx -b 460800 write_flash `
  0x0     build/bootloader/bootloader.bin `
  0x8000  build/partition_table/partition-table.bin `
  0x10000 build/campuspulse-passport-terminal.bin
```

## 复用声明

`components/bsp`、`main/ui_mini.*`、`main/key_guard.h`、`main/font_*` 与
`tools/gen_font.ps1` 复用自赛前的 ai-passport 工程（MIT，FoloToy），
来源、修改与验证情况登记在仓库根 `docs/notes/reuse.md`。
界面、联网、提交与队列逻辑为本基线新写。
