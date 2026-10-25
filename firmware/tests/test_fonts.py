"""Repertoire, storage/layout and executable API checks for the OFL glyphs."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
MAIN = ROOT / "ai-passport-radar/main"

def numbers(name, kind):
    text = (MAIN / name).read_text()
    body = re.search(rf"\b{kind}\[[^]]*\]\s*=\s*\{{(.*?)\}};", text, re.S).group(1)
    return [int(x, 0) for x in re.findall(r"0x[0-9a-fA-F]+|\b\d+\b", body)]

class OpenFontTests(unittest.TestCase):
    def test_open_license_and_generated_fingerprints(self):
        m = json.loads((ROOT / 'fonts/manifest.json').read_text())
        self.assertEqual(m['license'], 'OFL-1.1')
        self.assertIn('Adobe', m['copyright'])
        self.assertIn('SIL OPEN FONT LICENSE Version 1.1', (ROOT / 'fonts/OFL.txt').read_text())
        self.assertEqual(m['source']['font_sha256'], 'b5f0d1a190a7f9b43c310a8850630af12553df32c4c050543f9059732d9b4c0a')
        for file, expected in m['outputs'].items():
            self.assertEqual(hashlib.sha256((ROOT.parent / file).read_bytes()).hexdigest(), expected)
        self.assertEqual(hashlib.sha256((ROOT / 'fonts/codepoints.txt').read_bytes()).hexdigest(),m['text']['coverage_sha256'])

    def test_complete_original_repertoire_and_glyph_bounds(self):
        expected = [int(line[2:],16) for line in (ROOT/'fonts/codepoints.txt').read_text().splitlines() if line.startswith('U+')]
        cps = numbers('font_zh.c', 'font_zh_cps')
        data = numbers('font_zh.c', 'font_zh_data')
        advances = numbers('font_zh.c', 'font_zh_adv')
        self.assertEqual(cps, expected)
        self.assertEqual(len(cps),141)
        self.assertEqual(cps[:95],list(range(0x20,0x7f)))
        self.assertEqual(len(set(cps)),141)
        self.assertEqual(len(data),141*20*3)
        self.assertTrue(all(0 < a <= 20 for a in advances))
        for i,cp in enumerate(cps):
            glyph=data[i*60:(i+1)*60]
            self.assertEqual(any(glyph), cp != 32)
            self.assertTrue(all((glyph[y*3+2]&0x0f)==0 for y in range(20)))
            if cp != 32:
                occupied=[x for y in range(20) for x in range(20) if glyph[y*3+x//8]&(0x80>>(x%8))]
                self.assertLess(max(occupied),advances[i])

    def test_digit_offsets_and_three_digit_column(self):
        widths=numbers('font_digit.c','font_digit_w')
        offsets=numbers('font_digit.c','font_digit_off')
        data=numbers('font_digit.c','font_digit_data')
        self.assertEqual(len(widths),11)
        expected=0
        for width,offset in zip(widths,offsets):
            self.assertEqual(offset,expected)
            size=60*((width+7)//8)
            self.assertTrue(any(data[offset:offset+size]))
            expected+=size
        self.assertEqual(len(data),expected)
        self.assertLessEqual(max(widths[:10])*3+8,112)

    def test_compiled_lookup_api_and_unsupported_characters(self):
        source=r'''
#include "font_zh.h"
#include "font_digit.h"
#include <assert.h>
int main(void) {
    for (unsigned i=0;i<FONT_ZH_COUNT;i++) {
        uint8_t advance=0;
        assert(font_zh_glyph(font_zh_cps[i],&advance)==font_zh_data+i*FONT_ZH_GLYPH_BYTES);
        assert(advance==font_zh_adv[i] && advance<=FONT_ZH_CELL);
        assert(font_zh_glyph(font_zh_cps[i],0));
    }
    uint8_t width=99; const uint8_t *bitmap=0;
    assert(!font_zh_glyph(0x1f600,&width) && width==99);
    for (unsigned i=0;i<FONT_DIGIT_COUNT;i++) {
        assert(font_digit_glyph(font_digit_chars[i],&bitmap,&width));
        assert(bitmap==font_digit_data+font_digit_off[i] && width==font_digit_w[i]);
    }
    assert(!font_digit_glyph('\0',&bitmap,&width));
    assert(!font_digit_glyph('X',&bitmap,&width));
    assert(!font_digit_glyph('0',0,&width));
    assert(!font_digit_glyph('0',&bitmap,0));
    return 0;
}
'''
        with tempfile.TemporaryDirectory(prefix='cp-font-api-') as directory:
            p=Path(directory);(p/'font-test.c').write_text(source)
            subprocess.run([os.environ.get('CC','cc'),'-std=c11','-Wall','-Wextra','-Werror','-fsanitize=address,undefined','-I',str(MAIN),str(p/'font-test.c'),str(MAIN/'font_zh.c'),str(MAIN/'font_digit.c'),'-o',str(p/'font-test')],check=True,capture_output=True)
            subprocess.run([str(p/'font-test')],check=True,capture_output=True)

    def test_striped_raster_clipping_and_pending_dma_ownership(self):
        # Run the real renderer and fonts. The LCD stub retains the submitted
        # pointer through the next paint, just like asynchronous SPI DMA, and
        # checks that both same-call and next-call painting preserve its bytes.
        source = r'''
#include <assert.h>
#include <string.h>
#include "ui_mini.c"

static const uint16_t *pending;
static uint16_t pending_copy[UI_W * 4];
static size_t pending_bytes;
static unsigned calls, painted, pixels;
static int expected_x, expected_y, expected_w, expected_h, next_y;
static esp_lcd_panel_handle_t panel = (void *)1;

static uint16_t swap(uint16_t c) { return (uint16_t)((c << 8) | (c >> 8)); }
static void check_pending(void)
{
    if (pending) assert(!memcmp(pending, pending_copy, pending_bytes));
}

static uint16_t expected_pixel(int x, int y)
{
    uint16_t c = 0x1234;
    if (x >= 2 && x < 31 && y >= 3 && y < 24) c = 0xF800;
    if (x >= UI_W - 3 && y >= UI_H - 2) c = 0x07E0;
    // Text and digits cross several four-row stripes; derive expected ink from
    // their public bitmap layouts, independently of the renderer's clipping.
    uint8_t advance = 0;
    const uint8_t *glyph = font_zh_glyph('A', &advance);
    int xx = x - 11, yy = y - 7;
    if (xx >= 0 && xx < FONT_ZH_CELL && yy >= 0 && yy < FONT_ZH_CELL &&
        (glyph[yy * FONT_ZH_ROW_BYTES + xx / 8] & (0x80 >> (xx % 8)))) c = 0x001F;
    const uint8_t *digit = NULL;
    uint8_t width = 0;
    assert(font_digit_glyph('8', &digit, &width));
    xx = x - 49; yy = y - 11;
    if (xx >= 0 && xx < width && yy >= 0 && yy < FONT_DIGIT_H &&
        (digit[yy * ((width + 7) / 8) + xx / 8] & (0x80 >> (xx % 8)))) c = 0xFFFF;
    return swap(c);
}

static void paint(void *arg)
{
    assert(arg == &calls);
    check_pending();
    ui_clear(0x1234);
    ui_fill(2, 3, 29, 21, 0xF800);
    ui_fill(UI_W - 3, UI_H - 2, 10, 10, 0x07E0);
    ui_text(11, 7, "A", 0x001F);
    ui_digits(49, 11, "8", 0xFFFF);
    // Empty and negative-size rectangles must not touch the current stripe.
    ui_fill(0, 0, 0, UI_H, 0xFFFF);
    ui_fill(0, 0, UI_W, -1, 0xFFFF);
    painted++;
}

esp_err_t esp_lcd_panel_draw_bitmap(esp_lcd_panel_handle_t handle,
                                   int x0, int y0, int x1, int y1,
                                   const void *data)
{
    // Polling commands drain the preceding transfer only after paint returns.
    check_pending();
    assert(handle == panel);
    assert(x0 == expected_x && x1 == expected_x + expected_w);
    assert(y0 == next_y && y1 > y0 && y1 <= expected_y + expected_h);
    assert(y1 - y0 <= 4);
    const uint16_t *p = data;
    if (pending) assert(p != pending);
    for (int y = y0; y < y1; y++) {
        for (int x = x0; x < x1; x++) {
            assert(*p++ == expected_pixel(x, y));
            pixels++;
        }
    }
    pending = data;
    pending_bytes = (size_t)(x1 - x0) * (y1 - y0) * sizeof(uint16_t);
    memcpy(pending_copy, data, pending_bytes);
    next_y = y1;
    calls++;
    return ESP_OK;
}

static void render(ui_rect_t region, int x, int y, int w, int h)
{
    expected_x = x; expected_y = y; expected_w = w; expected_h = h;
    next_y = y;
    unsigned before_calls = calls, before_painted = painted, before_pixels = pixels;
    ui_render(region, paint, &calls);
    assert(next_y == y + h);
    assert(calls - before_calls == (unsigned)((h + 3) / 4));
    assert(painted - before_painted == calls - before_calls);
    assert(pixels - before_pixels == (unsigned)(w * h));
    check_pending();
}

int main(void)
{
    assert(sizeof(s_buf) == 3840);
    ui_render((ui_rect_t){0, 0, UI_W, UI_H}, paint, &calls);
    assert(!calls); // No initialized panel.
    assert(ui_init(NULL) == ESP_ERR_INVALID_ARG);
    assert(ui_init(panel) == ESP_OK);
    render((ui_rect_t){0, 0, UI_W, UI_H}, 0, 0, UI_W, UI_H);
    render((ui_rect_t){-3, -5, 10, 14}, 0, 0, 7, 9); // Three stripes.
    render((ui_rect_t){9, 7, 37, 1}, 9, 7, 37, 1); // Next-call pending DMA.
    render((ui_rect_t){48, 10, 43, 63}, 48, 10, 43, 63); // Final partial stripe.
    render((ui_rect_t){UI_W - 3, UI_H - 2, 12, 9}, UI_W - 3, UI_H - 2, 3, 2);
    unsigned before = calls;
    ui_render((ui_rect_t){0, 0, 10, 10}, NULL, NULL);
    ui_render((ui_rect_t){UI_W, 0, 10, 10}, paint, &calls);
    ui_render((ui_rect_t){0, UI_H, 10, 10}, paint, &calls);
    ui_render((ui_rect_t){-20, -20, 10, 10}, paint, &calls);
    ui_render((ui_rect_t){0, 0, 0, 10}, paint, &calls);
    ui_render((ui_rect_t){0, 0, 10, -1}, paint, &calls);
    assert(calls == before);
    check_pending();
    return 0;
}
'''
        with tempfile.TemporaryDirectory(prefix='cp-ui-raster-') as directory:
            p = Path(directory)
            (p / 'esp_attr.h').write_text('#pragma once\n#define DMA_ATTR\n')
            (p / 'esp_err.h').write_text('''#pragma once
typedef int esp_err_t;
#define ESP_OK 0
#define ESP_ERR_INVALID_ARG 0x102
''')
            (p / 'esp_lcd_panel_ops.h').write_text('''#pragma once
#include "esp_err.h"
#include "esp_lcd_types.h"
esp_err_t esp_lcd_panel_draw_bitmap(esp_lcd_panel_handle_t, int, int, int, int, const void *);
''')
            (p / 'ui-test.c').write_text(source)
            compiled = subprocess.run([
                os.environ.get('CC', 'cc'), '-std=c11', '-Wall', '-Wextra', '-Werror',
                '-fsanitize=address,undefined', '-fno-omit-frame-pointer',
                '-I', str(p), '-I', str(ROOT / 'tests/ui'), '-I', str(MAIN),
                str(p / 'ui-test.c'), str(MAIN / 'font_zh.c'), str(MAIN / 'font_digit.c'),
                '-o', str(p / 'ui-test'),
            ], capture_output=True, text=True)
            self.assertEqual(compiled.returncode, 0, compiled.stderr)
            rendered = subprocess.run([str(p / 'ui-test')], capture_output=True, text=True)
            self.assertEqual(rendered.returncode, 0, rendered.stderr)

if __name__ == '__main__':
    unittest.main()
