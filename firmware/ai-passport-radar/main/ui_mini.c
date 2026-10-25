// ui_mini.c —— 实现见 ui_mini.h。
//
// 字节序（集成时第一个要验证的点）：
//   ST7789 在 SPI 上按"高字节先发"收 RGB565，而 esp_lcd_panel_draw_bitmap
//   原样发内存字节序（C3 是小端，低字节先出去）。LVGL 路径是端口层开了
//   swap_bytes 帮换的，直绘必须自己换。所以写缓冲的一律过 pxswap()。
//   如果上屏后红蓝互换/颜色全错，把 UI_SWAP_BYTES 改成 0 再试一次即可定位。
//
// 双缓冲（撕裂的来源与修法）：
//   IDF 的 esp_lcd_panel_io_spi 对颜色数据只 queue 不等待（DMA 还在发就返回），
//   单缓冲时下一带的 paint 会在上一带的 DMA 读取期间覆盖同一块 buf——横条纹、
//   串带。这里 A/B 两块缓冲乒乓：画第 N+1 带时 DMA 读的是另一块；
//   而 draw_bitmap 发命令前会等所有在途事务排空（IDF 源码原话 "before issue a
//   polling transaction, need to wait queued transactions finished"），所以轮到
//   第 N+2 带复用第一块时，它的传输保证已经结束。不用回调、不用信号量。
#include "ui_mini.h"
#include "font_zh.h"
#include "font_digit.h"

#include "esp_attr.h"
#include "esp_lcd_panel_ops.h"
#include <string.h>

#define UI_SWAP_BYTES 1

#define BAND_LINES 16

static esp_lcd_panel_handle_t s_panel;
static DMA_ATTR uint16_t s_buf[2][UI_W * BAND_LINES];   // 2x7.5KB，全库唯一的 RAM
static uint8_t s_cur;

// 当前带：图元按全局坐标画，落进 [s_rx0,s_rx1) x [s_ry0,s_ry0+s_lines) 才生效。
static int16_t s_rx0, s_ry0, s_rw, s_lines;

static inline uint16_t pxswap(uint16_t c)
{
#if UI_SWAP_BYTES
    return (uint16_t)((c << 8) | (c >> 8));
#else
    return c;
#endif
}

static inline void put(int x, int y, uint16_t c)
{
    if (x < s_rx0 || x >= s_rx0 + s_rw || y < s_ry0 || y >= s_ry0 + s_lines) return;
    s_buf[s_cur][(y - s_ry0) * s_rw + (x - s_rx0)] = pxswap(c);
}

esp_err_t ui_init(esp_lcd_panel_handle_t panel)
{
    if (!panel) return ESP_ERR_INVALID_ARG;
    s_panel = panel;
    return ESP_OK;
}

void ui_render(ui_rect_t region, ui_paint_fn paint, void *user)
{
    if (!s_panel || !paint) return;
    // 裁剪到屏幕内
    if (region.x < 0) { region.w += region.x; region.x = 0; }
    if (region.y < 0) { region.h += region.y; region.y = 0; }
    if (region.x + region.w > UI_W) region.w = UI_W - region.x;
    if (region.y + region.h > UI_H) region.h = UI_H - region.y;
    if (region.w <= 0 || region.h <= 0) return;

    s_rx0 = region.x;
    s_rw  = region.w;
    s_cur = 0;
    for (int y = region.y; y < region.y + region.h; y += BAND_LINES) {
        s_ry0   = (int16_t)y;
        s_lines = (int16_t)((region.y + region.h - y < BAND_LINES)
                            ? (region.y + region.h - y) : BAND_LINES);
        paint(user);
        esp_lcd_panel_draw_bitmap(s_panel, region.x, y,
                                  region.x + region.w, y + s_lines, s_buf[s_cur]);
        s_cur ^= 1;
    }
}

void ui_clear(uint16_t color)
{
    const uint16_t c = pxswap(color);
    for (int i = 0; i < s_rw * s_lines; i++) s_buf[s_cur][i] = c;
}

void ui_fill(int x, int y, int w, int h, uint16_t color)
{
    // 只保留与当前带的交集，避免逐点判裁剪
    int x0 = x < s_rx0 ? s_rx0 : x;
    int x1 = x + w > s_rx0 + s_rw ? s_rx0 + s_rw : x + w;
    int y0 = y < s_ry0 ? s_ry0 : y;
    int y1 = y + h > s_ry0 + s_lines ? s_ry0 + s_lines : y + h;
    if (x0 >= x1 || y0 >= y1) return;
    const uint16_t c = pxswap(color);
    for (int yy = y0; yy < y1; yy++) {
        uint16_t *row = &s_buf[s_cur][(yy - s_ry0) * s_rw + (x0 - s_rx0)];
        for (int xx = x0; xx < x1; xx++) *row++ = c;
    }
}

// ---- UTF-8 解码（界面文案只需要到 U+FFFF）----

static uint32_t utf8_next(const char **pp)
{
    const uint8_t *p = (const uint8_t *)(*pp);
    uint32_t cp;
    if (p[0] < 0x80)            { cp = p[0];                 *pp += 1; }
    else if ((p[0] & 0xE0) == 0xC0) { cp = ((p[0] & 0x1F) << 6) |
                                           (p[1] & 0x3F);      *pp += 2; }
    else if ((p[0] & 0xF0) == 0xE0) { cp = ((p[0] & 0x0F) << 12) |
                                           ((p[1] & 0x3F) << 6) |
                                           (p[2] & 0x3F);      *pp += 3; }
    else                        { cp = 0xFFFD;               *pp += 1; }
    return cp;
}

// 画一个字腔：只画有墨像素（背景像素跳过，右侧留白可被下一字压进）。
// 字腔尺寸由 font_zh.h 的 FONT_ZH_CELL 决定（改字号只需重跑 gen_font.ps1）。
static void glyph_cell(int x, int y, const uint8_t *bm, uint16_t color)
{
    for (int row = 0; row < FONT_ZH_CELL; row++) {
        for (int col = 0; col < FONT_ZH_CELL; col++) {
            if ((bm[row * FONT_ZH_ROW_BYTES + col / 8] >> (7 - col % 8)) & 1) {
                put(x + col, y + row, color);
            }
        }
    }
}

// 缺字占位：空心框。出现它 = gen_font.ps1 的字符表漏字，去加字重跑。
static void glyph_missing(int x, int y, uint16_t color)
{
    const int s = FONT_ZH_CELL - 2;
    for (int i = 0; i < s; i++) {
        put(x + 1 + i, y + 1, color);
        put(x + 1 + i, y + s, color);
        put(x + 1, y + 1 + i, color);
        put(x + s, y + 1 + i, color);
    }
}

void ui_text(int x, int y, const char *utf8, uint16_t color)
{
    while (*utf8) {
        const uint32_t cp = utf8_next(&utf8);
        uint8_t adv = 8;
        const uint8_t *bm = font_zh_glyph(cp, &adv);
        if (bm) glyph_cell(x, y, bm, color); else glyph_missing(x, y, color);
        x += adv;
    }
}

int ui_text_width(const char *utf8)
{
    int w = 0;
    while (*utf8) {
        const uint32_t cp = utf8_next(&utf8);
        uint8_t adv = 8;
        (void)font_zh_glyph(cp, &adv);
        w += adv;
    }
    return w;
}

// ---- 60px 大数字 ----

#define DIGIT_GAP 4

void ui_digits(int x, int y, const char *s, uint16_t color)
{
    while (*s) {
        const uint8_t *bm;
        uint8_t w;
        if (!font_digit_glyph(*s, &bm, &w)) { s++; continue; }
        const int row_bytes = (w + 7) / 8;
        for (int row = 0; row < FONT_DIGIT_H; row++) {
            for (int col = 0; col < w; col++) {
                if ((bm[row * row_bytes + col / 8] >> (7 - col % 8)) & 1) {
                    put(x + col, y + row, color);
                }
            }
        }
        x += w + DIGIT_GAP;
        s++;
    }
}

int ui_digits_width(const char *s)
{
    int w = 0;
    for (const char *p = s; *p; p++) {
        const uint8_t *bm;
        uint8_t gw;
        if (font_digit_glyph(*p, &bm, &gw)) w += gw + DIGIT_GAP;
    }
    return w > 0 ? w - DIGIT_GAP : 0;
}
