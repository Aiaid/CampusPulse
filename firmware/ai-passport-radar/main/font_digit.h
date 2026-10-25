// SPDX-License-Identifier: OFL-1.1
// Copyright (c) 2014-2021 Adobe (http://www.adobe.com/).
// CampusPulse Raster: generated from Noto Sans CJK SC Bold 2.004.
// See firmware/fonts/{OFL.txt,COPYRIGHT.txt,manifest.json}.
// Regenerate with uv run firmware/tools/generate-fonts.py; do not hand-edit.
#pragma once
#include <stdint.h>
#include <stdbool.h>
#define FONT_DIGIT_H 60
#define FONT_DIGIT_COUNT 11
extern const uint8_t font_digit_data[];
extern const uint16_t font_digit_off[FONT_DIGIT_COUNT];
extern const uint8_t font_digit_w[FONT_DIGIT_COUNT];
extern const char font_digit_chars[FONT_DIGIT_COUNT + 1];
bool font_digit_glyph(char ch, const uint8_t **bm, uint8_t *w);
