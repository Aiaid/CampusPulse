#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "esp_err.h"

/* The caller must stop the writer and unmount storage before prepare, then
 * serialize all export calls. No names or captured bytes are logged here.
 * Indices remain stable until close; a changed file length is rejected. */
esp_err_t raw_export_prepare(void);
size_t raw_export_count(void);
bool raw_export_truncated(void);
esp_err_t raw_export_size(unsigned index, uint32_t *size);
esp_err_t raw_export_find(const char *path, unsigned *index);
/* cap <= 512. offset == size returns ESP_OK and zero bytes; offset > size
 * is invalid. A short read, including zero, is a normal EOF. */
esp_err_t raw_export_read(unsigned index, uint32_t offset, uint8_t *data,
                          size_t cap, size_t *length);
/* Idempotent; retries a failed unmount on a subsequent call. */
esp_err_t raw_export_close(void);
/* IEEE CRC-32, compatible with zlib.crc32(data). */
uint32_t raw_export_crc32(const void *data, size_t length);
