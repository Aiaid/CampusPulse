// page_radar.h —— 雷达页：手机数 / 电动车数 + 两个采样开关 + 全部清零。
//
// 这是 demo_scan.c 的直绘版重写：交互语义与之一致（UP/DOWN 移动焦点、
// OK 切换、双击 OK 切标定日志、焦点含 NONE 空位），UI 换成 ui_mini 直绘。
// 扫描/判定逻辑（scan_ble / scan_table / veh_rules …）一行不改。
//
// 与 demo_scan 的三处有意差异：
//   1. RESET 改为两段确认（再按一次才执行，UP/DOWN 或 3 秒超时取消）。
//      旧版不做确认的理由是"确认态会困住用户"——现在底部提示行会同步变成
//      "▲▼ 取消 OK 确认"，退出路径是明示的，理由不再成立；而误清空的代价
//      是车数要重新观察 10 秒，值得一次确认。
//   2. 诊断行（APPLE/GOOGLE、LIVE/RAW）不进界面——它是标定工具，串口
//      日志（双击 OK）仍然保留，标题栏会出现 LOG 标记提示日志开着。
//   3. 长按 OK 不绑定功能。开关机由机身左侧独立硬件电源键负责（硬件指南
//      §3：与 BSP 三枚 ADC 功能键相互独立），固件不重复造这条路径。
#pragma once

#include "bsp_button.h"

// 启动页面：创建 UI 任务并启动 BLE 扫描（scan_ble_start）。
// 必须先 ui_init() 成功。重复调用安全（只生效一次）。
void radar_page_start(void);

// 按键入口：由主输入任务调用（非按键回调上下文，允许做 SPI 绘制）。
void radar_page_key(bsp_btn_t btn, bsp_btn_ev_t ev);
