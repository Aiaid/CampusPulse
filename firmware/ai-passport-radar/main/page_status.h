#pragma once
#include <stdbool.h>
#include "cp_debug.h"

// Board-independent, bounded display snapshot. The runtime provides all values;
// this renderer never queries services or enables collection. Text is ASCII.
typedef struct {
    char node_id[32];
    char board[24];
    char network[24];
    char authentication[24];
    char policy[24];
    char collection[24];
    int battery_percent; // -1 = unavailable; 0..100 otherwise
    bool setup_active;
    char setup_state[24];
    cp_debug_snapshot_t debug;
    cp_device_page_t page;
} cp_status_view_t;

// Call only from the board adapter's sole UI owner, after ui_init().
// The caller retains ownership; snapshot must stay immutable until return.
// Long text is truncated to fit; no BSP, task, allocation or service ownership.
void status_page_render(const cp_status_view_t *snapshot);
// Exact fitted-text/pixel-geometry damage comparison; previous must describe
// the currently displayed view. NULL previous, page/setup transitions paint all.
// Unchanged projections submit no SPI stripes. No retained cache or allocation.
void status_page_render_diff(const cp_status_view_t *next,
                             const cp_status_view_t *previous);
