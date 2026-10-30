#pragma once
#include <stddef.h>
#include <stdint.h>
#include "esp_err.h"

/* Distinguishes a full volume from other storage failures. */
#define RAW_STORAGE_ERR_FULL ((esp_err_t)0x7101)

esp_err_t raw_storage_mount(void);
esp_err_t raw_storage_open(const uint8_t session[16]);
esp_err_t raw_storage_write(const void *data, size_t len);
esp_err_t raw_storage_sync(void);
esp_err_t raw_storage_finish(void);
void raw_storage_close(void);
esp_err_t raw_storage_unmount(void);
esp_err_t raw_storage_space(uint64_t *free_bytes);
esp_err_t raw_storage_capacity(uint64_t *total_bytes, uint64_t *free_bytes);
uint64_t raw_storage_free_bytes(void);
const char *raw_storage_path(void);
uint64_t raw_storage_card_bytes(void);
/* Borrowed mounted SDMMC handle for the trial queue's serialized media check.
 * Invalid after unmount; caller must not own/mutate the card or mount twice. */
void *raw_storage_card_handle(void);
