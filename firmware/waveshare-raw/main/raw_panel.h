#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "raw_refresh.h"

typedef struct {
    void *context;
    int (*command)(void *context, uint8_t command);
    int (*data)(void *context, const uint8_t *data, size_t length);
    int (*wait_idle)(void *context, uint32_t timeout_ms);
    void (*reset)(void *context);
    void (*power)(void *context, bool on);
    void (*delay_ms)(void *context, uint32_t delay_ms);
} raw_panel_io_t;

int raw_panel_full(const raw_panel_io_t *io, const uint8_t frame[5000]);
int raw_panel_partial(const raw_panel_io_t *io, const uint8_t frame[5000], const raw_refresh_plan_t *plan);
int raw_panel_off(const raw_panel_io_t *io);
