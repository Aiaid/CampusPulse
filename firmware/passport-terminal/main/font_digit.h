// font_digit.h —— 60px 高 1bpp 大数字（0-9 与 '-'，变宽）。由 gen_font.ps1 生成，勿手改。
#pragma once
#include <stdint.h>
#include <stdbool.h>

#define FONT_DIGIT_H 60
#define FONT_DIGIT_COUNT 11

extern const uint8_t  font_digit_data[];
extern const uint16_t font_digit_off[FONT_DIGIT_COUNT];
extern const uint8_t  font_digit_w[FONT_DIGIT_COUNT];
extern const char     font_digit_chars[FONT_DIGIT_COUNT + 1];

// 找到返回 true 并填出位图指针与宽度；不支持的字符返回 false。
bool font_digit_glyph(char ch, const uint8_t **bm, uint8_t *w);
