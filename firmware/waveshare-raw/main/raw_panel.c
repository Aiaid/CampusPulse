#include "raw_panel.h"

/* Partial waveform from Waveshare epd1in54_V2.cpp, pinned revision
 * d28b3c4cfc78eef1c6cd6e6e3013654e449d2864. Permission notice:
 * firmware/waveshare-raw/licenses/Waveshare-ePaper-MIT.txt. */
static const uint8_t partial_lut[159] = {
    [1] = 0x40, [12] = 0x80, [13] = 0x80, [24] = 0x40, [25] = 0x40,
    [37] = 0x80, [60] = 0x0f, [67] = 0x01, [68] = 0x01,
    [144] = 0x22, [145] = 0x22, [146] = 0x22, [147] = 0x22,
    [148] = 0x22, [149] = 0x22, [153] = 0x02, [154] = 0x17,
    [155] = 0x41, [156] = 0xb0, [157] = 0x32, [158] = 0x28,
};

enum { PANEL_INVALID = -1, WAIT_SHORT = 2000, WAIT_REFRESH = 10000 };

static bool valid_io(const raw_panel_io_t *io) {
    return io && io->command && io->data && io->wait_idle && io->reset &&
           io->power && io->delay_ms;
}
static int command(const raw_panel_io_t *io, uint8_t cmd) {
    return io->command(io->context, cmd);
}
static int reg(const raw_panel_io_t *io, uint8_t cmd, const uint8_t *data, size_t n) {
    int err = command(io, cmd);
    return err ? err : io->data(io->context, data, n);
}
static int reg1(const raw_panel_io_t *io, uint8_t cmd, uint8_t value) {
    return reg(io, cmd, &value, 1);
}
static int trigger(const raw_panel_io_t *io, uint8_t value, uint32_t timeout) {
    int err = reg1(io, 0x22, value);
    if (!err) err = command(io, 0x20);
    return err ? err : io->wait_idle(io->context, timeout);
}
static int pointer(const raw_panel_io_t *io, uint8_t x, uint8_t y) {
    const uint8_t row[] = {y, 0};
    int err = reg1(io, 0x4e, x);
    return err ? err : reg(io, 0x4f, row, sizeof row);
}
static int window(const raw_panel_io_t *io, uint8_t x0, uint8_t x1,
                  uint8_t y0, uint8_t y1) {
    const uint8_t x[] = {x0, x1}, y[] = {y0, 0, y1, 0};
    int err = reg1(io, 0x11, 0x03);
    if (!err) err = reg(io, 0x44, x, sizeof x);
    if (!err) err = reg(io, 0x45, y, sizeof y);
    return err ? err : pointer(io, x0, y0);
}

int raw_panel_full(const raw_panel_io_t *io, const uint8_t frame[5000]) {
    if (!valid_io(io) || !frame) return PANEL_INVALID;
    io->power(io->context, true);
    io->delay_ms(io->context, 10);
    io->reset(io->context);
    int err = io->wait_idle(io->context, WAIT_SHORT);
    if (!err) err = command(io, 0x12);
    if (!err) err = io->wait_idle(io->context, WAIT_SHORT);
    const uint8_t driver[] = {0xc7, 0, 0};
    if (!err) err = reg(io, 0x01, driver, sizeof driver);
    if (!err) err = reg1(io, 0x3c, 0x05);
    if (!err) err = reg1(io, 0x18, 0x80);
    if (!err) err = window(io, 0, 24, 0, 199);
    if (!err) err = trigger(io, 0xe0, WAIT_SHORT);
    if (!err) err = reg(io, 0x26, frame, RAW_REFRESH_FRAME_BYTES);
    if (!err) err = pointer(io, 0, 0);
    if (!err) err = reg(io, 0x24, frame, RAW_REFRESH_FRAME_BYTES);
    if (!err) err = trigger(io, 0xf7, WAIT_REFRESH);
    return err;
}

int raw_panel_partial(const raw_panel_io_t *io, const uint8_t frame[5000], const raw_refresh_plan_t *plan) {
    if (!valid_io(io) || !frame || !plan || plan->mode != RAW_REFRESH_PARTIAL ||
        plan->x0 > plan->x1 || plan->x1 >= RAW_REFRESH_ROW_BYTES ||
        plan->y0 > plan->y1 || plan->y1 >= RAW_REFRESH_HEIGHT) return PANEL_INVALID;
    io->reset(io->context);
    int err = io->wait_idle(io->context, WAIT_SHORT);
    if (!err) err = reg(io, 0x32, partial_lut, 153);
    if (!err) err = io->wait_idle(io->context, WAIT_SHORT);
    if (!err) err = reg(io, 0x3f, partial_lut + 153, 1);
    if (!err) err = reg(io, 0x03, partial_lut + 154, 1);
    if (!err) err = reg(io, 0x04, partial_lut + 155, 3);
    if (!err) err = reg(io, 0x2c, partial_lut + 158, 1);
    const uint8_t pingpong[] = {0, 0, 0, 0, 0, 0x40, 0, 0, 0, 0};
    if (!err) err = reg(io, 0x37, pingpong, sizeof pingpong);
    if (!err) err = reg1(io, 0x3c, 0x80);
    if (!err) err = trigger(io, 0xc0, WAIT_SHORT);
    if (!err) err = window(io, plan->x0, plan->x1, plan->y0, plan->y1);
    if (!err) err = command(io, 0x24);
    size_t width = (size_t)plan->x1 - plan->x0 + 1;
    for (unsigned y = plan->y0; !err && y <= plan->y1; ++y)
        err = io->data(io->context, frame + y * RAW_REFRESH_ROW_BYTES + plan->x0, width);
    if (!err) err = trigger(io, 0xcf, WAIT_REFRESH);
    return err;
}

int raw_panel_off(const raw_panel_io_t *io) {
    if (!valid_io(io)) return PANEL_INVALID;
    int err = trigger(io, 0x83, WAIT_SHORT);
    io->power(io->context, false);
    return err;
}
