// font_zh.h —— 20x20 1bpp 点阵字（ASCII + 界面中文子集，粗体）。由 gen_font.ps1 生成，勿手改。
#pragma once
#include <stdint.h>

#define FONT_ZH_CELL 20
#define FONT_ZH_ROW_BYTES ((FONT_ZH_CELL + 7) / 8)
#define FONT_ZH_GLYPH_BYTES (FONT_ZH_CELL * FONT_ZH_ROW_BYTES)
#define FONT_ZH_COUNT 210

extern const uint8_t  font_zh_data[FONT_ZH_COUNT * FONT_ZH_GLYPH_BYTES];
extern const uint32_t font_zh_cps[FONT_ZH_COUNT];   // 升序码点表，二分查找
extern const uint8_t  font_zh_adv[FONT_ZH_COUNT];   // 步进宽（字腔右留白会被吃掉）

// 找到返回指向 FONT_ZH_GLYPH_BYTES 字节位图的指针并回填步进宽，
// 缺字返回 NULL（调用方画占位框）。
const uint8_t *font_zh_glyph(uint32_t cp, uint8_t *adv);
