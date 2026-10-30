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
    bool wifi_rssi_known, heap_known, queue_known, upload_known, upload_in_flight;
    int wifi_rssi_dbm;
    unsigned long heap_free, heap_total, queue_pending, queue_capacity;
    unsigned long reports_total, aggregation_drops, summary_drops, raw_drops;
    unsigned long upload_age_seconds, upload_failures;
    const char *upload_state;
} epaper_card_t;

esp_err_t epaper_card_init(void);
bool epaper_card_ready(void);
/* Full refresh of the 200x200 panel. Blocks for roughly three seconds. */
esp_err_t epaper_card_show(const epaper_card_t *card);
