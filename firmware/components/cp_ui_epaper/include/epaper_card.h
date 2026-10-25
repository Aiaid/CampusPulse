#pragma once
#include "esp_err.h"
#include <stdbool.h>

/* Semantic fields only; the panel geometry and refresh policy stay internal. */
typedef struct {
    const char *title;
    const char *node;
    const char *board;
    const char *network;
    const char *authentication;
    const char *policy;
    const char *collection;
    bool setup_active;
    const char *setup_state;
    const char *setup_code;
    bool has_window, has_last_ack, stale;
    unsigned long window_reports, window_identifiers;
    int rssi_min, rssi_max;
    const char *last_ack; /* HH:MM local, or "--:--" */
} epaper_card_t;

esp_err_t epaper_card_init(void);
bool epaper_card_ready(void);
/* Full refresh of the 200x200 panel. Blocks for roughly three seconds. */
esp_err_t epaper_card_show(const epaper_card_t *card);
