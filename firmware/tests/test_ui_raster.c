/* Run the production renderer/fonts with a separate full-cell reference raster.
 * Work budgets count bitmap tests, not wall time, so slow/fast hosts agree. */
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include <stdint.h>
static uint64_t bitmap_visits;
#define UI_BITMAP_VISIT() (++bitmap_visits)
#include "ui_mini.c"
#include "page_status.h"

static uint16_t expected[UI_H][UI_W];
static bool compare_pixels = true;
static unsigned stripe_calls;

static void reference_pixel(int x, int y, uint16_t color)
{
    if (x >= 0 && x < UI_W && y >= 0 && y < UI_H) expected[y][x] = color;
}

static void reference_glyph(int x, int y, uint32_t cp, uint16_t color, uint8_t *advance)
{
    const uint8_t *glyph = font_zh_glyph(cp, advance);
    if (!glyph) {
        const int side = FONT_ZH_CELL - 2;
        for (int i = 0; i < side; i++) {
            reference_pixel(x + 1 + i, y + 1, color);
            reference_pixel(x + 1 + i, y + side, color);
            reference_pixel(x + 1, y + 1 + i, color);
            reference_pixel(x + side, y + 1 + i, color);
        }
        return;
    }
    for (int row = 0; row < FONT_ZH_CELL; row++)
        for (int col = 0; col < FONT_ZH_CELL; col++)
            if (glyph[row * FONT_ZH_ROW_BYTES + col / 8] & (0x80 >> (col % 8)))
                reference_pixel(x + col, y + row, color);
}

static void reference_text(int x, int y, const char *text, uint16_t color)
{
    for (; *text; text++) {
        uint8_t advance = 8;
        reference_glyph(x, y, (unsigned char)*text, color, &advance);
        x += advance;
    }
}

static void reference_digits(int x, int y, const char *text, uint16_t color)
{
    for (; *text; text++) {
        const uint8_t *glyph;
        uint8_t width;
        if (!font_digit_glyph(*text, &glyph, &width)) continue;
        for (int row = 0; row < FONT_DIGIT_H; row++)
            for (int col = 0; col < width; col++)
                if (glyph[row * ((width + 7) / 8) + col / 8] & (0x80 >> (col % 8)))
                    reference_pixel(x + col, y + row, color);
        x += width + 4;
    }
}

static void reference_scene(void)
{
    for (int y = 0; y < UI_H; y++)
        for (int x = 0; x < UI_W; x++) expected[y][x] = 0x1234;
    reference_text(-7, -8, "Wide A!", UI_COL_RED);
    reference_text(232, 10, "AB", UI_COL_GREEN);
    reference_text(-13, 111, "g/W", UI_COL_FG);
    reference_text(28, 213, "Banded text", UI_COL_TEAL);
    uint8_t advance = 8;
    reference_glyph(17, 83, 0x4e2d, UI_COL_FG, &advance);
    reference_digits(-6, 14, "8-2", UI_COL_YELLOW);
    reference_digits(220, 280, "90", UI_COL_RED);
}

static void paint_scene(void *unused)
{
    (void)unused;
    ui_clear(0x1234);
    ui_text(-7, -8, "Wide A!", UI_COL_RED);
    ui_text(232, 10, "AB", UI_COL_GREEN);
    ui_text(-13, 111, "g/W", UI_COL_FG);
    ui_text(28, 213, "Banded text", UI_COL_TEAL);
    ui_text(17, 83, "\xe4\xb8\xad", UI_COL_FG);
    ui_digits(-6, 14, "8-2", UI_COL_YELLOW);
    ui_digits(220, 280, "90", UI_COL_RED);
}

esp_err_t esp_lcd_panel_draw_bitmap(esp_lcd_panel_handle_t panel,
                                   int x0, int y0, int x1, int y1, const void *data)
{
    assert(panel == (void *)1 && x0 >= 0 && x1 <= UI_W && x0 < x1);
    assert(y0 >= 0 && y1 <= UI_H && y0 < y1 && y1 - y0 <= 4);
    const uint16_t *pixels = data;
    if (compare_pixels)
        for (int y = y0; y < y1; y++)
            for (int x = x0; x < x1; x++) {
                uint16_t actual = *pixels++;
                actual = (uint16_t)((actual << 8) | (actual >> 8));
                assert(actual == expected[y][x]);
            }
    stripe_calls++;
    return ESP_OK;
}

int main(void)
{
    assert(sizeof s_buf == 3840); // Same fixed two DMA buffers.
    assert(ui_init((void *)1) == ESP_OK);
    reference_scene();
    ui_render((ui_rect_t){0, 0, UI_W, UI_H}, paint_scene, NULL);
    const uint64_t scene_visits = bitmap_visits;
    assert(scene_visits > 1000 && scene_visits < 40000);
    // The complete text/digit bitmap must not be scanned again on all 80 bands.
    ui_render((ui_rect_t){9, 7, 37, 1}, paint_scene, NULL);
    ui_render((ui_rect_t){-3, -5, 20, 19}, paint_scene, NULL);
    ui_render((ui_rect_t){0, 109, 13, 8}, paint_scene, NULL);
    ui_render((ui_rect_t){217, 277, 100, 100}, paint_scene, NULL);
    // Truncated, invalid and unknown UTF-8 stay inside their terminator under
    // ASan, even when early rejection skips rendering on some bands.
    const char truncated_two[] = {(char)0xc2, 0};
    const char truncated_three[] = {(char)0xe4, (char)0xb8, 0};
    assert(ui_text_width(truncated_two) == 8);
    assert(ui_text_width(truncated_three) == 16);
    assert(ui_text_width("\xe2\x98\x83") == 8);
    assert(ui_text_width("\xf0\x9f\x98\x80") == 32);
    cp_status_view_t view = {0};
    strcpy(view.authentication, "AUTHENTICATED");
    strcpy(view.collection, "collecting");
    compare_pixels = false;
    bitmap_visits = 0;
    unsigned before = stripe_calls;
    status_page_render(&view);
    assert(stripe_calls - before == 80);
    assert(bitmap_visits > 10000 && bitmap_visits < 120000);
    printf("Raster pixel identity: PASS; bitmap visits scene=%llu dashboard=%llu, DMA=3840B\n",
           (unsigned long long)scene_visits, (unsigned long long)bitmap_visits);
    return 0;
}
