// SPDX-License-Identifier: OFL-1.1
// Copyright (c) 2014-2021 Adobe (http://www.adobe.com/).
// CampusPulse Raster: generated from Noto Sans CJK SC Bold 2.004.
// See firmware/fonts/{OFL.txt,COPYRIGHT.txt,manifest.json}.
// Regenerate with uv run firmware/tools/generate-fonts.py; do not hand-edit.
#pragma once
#include <stdint.h>
#define FONT_ZH_CELL 20
#define FONT_ZH_ROW_BYTES ((FONT_ZH_CELL + 7) / 8)
#define FONT_ZH_GLYPH_BYTES (FONT_ZH_CELL * FONT_ZH_ROW_BYTES)
#define FONT_ZH_COUNT 141
extern const uint8_t font_zh_data[FONT_ZH_COUNT * FONT_ZH_GLYPH_BYTES];
extern const uint32_t font_zh_cps[FONT_ZH_COUNT];
extern const uint8_t font_zh_adv[FONT_ZH_COUNT];
const uint8_t *font_zh_glyph(uint32_t cp, uint8_t *adv);
