#pragma once
#include <stdbool.h>

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
    bool setup_active,setup_softap;
    char setup_name[32],setup_proof[33],setup_password[33],setup_state[24];
} cp_status_view_t;

// Call only from the board adapter's sole UI owner, after ui_init().
// The caller retains ownership; snapshot must stay immutable until return.
// Long text is truncated to fit; no BSP, task, allocation or service ownership.
void status_page_render(const cp_status_view_t *snapshot);
