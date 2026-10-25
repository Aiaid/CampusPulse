// ui_mini.h —— 迷你直绘库：esp_lcd 横带渲染 + 1bpp 点阵字，替代 LVGL。
//
// 设计取向：这个设备的界面是"低频更新的仪表盘"（两个大数字 + 几行状态，
// 数据 400ms 才变一次），用不上 LVGL 的保留模式组件树。本库全部 RAM 只有
// 两块 240x4 横带缓冲（共 3,840 字节，乒乓防 DMA 串带，见 ui_mini.c 头注释），
// 无堆分配、无定时器，脏了才画、只画脏的。
//
// 用法：
//   1. ui_init(bsp_display_panel())；
//   2. 需要重画某块时调 ui_render(region, paint, user)，在 paint 里用
//      ui_* 图元按【全局坐标】画，库负责分带、裁剪和推屏。
#pragma once

#include "esp_err.h"
#include "esp_lcd_types.h"
#include <stdint.h>

#define UI_W 240
#define UI_H 320

// 24 位 RGB → RGB565。
#define UI_RGB(rgb) ((uint16_t)(((((rgb) >> 16) & 0xF8) << 8) | \
                                ((((rgb) >> 8) & 0xFC) << 3) | \
                                (((rgb) & 0xFF) >> 3)))

// 调色板（与效果图 radar-ui-mock.html 一致）。
#define UI_COL_BG       UI_RGB(0x12161C)   // 深灰底
#define UI_COL_FG       UI_RGB(0xE6EAF2)   // 主文字
#define UI_COL_SOFT     UI_RGB(0xC6CDDA)   // 次要文字
#define UI_COL_MUTED    UI_RGB(0x8A93A6)   // 标签 / 提示
#define UI_COL_DIM      UI_RGB(0x3D4657)   // "--" 占位
#define UI_COL_YELLOW   UI_RGB(0xF2C94C)   // 手机数 / 焦点
#define UI_COL_RED      UI_RGB(0xEB5757)   // 车数 / 危险
#define UI_COL_ORANGE   UI_RGB(0xF2994A)   // 等待 / 警示
#define UI_COL_GREEN    UI_RGB(0x2ECC71)   // 数量少（变色阈值见 page_radar）
#define UI_COL_TEAL     UI_RGB(0x35D0BA)   // 标题点 / 电量
#define UI_COL_ROW_BG   UI_RGB(0x1E2632)   // 焦点行底
#define UI_COL_DANGER   UI_RGB(0x2A1A1E)   // 危险焦点行底
#define UI_COL_LINE     UI_RGB(0x232B3A)   // 分隔线

esp_err_t ui_init(esp_lcd_panel_handle_t panel);

typedef struct { int16_t x, y, w, h; } ui_rect_t;
typedef void (*ui_paint_fn)(void *user);

// 把 region 分成若干 4 行横带，逐带调 paint 再推上屏（DMA 异步，乒乓缓冲
// 保证 paint 不会覆盖仍在传输的带）。region 会被裁剪到屏幕内；w/h<=0 直接返回。
void ui_render(ui_rect_t region, ui_paint_fn paint, void *user);

// ---- 图元：只在 ui_render 的 paint 回调内有效 ----

void ui_clear(uint16_t color);
void ui_fill(int x, int y, int w, int h, uint16_t color);

// 16px 点阵字（ASCII + 中文子集，见 gen_font.ps1 的字符表）。缺字画占位框。
void ui_text(int x, int y, const char *utf8, uint16_t color);
int  ui_text_width(const char *utf8);

// 60px 大数字（仅 '0'-'9' 与 '-'，变宽；"--"用来表示"没有结论"）。
void ui_digits(int x, int y, const char *s, uint16_t color);
int  ui_digits_width(const char *s);
