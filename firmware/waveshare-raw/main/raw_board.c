#include "raw_board.h"

#include <errno.h>
#include <fcntl.h>
#include <stdbool.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>
#include "driver/sdmmc_host.h"
#include "esp_vfs_fat.h"
#include "sdmmc_cmd.h"

/* Waveshare V2 04_SD_Card: CLK=39, CMD=41, D0=40, 1-bit.
 * The example does not configure a power hold; GPIO18 is a PWR button. */
#define MOUNT_POINT "/sdcard"
#define RAW_DIR MOUNT_POINT "/cpraw"
static sdmmc_card_t *s_card;
static FILE *s_file;
static char s_write_buffer[4096];
static esp_err_t s_failure;
static char s_path[sizeof(RAW_DIR) + 1 + 32 + 1 + 8 + 4 + 1];

static esp_err_t io_error(void) {
    return errno == ENOSPC ? RAW_STORAGE_ERR_FULL : ESP_FAIL;
}

esp_err_t raw_storage_mount(void) {
    if (s_card) goto ensure_directory;
    sdmmc_host_t host = SDMMC_HOST_DEFAULT();
    host.max_freq_khz = SDMMC_FREQ_DEFAULT;
    sdmmc_slot_config_t slot = SDMMC_SLOT_CONFIG_DEFAULT();
    slot.width = 1;
    slot.clk = GPIO_NUM_39;
    slot.cmd = GPIO_NUM_41;
    slot.d0 = GPIO_NUM_40;
    const esp_vfs_fat_sdmmc_mount_config_t cfg = {
        .format_if_mount_failed = false, .max_files = 5,
    };
    esp_err_t err = esp_vfs_fat_sdmmc_mount(MOUNT_POINT, &host, &slot, &cfg, &s_card);
    if (err != ESP_OK) { s_card = NULL; return err; }
ensure_directory:;
    struct stat st;
    if (mkdir(RAW_DIR, 0775) != 0 && errno != EEXIST) return ESP_FAIL;
    if (stat(RAW_DIR, &st) != 0 || !S_ISDIR(st.st_mode)) return ESP_FAIL;
    return ESP_OK;
}

esp_err_t raw_storage_open(const uint8_t session[16]) {
    if (!session) return ESP_ERR_INVALID_ARG;
    if (!s_card || s_file) return ESP_ERR_INVALID_STATE;
    char hex[33];
    for (size_t i = 0; i < 16; ++i) snprintf(hex + i * 2, 3, "%02x", session[i]);
    int fd = -1;
    char candidate[sizeof(s_path)];
    /* Segment number is allocated by exclusive creation, including after reboot. */
    for (unsigned segment = 0; segment < 100000000; ++segment) {
        snprintf(candidate, sizeof(candidate), RAW_DIR "/%s-%08u.bin", hex, segment);
        fd = open(candidate, O_WRONLY | O_CREAT | O_EXCL, 0664);
        if (fd >= 0) break;
        if (errno != EEXIST) return io_error();
    }
    if (fd < 0) return ESP_FAIL;
    s_file = fdopen(fd, "wb");
    if (!s_file) { esp_err_t err = io_error(); close(fd); return err; }
    if (setvbuf(s_file, s_write_buffer, _IOFBF, sizeof s_write_buffer) != 0) {
        (void)fclose(s_file);
        s_file = NULL;
        return ESP_FAIL;
    }
    memcpy(s_path, candidate, strlen(candidate) + 1);
    s_failure = ESP_OK;
    return ESP_OK;
}

esp_err_t raw_storage_write(const void *data, size_t len) {
    if (!s_file) return ESP_ERR_INVALID_STATE;
    if (!data && len) return ESP_ERR_INVALID_ARG;
    if (s_failure != ESP_OK) return s_failure;
    errno = 0;
    if (len && fwrite(data, 1, len, s_file) != len) {
        s_failure = io_error();
        return s_failure;
    }
    return ESP_OK;
}

esp_err_t raw_storage_sync(void) {
    if (!s_file) return ESP_ERR_INVALID_STATE;
    if (s_failure != ESP_OK) return s_failure;
    errno = 0;
    if (fflush(s_file) != 0 || fsync(fileno(s_file)) != 0) {
        s_failure = io_error();
        return s_failure;
    }
    return ESP_OK;
}

esp_err_t raw_storage_finish(void) {
    if (!s_file) return s_failure;
    esp_err_t result = raw_storage_sync();
    errno = 0;
    if (fclose(s_file) != 0 && result == ESP_OK) result = io_error();
    s_file = NULL;
    s_failure = result;
    return result;
}

void raw_storage_close(void) { (void)raw_storage_finish(); }

esp_err_t raw_storage_unmount(void) {
    if (s_file) return ESP_ERR_INVALID_STATE;
    if (!s_card) return ESP_OK;
    esp_err_t err = esp_vfs_fat_sdcard_unmount(MOUNT_POINT, s_card);
    if (err == ESP_OK) s_card = NULL;
    return err;
}

esp_err_t raw_storage_space(uint64_t *free_bytes) {
    uint64_t total;
    return raw_storage_capacity(&total, free_bytes);
}

esp_err_t raw_storage_capacity(uint64_t *total_bytes, uint64_t *free_bytes) {
    if (!free_bytes || !total_bytes) return ESP_ERR_INVALID_ARG;
    if (!s_card) return ESP_ERR_INVALID_STATE;
    return esp_vfs_fat_info(MOUNT_POINT, total_bytes, free_bytes);
}

uint64_t raw_storage_free_bytes(void) {
    uint64_t free_bytes = 0;
    (void)raw_storage_space(&free_bytes);
    return free_bytes;
}

const char *raw_storage_path(void) { return s_path; }

uint64_t raw_storage_card_bytes(void) {
    if (!s_card || s_card->csd.sector_size <= 0) return 0;
    return (uint64_t)s_card->csd.capacity * (uint64_t)s_card->csd.sector_size;
}

void *raw_storage_card_handle(void) { return s_card; }
